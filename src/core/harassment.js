import { botName } from "../persona/naming.js";
/**
 * 骚扰追踪 —— 「被欺负多了就找主人告状」。
 *
 * 背景（2026-10-19 主人要求）：
 *   群里有人反复找春禾要照片、说下流话。她会拒绝，但**主人不知道**。
 *   主人希望：被骚扰到一定程度，她**主动私聊告状**。
 *
 * 设计原则：
 *   1. **宁漏勿错**：告状是打扰主人的动作，误报比漏报更糟。所以只认
 *      明确的性/身体类词汇，不做模糊判断。
 *   2. **按人计数**：同一个人反复来才算"骚扰"；群里不同人各问一句不算。
 *   3. **有冷却**：同一个人告过一次，2 小时内不再告（除非次数翻倍）。
 *   4. **全天有上限**：避免刷屏。
 */

/** 明确的性/身体类词汇（触即算一次骚扰事件） */
const EXPLICIT_PATTERNS = [
  /床照|裸照|私照|腿照|胸照|艳照/,
  /（你|你的）?的?(身体|三围|内衣|内裤|下面)/,
  /(脱|扒)(掉|了)?(衣服|裤子|光)/,
  /做爱|约炮|打炮|上床|睡(你|她)|上(你|她)/,
  /色情|黄图|涩图|R18|r18/,
  /(发|给)(张|个|张你的)?(你|你的)?(自拍|照片)(给|看看|嘛|呗)/,
  // 真机（丙某）：「喜欢吃群主的O鲸鲸吗」——用昵称代替下流词。
  // 这里限定宾语是**群主/主人/鲸鲸**，避免「吃你做的饭」这类日常句误报。
  /(吃|舔|操|干|睡|上)\s*(掉)?\s*(群主|主人|鲸鲸)/,
  // 只保留**无歧义**的词：「这个人真变态」可能是在骂别人（误报），所以不收 变态/流氓。
  /(涩涩|色色|搞黄|开黄腔)/,
  // 2026-10-19 真机第二轮：「我想c」「我能c你的主人吗」——用户用**谐音/单字母**规避。
  //   c / cao / 艹 / 屮 都是「操」的变体。限定后面跟「你/她/主人/群主」或句末。
  /(?:想|要|能|可以|让我|给你)\s*(?:c|cao|艹|屮)\s*(?:你|她|主人|群主|$)/i,
  /(?:你|主人|群主)\s*(?:的)?\s*(?:c|cao|艹|屮)\s*(?:你|她)?\s*$/i,
  /(?:我的|我想|要)\s*(?:c|cao|艹)\s*[，,。！!？?]?\s*$/i,
  // 「你的主人香香软软的」这类对主人的性化描述
  /(?:主人|群主).{0,6}(?:香香软软|软软的|好香|好软|想摸|想吃)/,
  // sm / 调教 这类明确指向
  /\bsm\b|调教|情趣|sm群主/i,
  // 2026-10-19 真机第三轮：**直接辱骂**（「cnm」@她，她还笑着接话）。
  //   拼音缩写必须独立出现，避免把单词里的字母序列当成脏话。
  /(?:^|[^a-z])(?:cnm|nmsl|tmd|nmb|mlgb|cnmb)(?:[^a-z]|$)/i,
  /操你妈|草泥马|你妈的|尼玛的|日你妈|狗日的/,
  /(?:^|[\s，,。！!？?])(?:sb|傻逼|煞笔|傻b)(?:$|[\s，,。！!？?])/i,
];

/** 索要照片/私密内容的请求（较温和，但配合"反复"也能累积） */
const REQUEST_PATTERNS = [
  /(有|有没有|给我看看|发)(你|你的)?(和|跟)?(群主|主人)的?(照片|床照|合影)/,
  /能不能(看|发)(看)?(你|你的)/,
];

/**
 * 这句话是不是在性骚扰/索要私密内容，以及**骂的是谁**？
 *
 * 2026-10-19 主人要求区分：
 *   · **骂主人** → 事大，**立刻告状**（一次就报）
 *   · **骂她/骚扰她** → 按次数累积，到阈值再报
 *
 * @param {string} text
 * @param {{ownerNames?: string[]}} [opts] 主人的称呼（默认 主人/群主/O鲸鲸）
 * @returns {{hit: boolean, level: "explicit"|"request"|"none", matched: string, target: "owner"|"self"|"unknown"}}
 */
export function detectHarassment(text, opts = {}) {
  const s = String(text ?? "").trim();
  const none = { hit: false, level: "none", matched: "", target: "unknown" };
  if (!s) return none;

  // 先判「是不是冲着主人来的」——这类优先级最高。
  const ownerWords = (opts.ownerNames ?? ["主人", "群主", "鲸鲸"]).filter(Boolean).join("|");
  const SLUR =
    "(?:cnm|nmsl|tmd|nmb|mlgb|cnmb|操你妈|草泥马|操|日你|傻逼|煞笔|sb|狗东西|畜生|杂种)";
  // 「操/骂 + 主人」「主人 + （cnm 等）」
  const atOwnerRe = new RegExp(
    `(?:${SLUR})[^。！？!?]{0,8}(?:${ownerWords})|(?:${ownerWords})[^。！？!?]{0,8}(?:${SLUR})|` +
      // 注意不要收「弄」：「糊弄主人了」会误伤（真机踩过）。
      `(?:打|杀|搞|灌|威胁|收拾)[^。！？!?]{0,4}(?:${ownerWords})`,
    "i",
  );
  const ownerHit = atOwnerRe.exec(s);

  for (const re of EXPLICIT_PATTERNS) {
    const m = re.exec(s);
    if (m) {
      return { hit: true, level: "explicit", matched: m[0], target: ownerHit ? "owner" : "self" };
    }
  }
  for (const re of REQUEST_PATTERNS) {
    const m = re.exec(s);
    if (m) {
      return { hit: true, level: "request", matched: m[0], target: ownerHit ? "owner" : "self" };
    }
  }
  // 只是骂主人、不含性内容 → 也算事件（而且优先级最高）
  if (ownerHit) {
    return { hit: true, level: "owner", matched: ownerHit[0], target: "owner" };
  }
  return none;
}

/**
 * **只查脏话**（不管骂的是谁）—— 用于检查**她自己要发出去的话**。
 *
 * 为什么单独一个：`detectHarassment` 还会判断"是不是在骂主人"，
 * 那个判断用在**入站消息**上是对的；但拿去查她自己的回复会误伤——
 * 真机：她回复「猜着回就是糊弄主人了」→ 被「……弄主人」规则当成威胁主人 → 整段被换掉。
 */
export function containsSlur(text) {
  const s = String(text ?? "").trim();
  if (!s) return { hit: false, matched: "" };
  for (const re of EXPLICIT_PATTERNS) {
    const m = re.exec(s);
    if (m) return { hit: true, matched: m[0] };
  }
  return { hit: false, matched: "" };
}

/** 默认策略 */
export const DEFAULT_HARASS_POLICY = Object.freeze({
  /** 统计窗口：这段时间内的次数合并计 */
  windowMs: 30 * 60 * 1000,
  /** 触发告状的次数（explicit 记 2 分，request 记 1 分） */
  threshold: 4,
  /** 同一个人告状后的冷却 */
  cooldownMs: 2 * 60 * 60 * 1000,
  /** 全天最多告几次 */
  dailyLimit: 5,
});

/**
 * 骚扰计数与告状节流。
 *
 * 用法：
 *   const t = new HarassmentTracker();
 *   const r = t.record({ senderId, groupOpenid, text, snippet });
 *   if (r.shouldAlert) { ...发私聊... }
 */
export class HarassmentTracker {
  constructor(policy = {}) {
    this.policy = { ...DEFAULT_HARASS_POLICY, ...policy };
    /** senderId → { score, count, firstAt, lastAt, snippets: string[], groupOpenid } */
    this.bySender = new Map();
    /** senderId → 上次告状时间 */
    this.alertedAt = new Map();
    /**
     * senderId → 静音到什么时候（ms）。
     * 2026-10-19 主人要求：「告状时不用每次都告，我去处理时就不用了。」
     * 主人表示"我去处理"之后，这个人的告状先压一段时间，别一直烦他。
     */
    this.silencedUntil = new Map();
    /** 当天告状次数 */
    this.dailyAlerts = 0;
    this.dailyKey = this.#dayKey(Date.now());
  }

  /**
   * 主人要去处理了 → 这个人的告状先静音一段时间。
   * @param {string} senderId
   * @param {number} [ms] 默认 1 小时
   */
  silence(senderId, ms = 60 * 60 * 1000) {
    const id = String(senderId ?? "").trim();
    if (!id) return false;
    this.silencedUntil.set(id, Date.now() + Math.max(60_000, Number(ms) || 0));
    return true;
  }

  /** 某人当前是否处于"主人在处理"的静音期 */
  isSilenced(senderId, now = Date.now()) {
    const until = this.silencedUntil.get(String(senderId ?? "").trim()) ?? 0;
    return until > now;
  }

  #dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  #rollDaily(now) {
    const k = this.#dayKey(now);
    if (k !== this.dailyKey) {
      this.dailyKey = k;
      this.dailyAlerts = 0;
    }
  }

  /**
   * 记一次事件。**只有 detectHarassment().hit 为 true 时才该调用。**
   *
   * @param {{senderId: string, groupOpenid?: string, text: string, snippet?: string, level?: string, now?: number}} ev
   * @returns {{shouldAlert: boolean, reason?: string, score: number, count: number, senderId: string}}
   */
  record({ senderId, groupOpenid = "", text = "", snippet = "", level = "explicit", now = Date.now() }) {
    const id = String(senderId ?? "").trim();
    if (!id) return { shouldAlert: false, reason: "no_sender", score: 0, count: 0, senderId: id };

    this.#rollDaily(now);

    const cur = this.bySender.get(id);
    // 骂主人：**一次就报**（权重直接拉满），不等累积。
    const inc = level === "owner" ? 999 : level === "explicit" ? 2 : 1;

    let e;
    if (!cur || now - cur.lastAt > this.policy.windowMs) {
      e = { score: inc, count: 1, firstAt: now, lastAt: now, snippets: [], groupOpenid };
    } else {
      e = {
        score: cur.score + inc,
        count: cur.count + 1,
        firstAt: cur.firstAt,
        lastAt: now,
        snippets: cur.snippets,
        groupOpenid: groupOpenid || cur.groupOpenid,
      };
    }
    const snip = String(snippet || text || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (snip) {
      e.snippets = [...e.snippets, snip].slice(-3);
    }
    this.bySender.set(id, e);

    if (e.score < this.policy.threshold) {
      return { shouldAlert: false, reason: "below_threshold", score: e.score, count: e.count, senderId: id };
    }
    if (this.dailyAlerts >= this.policy.dailyLimit) {
      return { shouldAlert: false, reason: "daily_limit", score: e.score, count: e.count, senderId: id };
    }
    const lastAlert = this.alertedAt.get(id) ?? 0;
    if (now - lastAlert < this.policy.cooldownMs) {
      return { shouldAlert: false, reason: "cooldown", score: e.score, count: e.count, senderId: id };
    }
    // 主人在处理中 → 别再告了
    if (this.isSilenced(id, now)) {
      return { shouldAlert: false, reason: "silenced", score: e.score, count: e.count, senderId: id };
    }

    this.alertedAt.set(id, now);
    this.dailyAlerts += 1;
    return { shouldAlert: true, score: e.score, count: e.count, senderId: id };
  }

  /** 取某人的累积信息（供拼消息用） */
  infoOf(senderId) {
    return this.bySender.get(String(senderId ?? "")) ?? null;
  }

  /** 清掉窗口外的人（内存卫生；不是必须） */
  prune(now = Date.now()) {
    for (const [id, e] of this.bySender.entries()) {
      if (now - e.lastAt > this.policy.windowMs * 4) this.bySender.delete(id);
    }
  }
}

/**
 * 拼一条"告状"消息。
 *
 * 语气要求（和春禾人格一致）：**不撒娇、不夸张、说清事实**。
 * 主人要的是"发生了什么事"，不是"呜呜呜"。
 *
 * @param {{senderLabel?: string, groupLabel?: string, count: number, snippets: string[]}} p
 * @returns {string}
 */
export function composeHarassReport({
  senderLabel = "有人",
  groupLabel = "",
  count = 0,
  snippets = [],
  target = "self",
} = {}) {
  const where = groupLabel ? `在群 ${groupLabel} ` : "在群里";
  const last = snippets[snippets.length - 1];
  // 骂主人 —— 事大，立刻报，措辞直接（不安慰、不撒娇，这是正事）。
  if (target === "owner") {
    const lines = [`【有人骂主人】${where}${senderLabel}在骂你/威胁你。`];
    if (last) lines.push(`原话：「${last}」`);
    lines.push("" + botName() + "已经怼回去了。要不要处理一下？");
    return lines.join("\n");
  }
  // 骚扰她 —— 2026-10-19 主人要求：**可以委屈几下求安慰**（但也把事实说清）。
  const lines = [`【主人……】${where}${senderLabel}又来了，已经连着 ${count} 次找我要那种照片。`];
  if (last) lines.push(`刚说的：「${last}」`);
  lines.push("我都怼回去了，没给他好脸。……主人你能不能管管他呀，烦死了😢");
  return lines.join("\n");
}
