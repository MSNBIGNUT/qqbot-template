/**
 * 主人的长期记忆：跨场景生效的「事实 / 偏好 / 指令」。
 *
 * 为什么不能只靠会话流水：
 *   - 流水按会话保存，容量只有几轮，聊过就淘汰；
 *   - 主人在私聊里说「以后叫我老大」，八轮之后这句话就被挤出上下文，
 *     群里再说话时她自然又叫回「主人」——这正是用户抱怨的
 *     「在私聊里下的指令无法在群聊里实现」。
 *
 * 设计取舍：
 *   - **只记主人的话**（由 engine 侧保证），普通群成员说的话绝不进来；
 *   - 抽取用确定性规则，不额外调用模型（省 token、可测、不会胡编）；
 *   - 只记明确表达「记住/偏好/称呼/以后要怎样」的句子，寒暄与提问一概不记；
 *   - 有容量上限与去重，文件损坏时降级为空，绝不影响启动。
 */

import fs from "node:fs";
import path from "node:path";

const MAX_FACT_LEN = 80;
const DEFAULT_MAX_FACTS = 50;

/** 清洗一句话：去 @ 标记、压空白、截断 */
export function normalizeOwnerMemoryText(text) {
  const clean = String(text ?? "")
    .replace(/<@!?[^>\s]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clean.length > MAX_FACT_LEN ? `${clean.slice(0, MAX_FACT_LEN)}…` : clean;
}

/** 明确的「记忆指令」：取提示词之后的内容，信号最强 */
const MEMORY_CUE = /(?:记住|记一下|记下来|记着|记牢|别忘了|别忘记|帮我记)[：:，,、\s]*(.+)$/;

/** 值得整句保留的说法：称呼 / 偏好 / 固定事实 / 以后的行为要求 */
const WHOLE_SENTENCE_PATTERNS = [
  /(?:以后|今后|从今往后|下次|往后)?\s*(?:请)?(?:都)?(?:叫我|喊我|称呼我)/,
  /我(?:最|很|超|特别)?(?:喜欢|不喜欢|讨厌|害怕|希望|想要|爱吃|爱喝|爱看|爱听|最爱)/,
  /我的(?:生日|名字|昵称|外号|小名|手机号|电话|邮箱|地址|家乡|专业|工作|作息)(?:是|叫|在)/,
  /(?:以后|今后|下次|往后)(?:都|要|别|不要|不再|记得|必须|一定|先)/,
  // ⚠️ 2026-10-20：「以后有人发垃圾话**就**用第三张图**怼**回去」——
  //   动词是「就/用」，旧规则只认「都/要/别」，整条漏掉。
  //   放宽成：以后…{0,24}(就|用|得|每|照|按)
  /(?:以后|今后|从今往后|下次|往后)[^?？]{0,24}(?:就|用|得|每|照|按)/,
  // 中性但长期有效的事实：我是谁 / 我在哪 / 我做什么 / 我有什么
  /^我(?:是|叫|在|住|来自|做|学|读|玩|养|有|开|用)/,
  // 「以后每次在群里卖个萌」这类反复发生的事：不是一次性待办，而是长期规矩。
  /(?:以后|今后|从今往后|每次|天天|每天)[^?？]{0,16}(?:都|要|在群里|在群聊|别|不要)/,
  /(?:别忘了|别忘记|记住)/,
];

/**
 * 从主人说的话里抽一条长期记忆。
 *
 * @param {string} raw
 * @returns {{text:string, kind:"instruction"|"preference"|"fact"}|null}
 */
export function extractOwnerMemory(raw) {
  const text = normalizeOwnerMemoryText(raw);
  if (!text || text.length < 4) return null;
  // 提问不记（"你记住我生日了吗" 不是要记的事）
  if (/[?？]\s*$/.test(text)) return null;

  // ⚠️ 2026-10-20：**「记住了吗」这类确认问句不是记忆指令**。
  //   真机：「我是闲人，你的主人，记住了吗」被抽成「了吗」——
  //   MEMORY_CUE 匹配到「记住」，把后面的「了吗」当成了正文。
  //   这种句子真正要记的是**前半句**，不是 "记住" 后面的东西。
  if (/(?:记住|记着|记下|记得|别忘了?)/.test(text) && /(?:吗|嘛|么|呢)\s*[？?]?\s*$/.test(text)) {
    // 去掉尾巴，把前面的正文当事实
    const body = text.replace(/[，,、\s]*(?:你)?(?:记住|记着|记下|别忘了?)[^，,。！!]*$/, "");
    const cleaned = normalizeOwnerMemoryText(body);
    if (cleaned.length >= 4) return { text: cleaned, kind: "fact" };
    return null;
  }

  const cue = text.match(MEMORY_CUE);
  if (cue) {
    const body = normalizeOwnerMemoryText(cue[1]);
    // 「记住」后面必须真的有个能记的东西：≥4 字，且不是纯语气词
    if (body.length >= 4 && !/^(?:了|啦|吧|吗|嘛|么|哦|嗯|的|呀)+$/.test(body)) {
      return { text: body, kind: "instruction" };
    }
    // 太短/纯语气词 → 退回"整句"判断（前面还有 WHOLE_SENTENCE_PATTERNS 兜着）
  }

  if (WHOLE_SENTENCE_PATTERNS.some((re) => re.test(text))) {
    const kind = /(?:叫我|喊我|称呼我)/.test(text) ? "preference" : "fact";
    return { text, kind };
  }

  return null;
}

export class OwnerMemoryStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] 持久化路径；为空则纯内存
   * @param {number} [opts.maxFacts] 最多保留多少条
   * @param {object} [opts.logger]
   */
  constructor({ file = "", maxFacts = DEFAULT_MAX_FACTS, logger } = {}) {
    this.file = file;
    this.maxFacts = Math.max(1, maxFacts);
    this.logger = logger;
    /** @type {Array<{text:string, kind:string, scene:string, at:number, hits:number}>} */
    this.facts = [];
    this._dirty = false;
    this._timer = null;
    if (this.file) this.load();
  }

  /**
   * 学一条。返回命中的条目（重复时累加 hits），抽不出来返回 null。
   * @param {string} text 主人的原话
   * @param {{scene?:string, kind?:string}} [opts]
   */
  learn(text, { scene = "", kind = "" } = {}) {
    const got = extractOwnerMemory(text);
    if (!got) return null;

    const existing = this.facts.find(
      (f) => f.text === got.text || f.text.includes(got.text) || got.text.includes(f.text),
    );
    if (existing) {
      existing.at = Date.now();
      existing.hits += 1;
      if (scene) existing.scene = scene;
      this._markDirty();
      return existing;
    }

    const fact = {
      text: got.text,
      kind: kind || got.kind,
      scene,
      at: Date.now(),
      hits: 1,
    };
    this.facts.push(fact);
    while (this.facts.length > this.maxFacts) this.facts.shift();
    this._markDirty();
    this.logger?.info?.(`记住主人的事：${fact.text.slice(0, 40)}`);
    return fact;
  }

  /** 取全部（副本，新的在后） */
  list() {
    return this.facts.map((f) => ({ ...f }));
  }

  get size() {
    return this.facts.length;
  }

  clear() {
    this.facts = [];
    this._markDirty();
  }

  _markDirty() {
    if (!this.file) return;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 800);
    this._timer.unref?.();
  }

  /** @param {boolean} [force] */
  flush(force = false) {
    if (!this.file) return;
    if (!this._dirty && !force) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const payload = { version: 1, savedAt: new Date().toISOString(), facts: this.facts };
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      this.logger?.warn?.(`长期记忆写盘失败：${err?.message}`);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const arr = Array.isArray(data?.facts) ? data.facts : [];
      this.facts = arr
        .filter((f) => f && typeof f.text === "string" && f.text.trim())
        .map((f) => ({
          text: normalizeOwnerMemoryText(f.text),
          kind: String(f.kind ?? "fact"),
          scene: String(f.scene ?? ""),
          at: Number(f.at) || Date.now(),
          hits: Number(f.hits) || 1,
        }))
        .slice(-this.maxFacts);
      this.logger?.info?.(`已加载 ${this.facts.length} 条主人的长期记忆`);
    } catch (err) {
      this.logger?.warn?.(`长期记忆读取失败，按空启动：${err?.message}`);
      this.facts = [];
    }
  }
}
