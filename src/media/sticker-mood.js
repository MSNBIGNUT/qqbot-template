/**
 * 「多用表情包」：判断一句话适不适合用表情接，并管住频率。
 *
 * 为什么不是纯靠模型工具（send_sticker 已经存在）：
 *  - 真机证据（2026-10-17 22:22）：同一句「看看你卖萌的样子」，
 *    模型有时调工具、有时只回文字——表情包是引擎确定性就能做到的事，
 *    不该整轮交给模型掷骰子；
 *  - 但纯确定性也不行：一句「我有点难过」如果机械地甩张开心图，比不发更糟。
 *
 * 所以这里是**窄而安全的兜底**：只认几种一眼能判断的轻松场景（打招呼/被夸/
 * 大笑/道谢/晚安/被骚扰），并且有硬性的冷却阈值；其余场合仍由模型自己决定
 * 要不要调 send_sticker。严肃/技术/情绪低落的一律不自动发。
 */

import { stickerNamesOf } from "./stickers.js";

/** 自动补表情的冷却：发完一张后，至少再聊 3 轮才允许下一张 */
export const AUTO_STICKER_COOLDOWN_TURNS = 3;
/** 每个会话每小时最多自动补几张（兜底，防止长时间聊天里一直发） */
export const AUTO_STICKER_MAX_PER_HOUR = 10;

/** 技术、工作、情绪低落、正经事——这些场合不自动发表情 */
const SERIOUS_PATTERNS = [
  /代码|报错|错误|异常|bug|error|函数|程序|服务器|配置|部署|安装|接口|数据库|算法|测试|编译|脚本|命令|路径|文件|接口/i,
  /数学|物理|公式|推导|证明|论文|作业|考试|面试|开会|项目|截止|deadline|工作|老板|领导/i,
  /难过|伤心|哭|去世|死|生病|住院|医院|分手|失恋|吵架|崩溃|焦虑|抑郁|压力|自杀|疼|难受/i,
  /帮我|帮忙|教我|解释一下|分析一下|写一个|改一下|看一下|看看这|怎么做|怎么办|为什么|如何|能不能|可不可以|是不是/i,
  // 2026-10-19：加了弱关联通路后，「这道题怎么算」也会被判成闲聊 → 自动补表情，
  // 这在做题时很烦。这里把「题的语境」补进严肃场景（注意用「道题/题目/求解」这种
  // 强语境词，不要单收一个「题」，否则「没问题」会被误伤）。
  /(?:这|那|一)?道题|题目|解题|求解|怎么算|算出|答案是|打草稿|推导一下/i,
];

/**
 * 这些是在「让春禾做事」而不是闲聊：唱歌/语音/画图/提醒/文件/远程控制。
 * 做事时再补一张表情只会显得没在听，而且会和语音/歌曲回复抢发送顺序。
 */
const ACTION_REQUEST_RE =
  /(?:用语音|发语音|语音说|说句|念一?句|唱|点歌|画一?个|画张|画幅|生成(?:一)?[张幅个]|提醒我|待办|远程|启动|关闭|重启|打开|设置|安装|下载|发文件|存图|存下来|表情包)/;

const MOOD_RULES = [
  {
    mood: "speechless",
    // 被骚扰/被冒犯：甩个「无语」比解释有用。放在最前面，避免被后面的规则抢走
    re: /骚扰|变态|色狼|下流|恶心|滚|无语|离谱|服了|翻白眼|发张裸照|床照|想c\b|我能c/i,
    keywords: ["无语", "白眼", "叉腰", "叹气", "生气", "盯", "斜眼"],
    // 主人教过挡箭牌图的话，优先用那张还击
    taughtFirst: true,
  },
  {
    mood: "greeting",
    re: /^(?:嗨+|hi|hello|哈喽|你好(?:呀|啊|哦)?|在吗|在不在|在么|在嘛|早上好|早安|早|晚上好|晚上|哟)[呀啊哦嗯~～\s!！?？。…]*$/i,
    keywords: ["挥手", "卖萌", "比耶", "开心", "嗨"],
    fallback: "开心",
  },
  {
    mood: "praise",
    re: /好可爱|真可爱|可爱|真棒|好棒|厉害|强啊|牛啊|喜欢你|爱你|最好了|好乖|真乖|好看|漂亮|聪明|温柔/i,
    keywords: ["捂脸", "点赞", "害羞", "摸头", "比心", "开心"],
    fallback: "害羞",
  },
  {
    mood: "laugh",
    // 注意：「草」只认单独一个，不然「樱花草」这种歌名会被当成大笑
    re: /哈哈+|笑死|笑不活|绷不住|乐死|hhh|233|^草+$/i,
    keywords: ["鼓掌", "大笑", "卖萌", "比耶", "开心", "得意"],
    fallback: "开心",
  },
  {
    mood: "thanks",
    re: /谢谢|多谢|感谢|thx|thanks/i,
    keywords: ["谢谢", "敬礼", "开心"],
    fallback: "谢谢",
  },
  {
    mood: "cheer",
    re: /加油|冲冲冲|你可以的|别放弃|振作|打起精神/i,
    keywords: ["加油", "星星眼"],
    fallback: "加油",
  },
  {
    mood: "night",
    re: /晚安|睡了|睡觉|困了|好困/i,
    keywords: ["打哈欠", "拜拜", "困了", "晚安", "害羞"],
    fallback: "困了",
  },
  {
    mood: "shock",
    re: /震惊|真的假的|卧槽|我去|不会吧|天哪|离谱/i,
    keywords: ["震惊", "吃瓜", "疑问"],
    fallback: "震惊",
  },
  {
    mood: "miss",
    re: /想你|想你了|抱抱|亲亲/i,
    keywords: ["抱抱", "比心", "摸头", "害羞", "卖萌"],
    fallback: "比心",
  },
];

/** 一眼能判断的严肃场合（技术/工作/情绪低落/明确求助） */
export function isSeriousScene(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) return false;
  // 长文本多半在讲正经事；闲聊很少超过 40 字
  if (text.length > 60) return true;
  return SERIOUS_PATTERNS.some((re) => re.test(text));
}

/**
 * 识别适合发表情的轻松场景。
 *
 * @param {string} rawText
 * @param {{kind?: string}} [opts]
 * @returns {{mood: string, keywords: string[], fallback: string}|null}
 */
export function detectStickerMood(rawText, opts = {}) {
  const text = String(rawText ?? "").trim();
  if (!text) return null;
  if (opts.kind && opts.kind !== "text") return null;
  // 一句特别长的话不当成寒暄/玩笑
  if (text.length > 40) return null;
  if (isSeriousScene(text)) return null;
  // 「用语音说句晚安」「唱首樱花草」是任务指令，不是闲聊
  if (ACTION_REQUEST_RE.test(text)) return null;

  for (const rule of MOOD_RULES) {
    if (rule.re.test(text)) {
      return {
        mood: rule.mood,
        keywords: rule.keywords,
        fallback: rule.fallback,
        // 2026-10-19：透传「主人教的挡箭牌优先」标记（被骚扰时用主人给的图还击）
        ...(rule.taughtFirst ? { taughtFirst: true } : {}),
      };
    }
  }

  // ⭐ 2026-10-19 主人要求：「触发条件能不需要关键词吗，或者弱关联，让她试着学着怎么用表情」。
  //
  // 原来必须命中某条正则才发（「嗨」「谢谢」「哈哈哈」…），说法一变就发不出来，
  // 而且她永远学不会"什么时候该发表情"——决定权在正则手里，不在她手里。
  //
  // 现在补一条**弱关联**通路：
  //   · 已经过了上面三道闸（不是长文、不是严肃场景、不是任务指令）→ 这就是闲聊；
  //   · 闲聊里**不再要求命中关键词**，直接给一个轻量 mood；
  //   · 具体发哪张由好感度 + 轮转决定（高好感萌系、低好感冷系）；
  //   · 频率仍由 stickerBudget 控制（3 轮 / 每小时 10 张），不会刷屏。
  //
  // 关键词因此从"**必须命中才发**"降级为"**命中时发得更准**"。
  if (opts.weak === false) return null;
  return { mood: "casual", keywords: [], lightScene: true };
}

/**
 * 从素材库里为这个场景挑一张。
 *
 * 优先「春禾-」自己的脸；场景关键词命中就发对应的那张，
 * 命中不了用该场景的安全兜底（例如打招呼 → 开心），仍没有就返回 ""。
 *
 * @param {Array<{name:string}>} stickers
 * @param {{keywords?: string[], fallback?: string}|null} mood
 * @returns {string}
 */
/**
 * 高好感度时优先用的「萌系」表情词（2026-10-19 主人要求：
 * 「好感度高的多用萌萌的表情回应」）。
 * 只在这些词**命中 mood 的候选池**时生效，不会硬塞不相关的表情。
 */
export const CUTE_WORDS = [
  // 语义专属的排前面（谢谢场景就发「谢谢」，别发「开心」）
  "谢谢",
  "加油",
  // 然后是真正"萌"的
  "比心",
  "卖萌",
  "撒娇",
  "星星眼",
  "害羞",
  "得意",
  "闪亮",
  "嘻嘻",
  "抱抱",
  "比耶",
  "挥手",
  "点赞",
  "鼓掌",
  "捂脸",
  "摸头",
  "大笑",
  "吃瓜",
  "开心",
];

/** 低好感度时优先用的「冷系」表情词 */
export const COLD_WORDS = ["无语", "生气", "盯", "斜眼", "你说是就是吧", "瞪眼"];

/** 弱关联选图的轮转游标（模块级，重启归零即可） */
let rotationCursor = 0;

export function pickStickerMoodName(stickers, mood, opts = {}) {
  const list = Array.isArray(stickers) ? stickers : [];
  if (!list.length || !mood) return "";
  // ⭐ 2026-10-19：**主人教的挡箭牌优先**（被骚扰这类场合）。
  //   真机反馈：「她并没有用我给的图片还击」——
  //   因为下面只在自己的「春禾-*」里挑，主人教的图名字不带前缀，永远进不了池子。
  //   现在：mood.taughtFirst 时，先把 taught 标记的图挑出来用。
  // ⚠️ 2026-10-19 修：挡箭牌只用于**真骚扰**场景。
  // 之前「无语了」这种轻度感叹也会掏出挡箭牌（那张图是主人教来对付要照片的人的），太夸张。
  // 现在要求 opts.harassment === true 才用。
  if (mood.taughtFirst && opts?.harassment === true) {
    const taught = list.filter((s) => s.taught && !s.name.startsWith("春禾-"));
    if (taught.length) {
      const byPurpose = taught.filter((s) => s.purpose === "harassment");
      const pick = (byPurpose.length ? byPurpose : taught)[0];
      // 同一批里轮着用，别每次都同一张（用文件名做轮转键，避免同义名重复计数）
      return pick.name;
    }
  }
  const own = list.filter((s) => s.name.startsWith("春禾-"));
  const pool = own.length ? own : list;

  /**
   * 弱关联：没命中任何关键词、但不是严肃场景 → 由**好感度 + 轮转**挑一张。
   * 这是「让她学着怎么用表情」的落点 —— 不再等关键词，先发出去、再看反应。
   */
  if (mood.lightScene) {
    const affinity = Number(opts?.affinity) || 0;
    const group =
      affinity >= 2
        ? CUTE_WORDS
        : affinity <= -2
          ? COLD_WORDS
          : [...CUTE_WORDS.slice(0, 8), ...COLD_WORDS.slice(0, 2)];
    const candidates = pool.filter((s) => group.some((w) => s.name.includes(w)));
    const finalPool = candidates.length ? candidates : pool;
    if (!finalPool.length) return "";
    // 轮转：每次 +1，避免一直发同一张
    rotationCursor = (rotationCursor + 1) % finalPool.length;
    return finalPool[rotationCursor].name;
  }

  /**
   * ⭐ 2026-10-19 主人要求：「好感度高的多用萌萌的表情回应」。
   *
   * 做法：**先按好感度给候选池加权**，再走原来的 mood 关键词匹配。
   *   · 高好感（≥ +2）：把萌系词排到前面，但不越过 mood 的语义——
   *     仍然只在「这个场景该发的表情」里挑，只是优先萌的。
   *   · 低好感（≤ −2）：优先冷系（无语/生气/盯/斜眼）。
   *   · 中性：完全按原逻辑。
   *
   * 这样「好感度高」不会让她在严肃场合突然卖萌（严肃场景在 detectStickerMood 就已排除）。
   */
  const affinity = Number(opts?.affinity) || 0;
  const bias = affinity >= 2 ? CUTE_WORDS : affinity <= -2 ? COLD_WORDS : [];
  if (bias.length) {
    // ① **按 bias 的优先级**在 mood 自己的关键词里挑：
    //    高好感时「卖萌/撒娇/比心」要排在「开心」前面 —— 主人要的是萌，不是普通高兴。
    //    仍然只在「这个场景该发的表情」范围内（要求命中 mood.keywords），不会跑题。
    const moodKws = mood.keywords ?? [];
    for (const want of bias) {
      const relevant = moodKws.some((kw) => kw.includes(want) || want.includes(kw));
      if (!relevant) continue;
      const hit =
        pool.find((s) => s.name === `春禾-${want}`) || pool.find((s) => s.name.includes(want));
      if (hit) return hit.name;
    }
    // ② mood 的关键词都没被 bias 照顾到 → 直接从 bias 里找一张存在的
    //    （仍然是她自己的表情，不会乱发别人的图）
    for (const want of bias) {
      const hit =
        pool.find((s) => s.name === `春禾-${want}`) || pool.find((s) => s.name.includes(want));
      if (hit) return hit.name;
    }
  }

  for (const kw of mood.keywords ?? []) {
    const hit =
      pool.find((s) => s.name === `春禾-${kw}`) ||
      pool.find((s) => s.name.includes(kw));
    if (hit) return hit.name;
  }
  if (mood.fallback) {
    const hit = pool.find((s) => s.name.includes(mood.fallback));
    if (hit) return hit.name;
  }
  return "";
}

/**
 * 频率闸门：每个会话（群里按整个群算）独立。
 *
 * - 刚发过一张后，要再经过 cooldownTurns 轮对话才允许下一张；
 * - 一小时内最多 maxPerHour 张；
 * - 初始状态允许发（不然第一句话永远发不出去）。
 *
 * 纯内存：重启即清零——表情包是氛围，不是账本，没必要落盘。
 */
export class StickerMoodBudget {
  constructor({ cooldownTurns = AUTO_STICKER_COOLDOWN_TURNS, maxPerHour = AUTO_STICKER_MAX_PER_HOUR, now = Date.now } = {}) {
    this.cooldownTurns = Math.max(0, Number(cooldownTurns) || 0);
    this.maxPerHour = Math.max(1, Number(maxPerHour) || 1);
    this.now = typeof now === "function" ? now : () => Number(now) || Date.now();
    /** key → { turns, sentAt: number[] } */
    this.sessions = new Map();
  }

  #state(key) {
    let s = this.sessions.get(key);
    if (!s) {
      // turns 从阈值起步：第一句话就允许发
      s = { turns: this.cooldownTurns, sentAt: [] };
      this.sessions.set(key, s);
    }
    return s;
  }

  /** 每处理一轮对话调用一次（不管发没发） */
  noteTurn(key) {
    this.#state(key).turns += 1;
  }

  /** 这一轮允许自动补一张吗 */
  canSend(key) {
    const s = this.#state(key);
    if (s.turns < this.cooldownTurns) return false;
    const cutoff = this.now() - 3600 * 1000;
    s.sentAt = s.sentAt.filter((t) => t > cutoff);
    return s.sentAt.length < this.maxPerHour;
  }

  /** 真的发了才记 */
  record(key) {
    const s = this.#state(key);
    s.turns = 0;
    s.sentAt.push(this.now());
  }
}

/** 仅供测试/诊断：文件名 → 别名列表（复用发送侧同一套解析） */
export function namesOfFile(file) {
  return stickerNamesOf(file);
}
