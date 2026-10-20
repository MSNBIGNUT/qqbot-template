/**
 * 会话记忆：保留最近若干轮对话，并可持久化到磁盘。
 *
 * 为什么需要持久化：内存版记忆在机器人重启后就清空，
 * 用户会立刻感觉到「它忘了我刚说过的话」——这是很伤的体验落差。
 *
 * 设计取舍：
 *  - 只存「用户说了什么 / 机器人答了什么」，不存任何平台标识以外的隐私字段；
 *  - 每个会话键最多保留 N 轮，超出即淘汰，避免文件无限增长；
 *  - 写入采用「先写临时文件再改名」，避免进程被杀时留下半个损坏的 JSON；
 *  - 读失败一律降级为空记忆，绝不让记忆问题导致机器人起不来。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 机器人对自己的**错误**自我否定的特征。
 *
 * 背景：机器人确实会收到历史对话（同会话甚至跨重启），但模型容易
 * 「顺着」自己以前说过的话继续否认自己，形成自我强化的错误。
 * 这些说法进入后续上下文会让错误一直复发，因此在这里过滤掉。
 */
const DENIAL_PATTERNS = [
  /没有跨会话(保存)?记忆/,
  /跨会话就不行/,
  /没有(跨会话)?记忆(能力)?/,
  /看不到之前的(聊天)?记录/,
  /看不到之前聊过/,
  /记不住哦/,
  /对.{0,6}来说都是全新的/,
  /换个新对话/,
  /跨会话就不/,
];

/**
 * 「凭空断定跨场景做不到」的特征。
 *
 * 真机事故（2026-10-17）：主人问「私聊里发的指令能在群聊实现吗」，
 * 她猜了一句「大概不行哦……私聊这边没法替你往群里转发消息」，
 * 这条回答还进了记忆，之后不断自我强化。
 *
 * 这和「否认记忆」是同一类错误：**她并没有查，只是在猜**。
 * 这里做确定性清理：既过滤送入模型的历史，也支持把已落盘的那条删掉。
 */
const MISLEADING_DENIAL_PATTERNS = [
  /大概不行[\s\S]{0,60}(?:私聊|群里|群聊|跨场景)/,
  /(?:私聊|群里|群聊|跨场景)[\s\S]{0,60}大概不行/,
  /私聊这边(?:没法|不能|没办法)(?:替你)?(?:往|向|在)?群/,
  /私聊这边(?:没法|不能|没办法)[\s\S]{0,20}群/,
  /没法[\s\S]{0,12}(?:传到|转发|发到|告诉|说给)[\s\S]{0,6}群/,
  /没法(?:替你)?(?:往|向|在)?群里(?:转发|发|做|实现)?/,
  /私聊里(?:说|下)的指令[\s\S]{0,50}只会[\s\S]{0,20}私聊/,
  // 真机 2026-10-17 21:03 新出现的说法：
  // 「私聊这边发出去的话只会落在私聊里，所以还得等主人在群里先开口」
  /私聊这边[\s\S]{0,24}(?:只会|只能)[\s\S]{0,12}私聊/,
  /(?:还得|要)等主人(?:先)?在群里(?:先)?开口/,
  // 更早的一条（12:45 真机）：「私聊里发起的待办，得等主人在群里开口之后…」
  /私聊里(?:发起|下|说)的[\s\S]{0,16}(?:得|要|还得)等主人[\s\S]{0,10}在群里[\s\S]{0,6}(?:开口|说话|说一句)/,
  /得等主人[\s\S]{0,10}在群里[\s\S]{0,6}(?:开口|说话)/,
  /私聊[\s\S]{0,16}(?:发出去|说的话)[\s\S]{0,12}(?:只会|只能)[\s\S]{0,8}私聊/,
  /群聊里(?:就)?(?:做不到|不行|没法)/,
  /跨场景[\s\S]{0,20}(?:做不到|不行|没法)/,
  // 曲库清单其实一查就有；「我看不到曲库」同样是没查就下结论。
  /看不到(?:完整的?|自己的?)?曲库(?:清单)?/,
];

DENIAL_PATTERNS.push(...MISLEADING_DENIAL_PATTERNS);

export { DENIAL_PATTERNS, MISLEADING_DENIAL_PATTERNS };

/**
 * 历史里的 AI 标识前缀。
 *
 * 背景：关掉标识后模型仍会自己加上 —— 因为它看到历史里自己的回复都带这个前缀，
 * 于是模仿。这和「否认记忆」一样属于上下文自我强化，靠提示词压不住。
 * 送模型前剥掉，新回复就不会再被"教会"乱加。
 *
 * 只剥开头，不动正文里正常提到 AI 的地方。
 */
const AI_LABEL_PREFIX = /^\s*【AI】\s*/;

export { AI_LABEL_PREFIX };

/**
 * 场景前缀：合并后的主人记忆里，每条消息都要能看出「这话是在哪说的」。
 *
 * 为什么必须有：私聊和群聊合并成一份记忆后，模型会把私聊里的话当成
 * 可以在群里随口说的内容。真实风险是主人的隐私被当众复述。
 * 标注 + 提示词里的安全阀（persona 层）一起用，才能既"记得住"又"说得体"。
 */
export const SCENE_LABELS = { c2c: "私聊", group: "群聊" };

/** 给一条记忆加上场景前缀 */
export function annotateEntry(entry) {
  const label = SCENE_LABELS[entry?.scene];
  if (!label) return entry;
  // ⚠️ 2026-10-19 修：**只标注用户的发言，不标注她自己说过的话**。
  //   真机故障：她的回复里总是莫名带上〔私聊〕/〔群聊〕前缀 ——
  //   因为历史里她自己的回复也被这样标了，模型照着模仿。
  //   场景标注的用途是"别把私聊内容拿去群聊说"，那只和**主人说了什么**有关；
  //   她自己在哪说的并不需要标（当前场景在提示词里另有说明）。
  if (entry?.role === "assistant") return entry;
  return { role: entry.role, content: `〔${label}〕${entry.content}`, scene: entry.scene };
}

/** 旧会话键（c2c:x / group:g:x）→ 主人统一键 owner:x 时的来源判定 */
export function legacyOwnerKeysOf(sessionKey, ownerId) {
  if (!ownerId) return false;
  if (sessionKey === `c2c:${ownerId}`) return true;
  return sessionKey.startsWith("group:") && sessionKey.split(":").pop() === ownerId;
}

export class MemoryStore {
  /**
   * @param {object} opts
   * @param {number} [opts.maxTurns] 每个会话保留的最大轮数（1 轮 = 一问一答）
   * @param {number} [opts.ownerMaxTurns] 主人统一会话单独放大的轮数（默认同 maxTurns）
   * @param {string} [opts.file] 持久化路径；为空则纯内存
   * @param {number} [opts.saveDebounceMs] 写盘去抖，避免每条消息都写盘
   * @param {object} [opts.logger]
   */
  constructor({
    maxTurns = 8,
    ownerMaxTurns = null,
    file = "",
    saveDebounceMs = 800,
    logger,
  } = {}) {
    this.maxTurns = Math.max(0, maxTurns);
    // 注意 ownerMaxTurns 默认 null：Number(null) === 0，不能直接判断，
    // 否则默认会把 owner 窗口压成 0 轮（只剩最后 2 条）。
    const own = ownerMaxTurns == null ? NaN : Number(ownerMaxTurns);
    this.ownerMaxTurns = Number.isFinite(own) && own >= 0 ? own : this.maxTurns;
    this.file = file;
    this.saveDebounceMs = Math.max(0, saveDebounceMs);
    this.logger = logger;

    /** @type {Map<string, Array<{role:string, content:string, scene?:string}>>} */
    this.sessions = new Map();
    /** 已做过「旧 owner 会话 → owner:<id>」合并的主人 id（幂等标记，随文件持久化） */
    this.ownerMerged = new Set();
    this._saveTimer = null;
    this._dirty = false;

    if (this.file) this.load();
  }

  /** 取某会话的历史（副本，避免外部改动内部状态） */
  get(sessionKey) {
    const arr = this.sessions.get(sessionKey);
    return arr ? arr.map((m) => ({ ...m })) : [];
  }

  /**
   * 取「喂给模型」的历史：过滤掉机器人自己那些错误的自我否定。
   *
   * 为什么必须过滤，而不是靠提示词：
   * 模型会**模仿自己历史里的话**。一旦它曾说过「我没有记忆能力」，
   * 这句话就会作为上下文不断自我强化，提示词很难压住。
   * 这里做确定性清理，保证错误说法不再进入后续上下文。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.annotate] 是否加〔私聊〕〔群聊〕来源标注
   * @param {number} [opts.maxChars] 字符预算（0=不限）；超出时从最旧的整轮开始丢
   */
  getForModel(sessionKey, { annotate = false, maxChars = 0 } = {}) {
    const cleaned = this.get(sessionKey)
      .filter((m) => !(m.role === "assistant" && DENIAL_PATTERNS.some((re) => re.test(m.content))))
      .map((m) =>
        m.role === "assistant" && AI_LABEL_PREFIX.test(m.content)
          ? { ...m, content: m.content.replace(AI_LABEL_PREFIX, "") }
          : m,
      );
    // 合并后的主人记忆：每条都标出「这话是在私聊还是群里说的」，
    // 提示词据此加安全阀，避免把私聊内容当众复述。
    const out = annotate ? cleaned.map(annotateEntry) : cleaned;
    if (!(Number(maxChars) > 0)) return out;

    // token 预算：按字符数封顶，超了就从最旧的**整轮**开始丢。
    // 保留最后两轮（再少就无法接上当前话题）——这是硬下限。
    let total = out.reduce((n, m) => n + String(m.content ?? "").length, 0);
    while (out.length > 4 && total > maxChars) {
      const removed = out.splice(0, 2);
      total -= removed.reduce((n, m) => n + String(m.content ?? "").length, 0);
    }
    return out;
  }

  /** 某个会话键最多保留多少条消息（owner 统一键单独放大） */
  #maxMessagesFor(sessionKey) {
    const turns = String(sessionKey).startsWith("owner:")
      ? this.ownerMaxTurns
      : this.maxTurns;
    return Math.max(2, turns * 2);
  }

  /**
   * 追加一轮对话，并触发去抖写盘。
   * @param {object} [meta] `{scene}`：仅主人统一会话需要，用于标注来源
   */
  append(sessionKey, userText, assistantText, meta = {}) {
    const arr = this.sessions.get(sessionKey) ?? [];
    const scene = meta?.scene && String(sessionKey).startsWith("owner:") ? meta.scene : "";
    const entry = (role, content) => (scene ? { role, content, scene } : { role, content });
    arr.push(entry("user", userText));
    arr.push(entry("assistant", assistantText));

    const maxMessages = this.#maxMessagesFor(sessionKey);
    while (arr.length > maxMessages) arr.shift();

    this.sessions.set(sessionKey, arr);
    this._scheduleSave();
  }

  /**
   * 把同一个主人散落在「私聊 + 各个群」里的旧会话合并到统一键 `owner:<id>`。
   *
   * 为什么必须做：修复上线前的历史全是按旧键存的（实测同一个人被切成 4 份）。
   * 不迁移的话，用户重启后翻不到之前的私聊内容，会认为「修了但没用」。
   *
   * 安全取舍：
   *  - 旧键**原样保留**作为归档（一条都不删，满足「14 个会话键不能丢数据」）；
   *  - 合并结果受轮数上限约束，私聊内容**放在最后**（最不容易被淘汰）——
   *    用户要的正是「私聊说过的话，群里能记得」；
   *  - 用持久化标记保证只合并一次，避免每次启动重复拼接。
   *
   * @param {Iterable<string>} ownerIds
   */
  migrateOwnerSessions(ownerIds) {
    const ids = [...(ownerIds ?? [])].filter(Boolean);
    if (!ids.length) return 0;

    let changed = 0;
    for (const id of ids) {
      const target = `owner:${id}`;
      const keys = [...this.sessions.keys()];
      const groupKeys = keys.filter(
        (k) => k.startsWith("group:") && k.split(":").pop() === id,
      );
      const c2cKey = keys.includes(`c2c:${id}`) ? `c2c:${id}` : null;

      // 已经合并过：跳过，避免历史翻倍。
      // （只有统一键**确实还在**时才跳过：万一文件被旧版本进程覆盖丢了统一键，
      //   这里要能重新合并出来，而不是永远空着。）
      if (this.ownerMerged.has(id) && this.sessions.has(target)) continue;
      if (!groupKeys.length && !c2cKey && !this.sessions.has(target)) continue;

      const merged = [];
      // 先放各群，再把私聊放最后（尾部最不容易被轮数上限淘汰）
      for (const key of groupKeys) {
        const scene = "group";
        for (const m of this.sessions.get(key) ?? []) merged.push({ role: m.role, content: m.content, scene });
      }
      if (c2cKey) {
        for (const m of this.sessions.get(c2cKey) ?? []) merged.push({ role: m.role, content: m.content, scene: "c2c" });
      }
      // 统一键里已有的（更新版本进程写过的）视为更新，接在后面
      for (const m of this.sessions.get(target) ?? []) merged.push({ ...m });

      const maxMessages = this.#maxMessagesFor(target);
      this.sessions.set(target, merged.slice(-maxMessages));
      this.ownerMerged.add(id);
      changed += 1;
      this.logger?.info?.(
        `记忆合并：主人 ${id.slice(0, 8)}… 的私聊/群聊会话已合并为 ${target}（旧会话保留为归档）`,
      );
    }

    if (changed) this.flush(true);
    return changed;
  }

  /**
   * 清理主人会话里「凭空断定跨场景做不到」的错误自述。
   *
   * 为什么必须动已落盘的历史，而不只是过滤：
   *   那条回答（「大概不行……私聊这边没法替你往群里转发消息」）会作为
   *   助手的历史被模型模仿，越聊越像真的。只过滤"送模型"还不够——
   *   文件里一直留着，换一条代码路径又会被读回来。这里直接删掉。
   *
   * 安全边界：
   *   - 只动主人自己的会话（owner:<id> / c2c:<id> / group:*:<id>）；
   *   - 只删 **assistant** 的消息，主人的原话一条不删；
   *   - 其他人的会话原样保留（不替别人改历史）。
   *
   * @param {Iterable<string>} ownerIds
   * @returns {number} 删除的条数
   */
  purgeMisleadingDenials(ownerIds) {
    const ids = [...(ownerIds ?? [])].map((x) => String(x ?? "").trim()).filter(Boolean);
    if (!ids.length) return 0;

    const ownerOfKey = (key) => {
      const k = String(key ?? "");
      if (k.startsWith("owner:")) {
        const id = k.slice("owner:".length);
        return ids.includes(id) ? id : "";
      }
      if (k.startsWith("c2c:")) {
        const id = k.slice("c2c:".length);
        return ids.includes(id) ? id : "";
      }
      if (k.startsWith("group:")) {
        const id = k.split(":").pop() ?? "";
        return ids.includes(id) ? id : "";
      }
      return "";
    };

    let removed = 0;
    for (const [key, arr] of [...this.sessions.entries()]) {
      if (!ownerOfKey(key)) continue;
      const kept = arr.filter(
        (m) =>
          !(
            m?.role === "assistant" &&
            MISLEADING_DENIAL_PATTERNS.some((re) => re.test(String(m.content ?? "")))
          ),
      );
      if (kept.length === arr.length) continue;
      removed += arr.length - kept.length;
      this.sessions.set(key, kept);
    }
    if (removed > 0) {
      this._scheduleSave();
      this.logger?.warn?.(
        `已清理 ${removed} 条「凭空断定做不到」的错误自述（只动主人会话，主人原话保留）`,
      );
    }
    return removed;
  }

  /** 清空某个会话（或全部） */
  clear(sessionKey) {
    if (sessionKey) this.sessions.delete(sessionKey);
    else this.sessions.clear();
    this._scheduleSave();
  }

  get size() {
    return this.sessions.size;
  }

  _scheduleSave() {
    if (!this.file) return;
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, this.saveDebounceMs);
    this._saveTimer.unref?.();
  }

  /** 立即写盘（进程退出前应调用）。force=true 时即使没有变更也写，确保最后一次对话不丢 */
  flush(force = false) {
    if (!this.file) return;
    if (!this._dirty && !force) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload = {
        // version 2：多了一个「主人跨场景合并」标记；老版本读到 version 2 也能照常读 sessions
        version: 2,
        savedAt: new Date().toISOString(),
        ownerMerged: [...this.ownerMerged],
        sessions: Object.fromEntries(this.sessions),
      };
      // 原子写：先写临时文件再改名，避免半截文件
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      this.logger?.warn?.(`记忆写盘失败：${err?.message}`);
    }
  }

  /** 从磁盘加载 */
  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, "utf8");
      const data = JSON.parse(raw);
      const sessions = data?.sessions ?? {};
      for (const id of Array.isArray(data?.ownerMerged) ? data.ownerMerged : []) {
        if (id) this.ownerMerged.add(String(id));
      }
      let loaded = 0;
      for (const [key, messages] of Object.entries(sessions)) {
        if (!Array.isArray(messages)) continue;
        const cleaned = messages
          .filter((m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
          .map((m) =>
            m.scene === "c2c" || m.scene === "group"
              ? { role: m.role, content: m.content, scene: m.scene }
              : { role: m.role, content: m.content },
          );
        if (cleaned.length) {
          this.sessions.set(key, cleaned.slice(-this.#maxMessagesFor(key)));
          loaded += 1;
        }
      }
      this.logger?.info?.(`已加载 ${loaded} 个会话记忆（${this.file}）`);
    } catch (err) {
      // 记忆坏了也不能影响启动
      this.logger?.warn?.(`记忆读取失败，按空记忆启动：${err?.message}`);
      this.sessions.clear();
    }
  }
}
