/**
 * 群注册表：春禾要知道「我在哪些群、每个群大概多大」。
 *
 * 为什么需要它：主人在私聊说「去大群/小群卖个萌」，或者只说「去群里」时，
 * 引擎必须能落到一个具体的 group_openid 上——QQ 的群消息里没有群名，
 * 只有 openid，凭名字选群是不可能的。
 *
 * 数据来源（按可信度排序）：
 *   1. `source:"api"` —— GET /v2/groups/{gid}/members 拿到的真实成员数。
 *      ⚠️ 2026-10-17 真机实测：该接口返回 HTTP 400 / bizCode 11253
 *      「应用无接口访问权限」，所以生产环境**大概率拿不到**；
 *   2. `source:"observed"` —— 从 memory.json 的 `group:<gid>:<uid>` 会话键
 *      统计「在这个群说过话的人数」。这**只是下限**：47 人的群实测只观察到
 *      8 位发言人（约 17%），所以必须如实标注 `lowerBound:true`，不能当真实人数。
 *
 * 分级阈值（都可配）：
 *   - API 真人数：`>= largeThreshold`（默认 10）= 大群；
 *   - observed 下限：`>= observedLargeThreshold`（默认 5）= 大群。
 *     为什么 observed 用 5 而不是 10：observed 系统性低估。真实样本里
 *     大群观察到 8 人、另两个群只有 2 人和 1 人，5 正好落在两者之间的天然断层上。
 *
 * 选择策略：
 *   - 点名「大群/小群」→ 在该档位里挑**最活跃**的群（发言最多），
 *     而不是挑人数最极端的那个——主人在哪个群聊得多，「群里」通常就指哪个；
 *   - 没点名 → `defaultPick`（默认 active，即最活跃的群；可配 small）。
 */

import fs from "node:fs";
import path from "node:path";

export const GROUP_SIZE = Object.freeze({ LARGE: "large", SMALL: "small" });
export const GROUP_SIZE_LABEL = Object.freeze({ large: "大群", small: "小群" });

const KEEP_MS = 180 * 24 * 3600 * 1000;
const MAX_GROUPS = 200;
const MAX_OBSERVED = 5000;

/** 只保留安全字符的群 id 展示（日志/回执里别刷屏） */
export function shortGroupId(groupOpenid) {
  const s = String(groupOpenid ?? "");
  if (!s) return "";
  return s.length <= 14 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * 纯函数：按可用数据判大小群。
 *
 * @param {object} opts
 * @param {number|null} [opts.memberCount] 接口拿到的真实成员数（拿不到传 null/0）
 * @param {number} [opts.observedCount] 见过的发言人数（下限）
 * @param {number} [opts.largeThreshold] API 真人数的大群阈值（默认 10）
 * @param {number} [opts.observedLargeThreshold] observed 下限的大群阈值（默认 5）
 * @returns {{sizeLabel:"large"|"small", source:"api"|"observed", confidence:string, effectiveCount:number, lowerBound:boolean, memberCount:number|null, observedCount:number}}
 */
export function classifyGroupSize({
  memberCount = null,
  observedCount = 0,
  largeThreshold = 10,
  observedLargeThreshold = 5,
} = {}) {
  const apiCount = Number(memberCount);
  const hasApi = Number.isFinite(apiCount) && apiCount > 0;
  const observed = Math.max(0, Math.floor(Number(observedCount) || 0));
  const threshold = Math.max(1, Number(largeThreshold) || 10);

  if (hasApi) {
    return {
      sizeLabel: apiCount >= threshold ? GROUP_SIZE.LARGE : GROUP_SIZE.SMALL,
      source: "api",
      confidence: "high",
      effectiveCount: apiCount,
      lowerBound: false,
      memberCount: apiCount,
      observedCount: observed,
    };
  }

  const observedThreshold = Math.max(1, Number(observedLargeThreshold) || 5);
  return {
    sizeLabel: observed >= observedThreshold ? GROUP_SIZE.LARGE : GROUP_SIZE.SMALL,
    source: "observed",
    confidence: "lower_bound",
    effectiveCount: observed,
    lowerBound: true,
    memberCount: null,
    observedCount: observed,
  };
}

/** 数据里的目标：`size:large` / `size:small` / `group:<id>` / any_group */
export function sizeLabelOfTarget(target) {
  const t = String(target ?? "");
  if (t === "size:large") return GROUP_SIZE.LARGE;
  if (t === "size:small") return GROUP_SIZE.SMALL;
  return "";
}

export class GroupRegistry {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] 持久化路径；为空则纯内存
   * @param {number} [opts.largeThreshold] API 真人数阈值（默认 10）
   * @param {number} [opts.observedLargeThreshold] observed 下限阈值（默认 5）
   * @param {"active"|"small"} [opts.defaultPick] 未点名时怎么选（默认 active）
   * @param {object} [opts.logger]
   * @param {() => number} [opts.now]
   */
  constructor({
    file = "",
    largeThreshold = 10,
    observedLargeThreshold = 5,
    defaultPick = "active",
    logger,
    now,
  } = {}) {
    this.file = file;
    this.largeThreshold = Math.max(1, Number(largeThreshold) || 10);
    this.observedLargeThreshold = Math.max(1, Number(observedLargeThreshold) || 5);
    this.defaultPick = defaultPick === "small" ? "small" : "active";
    this.logger = logger;
    this.now = now ?? (() => Date.now());

    /** @type {Map<string, {groupOpenid:string, memberCount:number|null, memberCountSource:string, memberCountAt:number, observedSenders:string[], messageCount:number, firstSeen:number, lastSeen:number}>} */
    this.groups = new Map();
    this._dirty = false;
    this._timer = null;
    if (this.file) this.load();
  }

  get size() {
    return this.groups.size;
  }

  #entry(groupOpenid, at = this.now()) {
    const gid = String(groupOpenid ?? "").trim();
    if (!gid) return null;
    let entry = this.groups.get(gid);
    if (!entry) {
      entry = {
        groupOpenid: gid,
        memberCount: null,
        memberCountSource: "",
        memberCountAt: 0,
        observedSenders: [],
        messageCount: 0,
        firstSeen: at,
        lastSeen: at,
      };
      this.groups.set(gid, entry);
    }
    return entry;
  }

  /**
   * 记一位「见过的发言人」。
   * 同一个人说多少句都只算 1 位——它衡量的是"群里有多少人露过面"。
   */
  observe({ groupOpenid, senderOpenid = "", at = this.now() } = {}) {
    const entry = this.#entry(groupOpenid, at);
    if (!entry) return null;
    const uid = String(senderOpenid ?? "").trim();
    if (uid && !entry.observedSenders.includes(uid)) {
      entry.observedSenders.push(uid);
      if (entry.observedSenders.length > MAX_OBSERVED) entry.observedSenders.shift();
    }
    entry.lastSeen = Math.max(entry.lastSeen, Number(at) || 0);
    this._prune();
    this._markDirty();
    return this.get(entry.groupOpenid);
  }

  /** 记这个群又聊了几句（选「最活跃的群」用） */
  addMessages(groupOpenid, count = 1, { at = this.now() } = {}) {
    const entry = this.groups.get(String(groupOpenid ?? "").trim());
    if (!entry) return null;
    const n = Math.max(0, Math.floor(Number(count) || 0));
    entry.messageCount += n;
    entry.lastSeen = Math.max(entry.lastSeen, Number(at) || 0);
    this._markDirty();
    return this.get(entry.groupOpenid);
  }

  /**
   * 写入真实成员数。**只接受正数**：
   * 接口失败/分页为空时返回 0 或 []，绝不能写成"这个群 0 人"。
   */
  setMemberCount(groupOpenid, memberCount, { source = "api", at = this.now() } = {}) {
    const n = Number(memberCount);
    if (!(Number.isFinite(n) && n > 0)) return null;
    const entry = this.#entry(groupOpenid, at);
    if (!entry) return null;
    entry.memberCount = Math.floor(n);
    entry.memberCountSource = source === "api" ? "api" : String(source || "api");
    entry.memberCountAt = Number(at) || this.now();
    entry.lastSeen = Math.max(entry.lastSeen, Number(at) || 0);
    this._markDirty();
    return this.get(entry.groupOpenid);
  }

  /**
   * 从 memory.json 的会话键播种：`group:<gid>:<uid>`。
   * 只读会话数据，不引入新的隐私面——这些键本来就在记忆文件里。
   */
  seedFromSessions(sessions) {
    const entries =
      sessions instanceof Map ? [...sessions.entries()] : Object.entries(sessions ?? {});
    /** gid → 记忆里能看到的发言条数（只是下限） */
    const seenCounts = new Map();
    let seeded = 0;
    for (const [key, messages] of entries) {
      if (typeof key !== "string" || !key.startsWith("group:")) continue;
      const parts = key.split(":");
      if (parts.length < 3) continue;
      const gid = parts[1];
      const uid = parts.slice(2).join(":");
      if (!gid) continue;
      // 记忆里可能混着 --mock 冒烟留下的假群（group-openid-1），
      // 它会把「你在哪些群」污染成 4 个。真实 group_openid 至少 16 位。
      if (gid.length < 16) continue;
      const entry = this.#entry(gid, 0);
      if (!entry) continue;
      if (uid && !entry.observedSenders.includes(uid)) entry.observedSenders.push(uid);
      const n = Array.isArray(messages) ? messages.length : 0;
      seenCounts.set(gid, (seenCounts.get(gid) ?? 0) + n);
      seeded += 1;
    }
    // 用 max 而不是 +：记忆窗口会被截断，反复重启不该把活跃度越加越大
    for (const [gid, n] of seenCounts.entries()) {
      const entry = this.groups.get(gid);
      if (entry) entry.messageCount = Math.max(entry.messageCount, n);
    }
    if (seeded > 0) this._markDirty();
    return seeded;
  }

  /** 分类后的单群视图（含 sizeLabel/source/lowerBound） */
  get(groupOpenid) {
    const entry = this.groups.get(String(groupOpenid ?? "").trim());
    if (!entry) return null;
    const size = classifyGroupSize({
      memberCount: entry.memberCount,
      observedCount: entry.observedSenders.length,
      largeThreshold: this.largeThreshold,
      observedLargeThreshold: this.observedLargeThreshold,
    });
    return {
      ...entry,
      observedSenders: [...entry.observedSenders],
      observedCount: entry.observedSenders.length,
      ...size,
      sizeText: GROUP_SIZE_LABEL[size.sizeLabel],
      shortId: shortGroupId(entry.groupOpenid),
    };
  }

  /** 全部群（按活跃度降序），供选择与注入上下文 */
  all() {
    return [...this.groups.keys()]
      .map((gid) => this.get(gid))
      .filter(Boolean)
      .sort((a, b) => b.messageCount - a.messageCount || b.lastSeen - a.lastSeen);
  }

  /**
   * 选一个具体群。
   * @param {{sizeLabel?: "large"|"small"|""}} [opts]
   * @returns {{ok:true, groupOpenid:string, entry:object, reason:string}|{ok:false, reason:string, sizeLabel:string}}
   */
  selectTarget({ sizeLabel = "" } = {}) {
    const label = sizeLabel === GROUP_SIZE.LARGE || sizeLabel === GROUP_SIZE.SMALL ? sizeLabel : "";
    let candidates = this.all();
    if (!candidates.length) {
      return { ok: false, reason: "no_known_group", sizeLabel: label };
    }
    if (label) {
      candidates = candidates.filter((g) => g.sizeLabel === label);
      if (!candidates.length) {
        return { ok: false, reason: label === GROUP_SIZE.LARGE ? "no_large_group" : "no_small_group", sizeLabel: label };
      }
    }

    const pick = label
      ? // 点名档位：挑这档里最活跃的（最熟的那个）
        (a, b) => b.messageCount - a.messageCount || b.lastSeen - a.lastSeen || a.effectiveCount - b.effectiveCount
      : this.defaultPick === "small"
        ? // 小群优先：人数越少越不打扰
          (a, b) => a.effectiveCount - b.effectiveCount || b.messageCount - a.messageCount
        : // 默认：最活跃的群就是主人嘴里的「群里」
          (a, b) => b.messageCount - a.messageCount || b.lastSeen - a.lastSeen || a.effectiveCount - b.effectiveCount;

    const sorted = [...candidates].sort(pick);
    const selected = sorted[0];
    return {
      ok: true,
      groupOpenid: selected.groupOpenid,
      entry: selected,
      reason: label ? `size_${label}` : `default_${this.defaultPick}`,
    };
  }

  /**
   * 给回执/提示词用的一句话描述。
   * 必须让主人一眼看出「发到哪个群、多大、这个人数可不可信」。
   */
  describe(entryOrGid) {
    const entry =
      typeof entryOrGid === "string" ? this.get(entryOrGid) : entryOrGid ?? null;
    if (!entry) return "";
    const size = entry.sizeText ?? GROUP_SIZE_LABEL[entry.sizeLabel] ?? "群";
    const evidence = entry.memberCount
      ? `${entry.memberCount} 人`
      : `至少 ${entry.observedCount} 位发言人说过话；成员数接口无权限，按下限估算`;
    return `${size} ${entry.shortId ?? shortGroupId(entry.groupOpenid)}（${evidence}）`;
  }

  /** 给模型看的群清单（只注入主人上下文） */
  listForModel() {
    return this.all().map((g) => ({
      groupOpenid: g.groupOpenid,
      shortId: g.shortId,
      sizeLabel: g.sizeLabel,
      sizeText: g.sizeText,
      source: g.source,
      confidence: g.confidence,
      memberCount: g.memberCount,
      observedCount: g.observedCount,
      lowerBound: g.lowerBound,
      messageCount: g.messageCount,
      lastSeen: g.lastSeen,
    }));
  }

  clear() {
    this.groups.clear();
    this._markDirty();
  }

  _prune() {
    if (this.groups.size <= MAX_GROUPS) return;
    const sorted = [...this.groups.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    while (this.groups.size > MAX_GROUPS) {
      const oldest = sorted.shift();
      if (!oldest) break;
      this.groups.delete(oldest.groupOpenid);
    }
  }

  _markDirty() {
    if (!this.file) return;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 300);
    this._timer.unref?.();
  }

  flush(force = false) {
    if (!this.file) return;
    if (!this._dirty && !force) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const groups = {};
      for (const [gid, e] of this.groups.entries()) groups[gid] = e;
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        largeThreshold: this.largeThreshold,
        observedLargeThreshold: this.observedLargeThreshold,
        groups,
      };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      this.logger?.warn?.(`群注册表写盘失败：${err?.message}`);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const now = this.now();
      for (const [gid, raw] of Object.entries(data?.groups ?? {})) {
        if (!gid || !raw || typeof raw !== "object") continue;
        // lastSeen=0 表示「从记忆播种、还没有实时时间戳」，不能当成过期删掉
        if (Number(raw.lastSeen ?? 0) > 0 && now - Number(raw.lastSeen) > KEEP_MS) continue;
        this.groups.set(gid, {
          groupOpenid: gid,
          memberCount:
            Number.isFinite(Number(raw.memberCount)) && Number(raw.memberCount) > 0
              ? Number(raw.memberCount)
              : null,
          memberCountSource: String(raw.memberCountSource ?? ""),
          memberCountAt: Number(raw.memberCountAt) || 0,
          observedSenders: Array.isArray(raw.observedSenders)
            ? raw.observedSenders.map(String).filter(Boolean).slice(0, MAX_OBSERVED)
            : [],
          messageCount: Math.max(0, Number(raw.messageCount) || 0),
          firstSeen: Number(raw.firstSeen) || 0,
          lastSeen: Number(raw.lastSeen) || 0,
        });
      }
      this.logger?.info?.(`已加载 ${this.groups.size} 个群（${this.file}）`);
    } catch (err) {
      this.logger?.warn?.(`群注册表读取失败，按空启动：${err?.message}`);
      this.groups.clear();
    }
  }
}
