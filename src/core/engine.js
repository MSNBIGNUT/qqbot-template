/**
 * 消息引擎：把「收到消息」到「回复消息」的全过程串起来。
 *
 * 处理顺序（顺序很重要）：
 *   1. 去重      —— QQ 会重推，先去重再花钱
 *   2. 场景过滤  —— 只支持单聊/群聊（频道与频道私信需要别的接口）
 *   3. 白名单    —— 非授权用户直接静默丢弃，避免额度被盗用
 *   4. 限流      —— 按用户限速
 *   5. 生成回复  —— 走人格层（本地规则或真实模型）
 *   6. 合规包装  —— 强制加 AI 明示标识（不可被配置移除）
 *   7. 发送      —— 被动回复带 msg_id
 */

import { nextMsgSeq, VOICE_FILE_TYPE, IMAGE_FILE_TYPE } from "../qq/api.js";
import path from "node:path";
import { DedupeCache, RateLimiter, AccessPolicy } from "./access.js";
import { MemoryStore } from "./memory.js";
import { OwnerMemoryStore } from "./owner-memory.js";
import {
  PendingActionStore,
  parsePendingInstruction,
  describePendingConfirmation,
  describeRecurringConfirmation,
  describeProactiveDelivery,
  PENDING_DELIVERY,
} from "./pending-actions.js";
import { GroupRegistry, sizeLabelOfTarget, shortGroupId } from "./groups.js";
import { ProactiveQuota } from "./proactive-quota.js";
import { HarassmentTracker, detectHarassment, containsSlur, composeHarassReport } from "./harassment.js";
import { NameRegistry, detectSelfIntro, detectNamingIntent } from "./names.js";
import { AffinityStore, detectKindness } from "./affinity.js";
import { GrowthBook, detectGrowthSignal, condenseLesson } from "./growth.js";
import { TopicStore, normalizeTopic } from "./topics.js";
import { splitReply, planGaps, matchWakeName } from "./chat-split.js";
import { ReminderStore, humanizeDelay } from "./reminders.js";
import { extractReminderMarkers, parseReminderRequest } from "./reminder-intent.js";
import {
  resolveTtsConfig,
  decideVoiceReply,
  synthesizeSilk,
  isVoiceCapabilityQuestion,
  describeVoiceCapabilityAnswer,
  MAX_QQ_VOICE_MS,
} from "../media/tts.js";
import { getRvcWorker } from "../media/rvc-worker.js";
import {
  STICKER_TOOL_NAME,
  resolveStickerConfig,
  listStickers,
  executeStickerCall,
  detectStickerRequest,
  pickStickerName,
} from "../media/stickers.js";
import { detectStickerSaveRequest, ingestStickerAttachment } from "../media/sticker-ingest.js";
import {
  StickerMoodBudget,
  detectStickerMood,
  isSeriousScene,
  pickStickerMoodName,
} from "../media/sticker-mood.js";

/** 存图候选的存活时间：图在前、指令在后的两条消息，通常几秒内到 */
const STICKER_PENDING_TTL_MS = 10 * 60 * 1000;
import { resolveSingConfig, synthesizeSong, isSingRequest, extractSongName, listLibrarySongs, resolveLibrarySong, readLibrarySilk } from "../media/sing.js";
import { resolveRemoteConfig, createSessionStore, handleRemoteCommand } from "./remote.js";
import { createRunRegistry, makeAgentChat, runAgentLoop } from "./remote-agent.js";
import {
  isBrainSwitchRequest,
  spawnBrainSwitch,
  resolveSwitchScript,
  BRAIN_REPLY_ON,
  BRAIN_REPLY_OFF,
} from "./brain-switch.js";
import { formatForQQ } from "../util/format.js";
import { botName } from "../persona/naming.js";
import { loadPersona } from "../persona/index.js";

const SUPPORTED_SCOPES = new Set(["c2c", "group"]);

/** 群成员身份（member_role）→ 可读标签 */
export const ROLE_LABELS = { owner: "群主", admin: "管理员", member: "普通成员" };

/** 把 member_role 翻成可读身份标签；未知/缺失返回 null */
/**
 * 把「实际发出去的东西」转成写进记忆的一句话。
 *
 * 为什么需要它：send() 会在唱歌/语音分支提前返回，实际发出的可能是语音或歌，
 * 而调用方手里的 replyText 仍是模型生成的文字。直接用文字写记忆，
 * 就会造成「记忆说我说了话、现实是我唱了歌」的错位——实测后果是她
 * 后来否认自己能发语音。
 */
export function memoryTextOf(result, fallback) {
  if (result?.song) {
    return result.songName
      ? `（${botName()}唱了《${result.songName}》，用语音发出去的）`
      : "（" + botName() + "唱了一首歌，用语音发出去的）";
  }
  // 想唱但没唱成：记忆里必须写"没发出去 + 实际回了什么"，
  // 不能把模型编的歌词记成"我说了这句话"——那会让她下次坚称自己唱过。
  if (result?.songFailed) return `（${botName()}想唱歌，但歌没发出去，照实说了：${fallback}）`;
  if (result?.voice) return `（${botName()}用语音说了：${fallback}）`;
  return fallback;
}

/**
 * 把「主人这一侧实际发来的内容」转成写进记忆的一句话。
 *
 * 为什么需要它：语音消息的 `content` 是空字符串，平台只把转写放在
 * `attachments[].asr_refer_text` 里。引擎生成回复时会把转写拼进去
 * （所以模型听得见），但写记忆时用的还是原始的 `msg.content`——
 * 结果记忆里主人那一轮变成空白，隔天回看就是 `[user]` 后面什么都没有，
 * 她也就"想不起来"主人说过什么。实测证据见 data/memory.json 的 owner 会话。
 *
 * 只补齐「语音 + 有转写」这一种情况：
 *  - 有文字就原样存文字（文字 + 语音附件时，文字才是人的原话）；
 *  - 老数据一条都不动（只在**新写入**时生效，读取路径不变）。
 *
 * @param {string} text 已经过 stripMentions 的正文
 * @param {ReturnType<typeof describeMedia>|null} media
 */
export function userMemoryTextOf(text, media) {
  const base = String(text ?? "").trim();
  if (base) return base;

  const asr = String(media?.asrText ?? "").trim();
  if (media?.type === "voice" && asr) return `语音转写：${asr}`;
  // 语音但平台没给转写：留一句说明，也不要留空行——
  // 空行会让她彻底失去「这轮主人说过话」的线索。
  if (media?.type === "voice") return "（主人发来一条语音，平台没有转写）";
  return base;
}

/** 在回复末尾追加一句确定性回执（用括号包起来，避免和正文混在一起） */
function appendNote(text, note) {
  const base = String(text ?? "").trim();
  const n = String(note ?? "").trim();
  if (!n) return base;
  return base ? `${base}\n\n（${n}）` : `（${n}）`;
}

/**
 * 唱歌失败时**唯一允许**发出去的那句话。
 *
 * 为什么必须有它：唱歌失败后若回落发模型的文字回复，模型会把歌词当"唱歌"发出来
 * （2026-10-17 真机：群里回了一段 59 字原创歌词，主人以为唱了，其实一个音符都没有）。
 * 失败就如实说，宁可丢脸也不许假装。
 *
 * @param {{scope?: string}} msg
 * @param {{action?: string, songName?: string, error?: string}} song
 * @returns {string}
 */
export function songHonestFailureText(msg, song) {
  const name = song?.songName ? `《${song.songName}》` : "";
  if (song?.action === "not_learned") {
    return `呜……${name}${botName()}还没学会，不瞎唱别的凑数。`;
  }
  const what = name || "歌";
  if (msg?.scope === "group") {
    return `呜……${what}没发出去，群里这次真没声音。${botName()}不拿歌词糊弄人，能唱的时候再唱。`;
  }
  return `呜……${what}没发出去，${botName()}不拿歌词糊弄主人，等能发了再唱。`;
}

/**
 * 没有回执的「假承诺」——比唱歌编歌词更普遍、更伤信任的一类谎。
 *
 * 真机 2026-10-17 21:07 原话：
 *   主人：「能在群里@junh让他去漂唱吗」…「是的呢」
 *   春禾：「好嘞，那春禾这就去大群里 @junh，提醒他该去玩火影啦～」
 * 可当时**没有建任何待办、也没有群可发**，这句「这就去」是凭空答应；
 * 主人追问「@了吗」时她才发现没发。承诺先于能力，就是假承诺。
 *
 * 处理原则和唱歌失败一致：**没有回执就不许说"这就去做/已经做了"**。
 * 这里是代码闸门，不是提示词建议——模型想骗也骗不出去。
 *
 * @param {string} text 本轮准备发出去的文本
 * @param {object} [opts]
 * @param {boolean} [opts.evidence] 是否已有确定性回执（主动发送成功/待办执行成功）
 * @param {boolean} [opts.crossScene] 这条请求是否涉及跨场景动作（群/@）
 * @returns {{text:string, hits:string[], rewritten:boolean}}
 */
const PROMISE_GROUP_RE = [
  /这就(?:去|到)[^。！？!?\n]{0,24}(?:群|@)/,
  /马上(?:就)?(?:去|到)[^。！？!?\n]{0,24}(?:群|@)/,
  /(?<![没不未])已经发[^。！？!?\n]{0,12}(?:群|@)/,
  /(?<![没不未])发(?:到|进)(?:大群|小群|群里|群聊)/,
  /(?<![没不未])已发(?:到|进)(?:大群|小群|群|群聊)/,
];
/** 只在"这条请求本来就是跨场景动作"时才拦的宽泛说法 */
const PROMISE_BROAD_RE = [
  /这就去/,
  /马上(?:就)?去/,
  /(?<![没不未])已经发(?:到|出去|出去啦|好啦|啦|在群|给你)/,
  /(?<![没不未])(?:我|春禾)(?:这就|马上|立刻)(?:去|帮你|给你)/,
];

export function guardUnbackedPromise(text, { evidence = false, crossScene = false } = {}) {
  const src = String(text ?? "");
  if (!src.trim()) return { text: src, hits: [], rewritten: false };
  if (evidence) return { text: src, hits: [], rewritten: false };

  const patterns = crossScene ? [...PROMISE_GROUP_RE, ...PROMISE_BROAD_RE] : PROMISE_GROUP_RE;
  const sentences = src.split(/(?<=[。！？!?~～\n])/u);
  const kept = [];
  const hits = [];
  for (const sentence of sentences) {
    const local = patterns.filter((re) => re.test(sentence));
    if (local.length) {
      hits.push(...local.map((re) => re.source));
      continue;
    }
    kept.push(sentence);
  }
  if (!hits.length) return { text: src, hits: [], rewritten: false };

  const note = "（" + botName() + "现在还没真的做到，不先跟主人保证；等有回执了再告诉主人。）";
  const head = kept.join("").trim();
  return { text: head ? `${head}\n\n${note}` : note, hits, rewritten: true };
}
export function roleLabelOf(role) {
  return ROLE_LABELS[role] ?? null;
}

/** 群成员表缓存有效期（成功后） */
const MEMBER_CACHE_TTL_MS = 5 * 60 * 1000;
/** 群成员表获取失败后的负缓存时长（期间不再打 API，避免每句都重试） */
const MEMBER_FAIL_CACHE_MS = 60 * 1000;

/** 可被替换的睡眠实现（测试里注入，避免真等） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MessageEngine {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {import('../qq/api.js').QQApi} opts.api
   * @param {(ctx: object) => Promise<string>} opts.generate 人格层
   * @param {object} [opts.logger]
   * @param {Function} [opts.agentChat] 自然语言 agent 的模型调用（测试注入用）
   * @param {object} [opts.agentDeps]   agent 循环依赖（spawn/rand 等，测试注入用）
   * @param {object} [opts.brainSwitch] 双引擎切换依赖（{scriptPath, powershell, spawn}，测试注入用）
   * @param {Function} [opts.ttsSynth] 语音合成实现（默认 synthesizeSilk；测试注入用）
   */
  constructor({
    config,
    api,
    generate,
    logger,
    agentChat = null,
    agentDeps = null,
    brainSwitch = null,
    ttsSynth = null,
    stickerDeps = null,
    persona = null,
  }) {
    this.config = config;
    this.api = api;
    this.generate = generate;
    this.logger = logger;
    /**
     * 已加载的人格模块（由 main.js 传入）。为 null 时按 config.persona 惰性加载，
     * 默认走 chunhe —— 直接 new MessageEngine 的测试不用改。
     */
    this.persona = persona;
    /** 存图依赖（fetchImpl / resizeImage / moderate 等，测试注入用） */
    this._stickerDeps = stickerDeps ?? {};
    /**
     * 最近一条「主人发的图」：图先到、下一句才说「存下来」时用它接上。
     * 内存态 + 10 分钟 TTL：重启就忘，但两条消息通常只隔几秒。
     */
    this.pendingStickerImages = new Map();
    /** 自动补表情的频率闸门（重启清零，表情包是氛围不是账本） */
    this.stickerBudget = new StickerMoodBudget();
    /** 语音合成：生产用 synthesizeSilk；测试注入假实现，避免真的拉起 Python/RVC */
    this._ttsSynth = typeof ttsSynth === "function" ? ttsSynth : synthesizeSilk;
    /** agent 模式：注入的模型调用（优先）与执行依赖 */
    this._agentChatGiven = agentChat;
    this._agentDeps = agentDeps ?? {};
    /** 双引擎切换：脚本路径 / powershell / spawn 实现（后两者测试可注入） */
    this._brainSwitch = brainSwitch ?? {};
    this.dedupe = new DedupeCache(config.dedupeWindow);
    this.limiter = new RateLimiter(config.rateLimitPerMinute);
    this.policy = new AccessPolicy({
      allowUsers: config.allowUsers,
      denyUsers: config.denyUsers,
      allowGroups: config.allowGroups,
    });

    /** 会话记忆（可持久化到磁盘，重启后仍记得之前聊过什么） */
    this.memory = new MemoryStore({
      maxTurns: config.historyTurns,
      // 主人跨私聊/群聊共用一份记忆，窗口单独放大；其他人的 token 成本不变。
      ownerMaxTurns: config.ownerHistoryTurns,
      file: config.memoryFile,
      logger,
    });

    /**
     * 「主人」身份：这些人的私聊与群聊共享同一份会话记忆（其他人严格隔离）。
     *
     * 为什么不是简单地把所有会话合并：群里还有别人。把所有人合到一个键，
     * 张三一说话就会读到主人的私聊内容——那是隐私事故，不是功能。
     * 因此只有白名单里的主人跨场景共享，其余人仍按「群+人」/「私聊人」隔离。
     */
    this.ownerIds = new Set([
      ...(config.adminUsers ?? []),
      ...(config.ownerUsers ?? []),
    ]);
    /**
     * 清掉主人历史里「凭空断定跨场景做不到」的错误自述。
     * 真机事故：她曾把「私聊这边没法替你往群里转发消息」写进记忆，
     * 不删掉的话，下次模型会继续模仿这句话——光靠提示词压不住。
     */
    const purged = this.memory.purgeMisleadingDenials(this.ownerIds);
    if (purged > 0) {
      logger?.warn?.(`启动清理：从主人记忆里删除了 ${purged} 条错误的自我否定`);
    }
    /** 把旧版本散落的「私聊 + 各群」会话合并到 owner:<id>（旧键保留为归档） */
    this.memory.migrateOwnerSessions(this.ownerIds);

    /**
     * 跨场景待办：不占 historyTurns 配额。
     * 「私聊里下的指令群聊不执行」的真正解法——它独立于聊天窗口存在。
     */
    this.pendingActions = new PendingActionStore({
      file: config.pendingFile,
      ttlMs: Math.max(1000, (Number(config.pendingTtlHours) || 24) * 3600 * 1000),
      maxActions: config.pendingMaxActions,
      logger,
    });

    /**
     * 群注册表：主人说「去大群/小群」或只说「群里」时，必须能落到具体 group_openid。
     * 启动时从 memory.json 的 `group:<gid>:<uid>` 会话键播种——
     * 成员数接口真机 11253 无权限，见过的发言人数是唯一稳定来源（且只是下限）。
     *
     * 数据文件隔离：memory 被指到临时目录（测试/验收脚本）时，群注册表与配额账本
     * 自动落到同一目录。否则 `npm test` 会读写线上 data/groups.json，测试之间
     * 还会互相污染（上一个用例写进去的群会被下一个用例拿去主动发消息）。
     */
    const memoryDir = path.dirname(String(config.memoryFile || "data/memory.json"));
    const ledgerFile = (file, name) => {
      const f = String(file || "");
      return f === `data/${name}` && memoryDir && memoryDir !== "data"
        ? path.join(memoryDir, name)
        : f;
    };
    this.groups = new GroupRegistry({
      file: ledgerFile(config.groupsFile, "groups.json"),
      largeThreshold: config.groupLargeThreshold,
      observedLargeThreshold: config.groupObservedLargeThreshold,
      defaultPick: config.groupDefaultPick,
      logger,
    });
    const seededGroups = this.groups.seedFromSessions(this.memory.sessions);
    if (seededGroups > 0) {
      logger?.info?.(
        `群注册表：从记忆里播种 ${this.groups.size} 个群（${seededGroups} 个群会话）`,
      );
    }

    /** 主动消息配额账本：发之前查、发完记；超限不发，如实回报 */
    this.quota = new ProactiveQuota({
      file: ledgerFile(config.proactiveQuotaFile, "proactive-quota.json"),
      dailyLimit: config.groupProactiveDailyLimit,
      minuteLimit: config.groupProactiveMinuteLimit,
      softDailyLimit: config.pendingProactiveDailyLimit,
      warnRatio: config.proactiveWarnRatio,
      logger,
    });

    /** 主人的长期记忆（偏好/称呼/以后要怎么做的指令），跨场景生效 */
    this.ownerMemory = new OwnerMemoryStore({
      file: config.ownerMemoryFile,
      maxFacts: config.ownerMemoryMaxFacts,
      logger,
    });

    /** 话题库：让单聊聊过的话题能在群里续上（受隐私规则约束） */
    this.topics = new TopicStore({ file: config.topicFile, logger });

    this.stats = {
      received: 0,
      duplicate: 0,
      denied: 0,
      rateLimited: 0,
      unsupported: 0,
      replied: 0,
      sendFailed: 0,
      /** 群里未触发回应而被跳过的消息数（省下的模型调用） */
      skipped: 0,
      /** 回复中疑似否认已实现能力的次数（应为 0，非 0 说明提示词有漏洞） */
      capabilityDenials: 0,
      /** 已有确定性回执、却被模型否认，最终用回执替换掉的次数（真机自相矛盾的次数） */
      capabilityContradictions: 0,
      /** 「群聊能不能发语音」被答成做不到、由确定性真话替换掉的次数 */
      voiceCapabilityCorrected: 0,
      /** 跨场景待办：创建 / 执行成功 / 执行失败 */
      pendingCreated: 0,
      pendingExecuted: 0,
      pendingFailed: 0,
      /** 私聊指令 → 群主动消息：真发出去 / 失败 / 因配额或没有群而没发 */
      pendingProactiveSent: 0,
      pendingProactiveFailed: 0,
      pendingProactiveSkipped: 0,
      /** 因歧义/敏感内容只存草稿、没自动发的次数（谨慎优先） */
      pendingNeedsConfirm: 0,
      /** 没有回执的假承诺被代码闸门改写的次数（应为 0，非 0 说明提示词在漏） */
      promiseGuarded: 0,
      /** 主人教的图存进表情库：成功 / 失败 */
      stickersSaved: 0,
      stickerSaveFailed: 0,
      /** 引擎自己判断场合补的表情包张数（不含用户明确要的、模型调的） */
      autoStickers: 0,
      /** 收到但非「可处理消息」的事件类型，用于诊断群消息为何没反应 */
      rawEvents: [],
    };
    /** 群聊上下文缓冲：没触发回应的消息也记着，被叫到时能接上话题 */
    this.watchBuffer = new Map();
    /**
     * 她上次在某个群说话的**时间**（groupOpenid → ms）。
     *
     * 2026-10-19 有群友反馈「必须塞句『春禾』才会回应，接不上话」——
     * wake 模式只认名字太机械。真正的判据是：**别人接着她的话说，那就是在跟她说话**。
     * 这里记下她每次在群里发言的时间，2 分钟内有人接着说话就当成 follow-up。
     */
    this.lastHerReplyAt = new Map();
    /** 骚扰追踪：同一个人反复骚扰到阈值时，主动私聊告状（见 core/harassment.js） */
    this.harassment = new HarassmentTracker();
    /** 最近一次告状涉及的人（主人回「我去处理」时据此静音） */
    this.lastAlertSender = null;
    this.lastAlertAt = 0;
    /** 主人最近一条私聊里，她说的最后一句（用于「群里发」= 把刚说的那句发到群里） */
    this.lastReplyText = "";
    /** 最近活跃的群（「群里发」时默认发这里） */
    this.lastGroupOpenid = "";
    /**
     * 名字登记表（见 core/names.js）。
     * QQ 群消息**不给昵称**、成员接口无权限、事件里也没有群名 —— 只能靠学：
     * 主人起名、自我介绍、@ 提及。学到之后 `#watchGroup` 的说话人标签就用真名。
     */
    this.names = new NameRegistry({ file: config.namesFile ?? "data/names.json", logger: this.logger });
    /**
     * 好感度（见 core/affinity.js）。
     * 主人恒定最高；群友按实际行为加减：骚扰 −2/−3，礼貌/夸奖 +1。
     * 分数决定她对这个人说话的冷暖。
     */
    /**
     * 成长本（见 core/growth.js）。
     * 她说错话被打断纠正 → 记一条"要改"；做法被认可 → 记一条"继续保持"。
     * 这些规则会注入提示词、按权重排序，让她**真的变行为**而不只是记事。
     */
    this.growth = new GrowthBook({ file: config.growthFile ?? "data/growth.json", logger: this.logger });
    this.affinity = new AffinityStore({
      file: config.affinityFile ?? "data/affinity.json",
      logger: this.logger,
      ownerIds: [...this.ownerIds],
    });
    // ⭐ 2026-10-19：启动时**从记忆里播种**群聊缓冲。
    //   缓冲是内存态，重启即空；主人重启后问「群里刚才发生什么」她会一片空白。
    //   从 memory 的 `group:<gid>:<uid>` 会话里把最近的对话捞回来，
    //   这样「群里有人骚扰」这类事重启后仍然看得到（只对主人私聊开放读取）。
    try {
      const perGroup = Number(config.groupWatchLimit ?? 10) || 10;
      const seen = new Set();
      for (const [key, arr] of (this.memory?.sessions ?? new Map()).entries()) {
        if (!String(key).startsWith("group:")) continue;
        const parts = String(key).split(":");
        if (parts.length < 3) continue;
        const gk = `group:${parts[1]}`;
        const uid = String(parts[2] ?? "");
        // 用 openid 尾号做说话人标签（与 #watchGroup 一致）——
        // 群消息没有昵称，统一叫「某群友」会让她分不清谁说了什么。
        const speaker = this.ownerIds?.has?.(uid) ? "主人" : (this.names?.labelFor(uid) ?? `群友${uid.slice(-4) || "??"}`);
        const bucket = this.watchBuffer.get(gk) ?? [];
        for (const m of (arr ?? []).slice(-perGroup)) {
          const txt = String(m?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
          if (!txt) continue;
          const line = `${m.role === "user" ? speaker : "" + botName() + ""}: ${txt}`;
          // 跨会话可能重复（同一句在两个会话里），用 groupkey+line 去重
          const sig = `${gk}|${line}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          bucket.push(line);
        }
        while (bucket.length > perGroup * 2) bucket.shift();
        this.watchBuffer.set(gk, bucket);
      }
    } catch {
      /* 播种失败不影响启动；缓冲会自己补齐 */
    }
    /** 群成员表缓存：groupOpenid → { map, fetchedAt, failedUntil }；用于把「@名字」解析成真 @ */
    this.memberMapCache = new Map();
    /** 定时提醒：让春禾能"过一会儿"主动开口（会占平台主动消息配额） */
    this.reminders = new ReminderStore({
      file: config.reminderFile,
      perSessionLimit: config.reminderDailyLimit,
      minDelayMs: config.reminderMinDelayMs,
      maxDelayMs: config.reminderMaxDelayMs,
      logger,
    });
    /** 可选的主动消息调度器：收到消息时通知它"这个会话刚活跃过" */
    this.proactive = null;    /** 已发出的回复，便于测试断言 */
    this.sent = [];

    /**
     * 同一条用户消息的 msg_seq 计数器：msg_id → 上次用的 seq。
     *
     * QQ 要求同一个 msg_id 的多次回复必须用**不同**的 msg_seq；多段歌连续发时
     * 还得递增（随机的 nextMsgSeq() 可能倒退）。按 msg_id 记一份，发下一段就 +1。
     */
    this.voiceSeqByMsg = new Map();

    /** 静默口令：按群区分，key=groupOpenid, value=静默到期时间戳 */
    this.silencedGroups = new Map();
    this.SILENCE_ON_WORDS = new Set(["静默", "闭嘴", "停", "收", "都闭嘴", "别说话了"]);
    this.SILENCE_OFF_WORDS = new Set(["继续", "说", "开", "开口", "可以说了"]);
    this.SILENCE_DEFAULT_DURATION = 10 * 60 * 1000; // 10 分钟
  }

  /** 处理一条归一化消息 */
  async handle(msg) {
    this.stats.received += 1;

    // 1) 去重
    if (!this.dedupe.check(msg.messageId)) {
      this.stats.duplicate += 1;
      this.logger?.debug?.(`重复消息，丢弃 msgId=${msg.messageId}`);
      return { action: "duplicate" };
    }

    // 2) 场景过滤
    if (!SUPPORTED_SCOPES.has(msg.scope)) {
      this.stats.unsupported += 1;
      this.logger?.info?.(`暂不支持的场景 ${msg.scope}（频道/频道私信需另走接口）`);
      return { action: "unsupported" };
    }

    // 3) 白名单
    const userCheck = this.policy.checkUser(msg.senderId);
    if (!userCheck.allowed) {
      this.stats.denied += 1;
      this.logger?.warn?.(`拒绝消息：${userCheck.reason}`);
      return { action: "denied", reason: userCheck.reason };
    }
    if (msg.scope === "group") {
      const groupCheck = this.policy.checkGroup(msg.groupOpenid);
      if (!groupCheck.allowed) {
        this.stats.denied += 1;
        this.logger?.warn?.(`拒绝消息：${groupCheck.reason}`);
        return { action: "denied", reason: groupCheck.reason };
      }
    }

    // 机器人消息处理：其他机器人的消息正常回应，但加防循环冷却（30秒内刚在同群发过就不回，避免两个机器人互聊死循环）
    if (msg.senderIsBot) {
      const now = Date.now();
      const recentSent = this.sent.some(s =>
        s.scope === "group" && s.targetId === msg.targetId && now - (s.at ?? 0) < 30_000
      );
      if (recentSent) {
        this.logger?.debug?.(`忽略机器人消息（防循环冷却中）：${msg.senderName}`);
        return { action: "ignored" };
      }
      // 不在冷却期：其他机器人的消息正常走 shouldRespond 判断
    }

    // 4) 静默口令检测（群聊才生效，私聊不受影响）
    if (msg.scope === "group") {
      const text = (msg.content || "").trim();
      const gid = msg.groupOpenid;

      // 开启静默
      if (this.SILENCE_ON_WORDS.has(text)) {
        this.silencedGroups.set(gid, Date.now() + this.SILENCE_DEFAULT_DURATION);
        this.logger?.info?.(`静默开启: ${gid} 时长=${this.SILENCE_DEFAULT_DURATION}ms`);
        await this.send(msg, "好~我闭嘴了😶");
        this.stats.replied += 1;
        return { action: "silenced_on" };
      }
      // 解除静默
      if (this.SILENCE_OFF_WORDS.has(text)) {
        this.silencedGroups.delete(gid);
        this.logger?.info?.(`静默解除: ${gid}`);
        await this.send(msg, "好，我又可以说话啦~");
        this.stats.replied += 1;
        return { action: "silenced_off" };
      }
      // 静默期内直接不回复
      const until = this.silencedGroups.get(gid);
      if (until && Date.now() < until) {
        this.stats.skipped += 1;
        this.logger?.debug?.(`静默期内不回复: ${gid}`);
        return { action: "silenced" };
      }
    }

    // 5) 触发闸门 + 群聊上下文缓冲
    //
    // 必须放在"生成回复"之前：群里大量闲聊不该触发模型调用（费钱又扰民）。
    // 非 @ 的普通群消息在 mention 模式下会被静默丢弃——平台开了"全量消息"也不会打扰人。
    {
      const observed = stripMentions(msg.content);
      const mediaKind = describeMedia(msg);
      const atMention = msg.rawEventType === "GROUP_AT_MESSAGE_CREATE";

      // ⭐ 2026-10-19 修：**不管回不回，群消息都要记进跨场景缓冲**。
      //   原实现只在「不回应」分支记（remember 回调），结果她**回了**的那条反而没记录——
      //   真机：群里有人问「真没有和群主的床照吗」，她回了 27 字，但缓冲里没有；
      //   主人私聊问「群里有人骚扰你吗」，她一片空白。
      //   现在提前无条件记一次，主人私聊就能看到各群发生了什么。
      if (msg.scope === "group") {
        this.#watchGroup(msg, observed, mediaKind);
      }

      const decision = this.#shouldRespond(msg, observed, atMention);

      if (!decision.respond) {
        this.stats.skipped += 1;
        this.logger?.debug?.(`群里未触发回应（${decision.reason}），已记入上下文`);
        return { action: "skipped", reason: decision.reason };
      }
      // 命中唤名时，把唤名本身从文本里去掉，避免模型把它当成内容
      if (decision.stripName) {
        msg = { ...msg, content: stripWakeNames(msg.content, this.config.wakeNames) };
      }
    }

    // 5) 限流
    const limit = this.limiter.take(msg.senderId);
    if (!limit.ok) {
      this.stats.rateLimited += 1;
      this.logger?.warn?.(`触发限流，${Math.ceil(limit.retryAfterMs / 1000)}s 后恢复`);
      return { action: "rate_limited" };
    }

    // 6) 生成回复
    const cleanText = stripMentions(msg.content);
    const media = describeMedia(msg);
    const isOwnerUser = isOwnerSender(msg, this.ownerIds);
    const sessionKey = sessionKeyOf(msg, this.ownerIds);

    // 6.1) 骚扰追踪（2026-10-19 主人要求：「被群里其他人骚扰太多次就找我告状」）。
    //      只统计**群里的非主人**；到阈值就主动私聊告状（有冷却与全天上限）。
    //      这里**不 await**——告状失败绝不该影响她正常回话。
    if (msg.scope === "group" && !isOwnerUser) {
      this.#trackHarassment(msg, cleanText);
    }

    // 6.2) 名字学习（QQ 群消息不给昵称、成员接口无权限，只能靠学）。
    //   · 群友自我介绍「我是丙某」→ 把这句话的发送者绑上「丙某」
    //   · 主人说「这个群叫大群」→ 记住群名
    //   学到之后 #watchGroup 的说话人标签就用真名，减少认错人。
    if (msg.scope === "group" && msg.senderId) {
      // 2026-10-20：**群主也要记名字**（原来只在非主人分支里学）；而且
      // `author.username` 时给时不给，每个人都该在出现的那一刻被记住一次。
      if (msg.senderName) {
        this.names.learnMember(msg.senderId, msg.senderName, { groupOpenid: msg.groupOpenid });
      }
      // 活跃度统计：名字学不到时，"哪个群里都有谁"是唯一能推群名的线索
      this.names.touchMember?.(msg.senderId, { groupOpenid: msg.groupOpenid });
      this.names.touchGroup?.(msg.groupOpenid);

      // ⭐ 从 @ 提名单里学名字（gateway 早就存了 `d.mentions`，引擎之前从没用过）
      if (Array.isArray(msg.mentions)) {
        for (const mn of msg.mentions) {
          const mName = mn?.username ?? mn?.nick ?? "";
          const mId = mn?.member_openid || mn?.id || "";
          if (mId && mName) this.names.learnMember(mId, mName, { groupOpenid: msg.groupOpenid });
        }
      }

      if (!isOwnerUser) {
        // 自我介绍（「我是某某」）作为补充
        const intro = detectSelfIntro(cleanText);
        if (intro) this.names.learnMember(msg.senderId, intro, { groupOpenid: msg.groupOpenid });
        // 别人也可以给当前说话的人起名：「他叫阿杰」
        const named = detectNamingIntent(cleanText);
        if (named?.kind === "member-current") {
          this.names.learnMember(msg.senderId, named.name, { groupOpenid: msg.groupOpenid });
        }
      } else {
        const naming = detectNamingIntent(cleanText);
        if (naming?.kind === "group-current") this.names.learnGroup(msg.groupOpenid, naming.name);
        if (naming?.kind === "member-current") {
          this.names.learnMember(msg.senderId, naming.name, { groupOpenid: msg.groupOpenid });
        }
      }
    }

    // 6.2a2) 主人说「X 是（比较）重要的人 / X 很重要」→ 给 X 加好感度。
    //   2026-10-19 真机：主人说「某某是主人比较重要的人，等下他群里说话的时候可以亲近点」，
    //   结果被当成"往群里发消息"的待办，她真的发了一条到群里。
    //   这句话的真实语义是**态度偏好**，应该记进好感度，不是发消息。
    if (isOwnerUser) {
      const imp = /([^\\s，,。！？!?]{1,10})(?:是|算|挺|很|比较)?[^。！？!?]{0,6}(?:重要的人|很重要|挺重要|重要)/.exec(cleanText);
      if (imp) {
        const who = String(imp[1] ?? "").replace(/^[和跟对的]\s*/, "").trim();
        for (const [uid, name] of this.names?.members ?? []) {
          if (name === who) { this.affinity?.adjust?.(uid, 5, "主人说重要的人"); break; }
        }
      }
    }

    // 6.2b) 善意信号 → 好感度 +
    //   「谢谢」「你好可爱」「辛苦了」这类给个 +1，让态度能真的变好。
    if (!isOwnerUser && msg.senderId) {
      const kind = detectKindness(cleanText);
      if (kind > 0) this.affinity?.adjust?.(msg.senderId, kind, "礼貌/夸奖");

    // 6.2c) 成长：从纠正/认可里学「我该怎么做」
    //   真机：被说「太长了」「别这么说话」时，她只会道歉，**下次照旧**。
    //   这里把这类反馈变成**可累积的规则**，注入后她才能真的改。
    if (cleanText) {
      const sig = detectGrowthSignal(cleanText);
      if (sig) {
        const res = this.growth?.learn?.(sig, { condensed: condenseLesson(sig) });
        if (res?.isNew) this.logger?.info?.(`成长：学到「${String(sig.text).slice(0, 30)}」`);
        if (res?.isNew && !res.id) this.logger?.warn?.("成长：规则 id 为空（写入失败）");
      }
    }
    }

    // 6.3) 「我去处理」→ 把刚投诉的那个人静音一段时间（别一直告状烦主人）。
    //      2026-10-19 主人要求：「告状时不用每次都告，我去处理时就不用了。」
    //      只在**刚告过状（30 分钟内）**、且是**主人本人私聊**说的时候生效。
    if (
      msg.scope === "c2c" &&
      isOwnerUser &&
      this.lastAlertSender &&
      Date.now() - this.lastAlertAt < 30 * 60 * 1000 &&
      /(我去|我来|我这就|我去说|我教训|我收抬|我处理|处理一下|知道了|别理他|别管他|拉黑|踢了|已处理|交给我)/.test(
        cleanText,
      )
    ) {
      this.harassment.silence(this.lastAlertSender, 60 * 60 * 1000);
      this.logger?.info?.(`主人接手处理 → ${String(this.lastAlertSender).slice(-4)} 的告状静音 1 小时`);
      this.lastAlertSender = null;
    }


    // 自动补表情的轮次计数：群聊按整个群算（不同人轮流打招呼也不该刷屏）
    const stickerMoodKey = msg.scope === "group" ? `group:${msg.groupOpenid}` : sessionKey;
    this.stickerBudget.noteTurn(stickerMoodKey);

    // 存图：主人发图 + 「存下来」时由引擎确定性地存并回执。
    // 必须在人格模型之前——存没存是事实，不能交给模型自由发挥（真机已出现过
    // 「假装存了/说存不了」两种错法）。
    const stickerSave = await this.#interceptStickerSave({
      msg,
      cleanText,
      media,
      isOwnerUser,
      sessionKey,
    });
    if (stickerSave) return stickerSave;

    // 群注册表：每个群消息都记一笔「这个人露过面 / 这个群聊了几句」。
    // 成员数接口真机不可用（11253），这是唯一能持续更新的群规模信号（下限）。
    if (msg.scope === "group" && msg.groupOpenid) {
      this.groups.observe({
        groupOpenid: msg.groupOpenid,
        senderOpenid: msg.senderId,
      });
      this.groups.addMessages(msg.groupOpenid, 1);
    }

    // 通知主动调度器：这个会话刚活跃过（避免在别人正聊天时插话）
    this.proactive?.touch(sessionKey, { scope: msg.scope, targetId: msg.targetId });

    // 话题：把这次聊到的记下来（主人自己的会进入跨场景共享库），
    // 并把相关话题取出来交给模型，让它在群里也能接上私聊说过的事。
    // scene 用于隔离：群成员的话题只在自己群里可见，不会串到别人的私聊/别的群。
    const isAdmin = this.config.adminUsers.includes(msg.senderId);
    const topicMemory = this.topics.relevant({
      query: cleanText,
      includeShared: true,
      owner: sessionKey,
      scene: topicSceneOf(msg, this.ownerIds),
      // 只有主人能读到"主人名下的任何话题"；群成员永远拿不到这层
      ownerIds: isOwnerUser ? [...this.ownerIds] : [],
      limit: this.config.topicContextLimit,
    });

    // 只有主人说的话才可能成为「长期记忆」（群成员说「以后叫我老大」不算）。
    // 必须在组装 ctx 之前学，这样"刚记住的事"本轮就能用上。
    if (isOwnerUser) this.ownerMemory.learn(cleanText, { scene: msg.scope });

    // 跨场景待办识别：**只从私聊**识别「待会到群里做 X」。
    // 群聊里说同样的话不建待办——那要么是复述、要么是在跟别人说，容易误触发。
    // 「以后每次…」不是一次性待办，而是长期规矩：交给上面的 ownerMemory，
    // 否则会变成每句话都卖萌的骚扰。
    const pendingIntent =
      isOwnerUser && msg.scope === "c2c" && this.config.pendingEnabled !== false
        ? parsePendingInstruction(cleanText, {
            ttlMs: Math.max(
              1000,
              (Number(this.config.pendingTtlHours) || 24) * 3600 * 1000,
            ),
          })
        : null;
    let queuedPending = null;
    let recurringRule = null;
    if (pendingIntent) {
      if (pendingIntent.recurring) {
        recurringRule = pendingIntent;
      } else {
        // 歧义/敏感内容：只留待确认草稿，**不自动发**（主动群消息撤不回）。
        const needsConfirm = Boolean(pendingIntent.needsConfirm);
        queuedPending = this.pendingActions.create({
          ownerId: msg.senderId,
          action: pendingIntent.action,
          kind: pendingIntent.kind,
          target: pendingIntent.target,
          // proactive=创建后立刻主动发到群里；deferred=旧行为（等主人开口）
          delivery: needsConfirm ? PENDING_DELIVERY.DEFERRED : this.config.pendingDelivery,
          createdScene: "c2c",
          createdGroup: "",
          payload: needsConfirm
            ? {
                ...pendingIntent.payload,
                needsConfirm: true,
                needsConfirmReason: pendingIntent.needsConfirmReason,
              }
            : pendingIntent.payload,
          expiresAt: pendingIntent.expiresAt,
        });
        if (queuedPending) {
          this.stats.pendingCreated += 1;
          if (queuedPending.payload?.needsConfirm) this.stats.pendingNeedsConfirm += 1;
          this.logger?.info?.(
            `已记下跨场景待办：${queuedPending.action.slice(0, 30)}` +
              `（${queuedPending.target}，${queuedPending.delivery}` +
              `${queuedPending.payload?.needsConfirm ? "，待确认不自动发" : ""}）`,
          );
        }
      }
    }

    // 主动投递：**创建后立刻发**，不等主人到群里开口。
    // 失败/没有群时也返回结果——回执必须如实说清楚，绝不能假装发了。
    let proactiveDelivery = null;
    if (queuedPending && queuedPending.delivery === PENDING_DELIVERY.PROACTIVE) {
      const outcome = await this.#deliverPendingProactively(queuedPending);
      // deferred=true 表示这类动作（唱歌/表情包等）不适合由引擎代写文字，
      // 交给旧路径：回执用「等主人在群里说话」的诚实说法。
      if (!outcome?.deferred) proactiveDelivery = outcome;
    }

    // 表情包请求（「看看你卖萌的样子」「发个比心」「发个表情包」）：引擎确定性地发。
    // 不交给模型掷骰子——真机同一句话有时发图、有时只回文字（22:22 那次只回了 20 字）。
    // 私聊里刚记下的跨场景待办不算：那是要发到**群里**，由待办投递负责，别发到私聊。
    const stickerPlan =
      !queuedPending && msg.kind !== "image" ? await this.#planStickerReply(cleanText) : null;

    // 当前说话者身份（群消息才带 member_role）。群作用域拉一次成员表，
    // 供后续把回复里的「@名字」换成真 @；失败时 memberMap=null 优雅降级。
    const senderRole = msg.memberRole ?? null;
    const senderRoleLabel = roleLabelOf(senderRole);
    const isOwner = senderRole === "owner";
    const memberMap =
      msg.scope === "group" ? await this.#resolveMemberMap(msg.groupOpenid) : null;

    // ---------------------------------------------------------------------
    // 跨场景待办执行：主人本人在群里说话 → 取出匹配的待办执行。
    //
    // 为什么必须是主人本人：非主人既看不到、也不该替主人消耗待办；
    // 更不能让"任意群"的待办在主人没出现的群里被触发（那会吓到群友）。
    // 为什么放在限流之后、生成之前：被限流就不该执行，否则等于绕过限流。
    // ---------------------------------------------------------------------
    let executivePending =
      msg.scope === "group" && isOwnerUser && this.config.pendingEnabled !== false
        ? this.pendingActions.match({
            ownerId: msg.senderId,
            groupOpenid: msg.groupOpenid,
            fromOwner: true,
          })
        : null;

    let pendingActionForCtx = null;
    let pendingExecuted = null;
    let pendingLine = "";
    let pendingSongAttempted = false;
    let pendingSongSettled = false;
    let pendingVoiceAttempted = false;
    let pendingVoiceSettled = false;

    if (executivePending) {
      this.logger?.info?.(
        `命中跨场景待办：${executivePending.action.slice(0, 40)}（${executivePending.target}）`,
      );
      pendingActionForCtx = {
        id: executivePending.id,
        action: executivePending.action,
        kind: executivePending.kind,
        target: executivePending.target,
      };

      // 唱歌这类"必须真发媒体"的动作，不能交给模型用文字假装；
      // 直接复用引擎的曲库发送路径（与「唱首歌」完全同一条管道）。
      if (executivePending.kind === "sing") {
        const songName = String(executivePending.payload?.songName ?? "").trim();
        const singCfg = this.#singConfig();
        if (songName && singCfg.enabled) {
          pendingSongAttempted = true;
          pendingSongSettled = true;
          let song;
          try {
            song = await this.#sendSong({
              ...msg,
              content: `唱《${songName}》`,
            });
          } catch (err) {
            song = { action: "send_failed", error: String(err?.message ?? err) };
          }
          if (song.action === "replied") {
            this.pendingActions.markDone(executivePending.id, {
              groupOpenid: msg.groupOpenid,
              result: "ok",
            });
            this.stats.pendingExecuted += 1;
            pendingExecuted = {
              action: executivePending.action,
              kind: "sing",
              ok: true,
              songName: song.songName ?? songName,
            };
            pendingActionForCtx = null;
          } else if (song.action === "not_learned") {
            // 曲库确实没有：如实说不会，这条待办就算"已回应"，不无限重试。
            this.pendingActions.markDone(executivePending.id, {
              groupOpenid: msg.groupOpenid,
              result: "not_learned",
            });
            pendingLine = songHonestFailureText(msg, song);
            pendingExecuted = {
              action: executivePending.action,
              kind: "sing",
              ok: false,
              songName,
              failure: song.error ?? "曲库没有这首歌",
            };
            pendingActionForCtx = null;
          } else {
            // 发送失败（网络/权限）：保留待办，下次再试；这次仍要如实说没发出去。
            this.pendingActions.markAttempt(executivePending.id, {
              error: song.error ?? "unknown",
            });
            this.stats.pendingFailed += 1;
            pendingLine = songHonestFailureText(msg, { ...song, songName });
            pendingExecuted = {
              action: executivePending.action,
              kind: "sing",
              ok: false,
              songName,
              failure: song.error ?? "unknown",
            };
            pendingActionForCtx = null;
          }
        } else if (!songName) {
          // 没点名具体哪首：**不做默认合成**（合成的默认曲不是主人点的歌，
          // 还会占 GPU/几分钟）。让模型先问主人想听哪首，这条待办按"已回应"结束。
          executivePending = { ...executivePending, kind: "generic" };
          pendingActionForCtx = { ...pendingActionForCtx, kind: "generic" };
        } else {
          // 唱歌功能被关掉：如实说，待办保留（开了之后还能执行）。
          this.pendingActions.markAttempt(executivePending.id, {
            error: "sing_disabled",
          });
          this.stats.pendingFailed += 1;
          pendingSongSettled = true;
          pendingLine = "呜……" + botName() + "现在唱歌功能没开，这条先记着，开了再唱给主人听。";
          pendingActionForCtx = null;
        }
      }

      // 「在群里用语音说 X」：必须真的发语音，不能交给模型改成文字。
      // 走 #sendVoice（TTS → RVC → SILK → 按 scope 上传/发送），失败才降级文字。
      if (executivePending.kind === "voice") {
        const said =
          String(executivePending.payload?.text ?? "").trim() || executivePending.action;
        pendingVoiceAttempted = true;
        pendingVoiceSettled = true;
        const voice = await this.#sendVoice(msg, said);
        if (voice.action === "replied") {
          this.pendingActions.markDone(executivePending.id, {
            groupOpenid: msg.groupOpenid,
            result: "ok",
          });
          this.stats.pendingExecuted += 1;
          pendingExecuted = {
            action: executivePending.action,
            kind: "voice",
            ok: true,
            text: said,
          };
          pendingActionForCtx = null;
        } else {
          // 语音没发出去：待办保留（下次还能补），但这一轮必须用文字把内容说到，
          // 并且说清楚"这是打字说的、不是语音"。
          this.pendingActions.markAttempt(executivePending.id, {
            error: voice.error ?? "voice_send_failed",
          });
          this.stats.pendingFailed += 1;
          pendingExecuted = {
            action: executivePending.action,
            kind: "voice",
            ok: false,
            text: said,
            failure: voice.error ?? "未知原因",
          };
          pendingActionForCtx = null;
          pendingLine =
            `呜……${botName()}想用语音说「${said}」，可语音没发出去` +
            `（${voice.error ?? "未知原因"}），先打字说：${said}`;
        }
      }

      // 文本类待办：这条确定性文案直接拼进本轮回复，保证"真的做了"，
      // 不把"卖个萌"这种小事交给模型自由发挥（它可能又解释成做不到）。
      if (pendingActionForCtx && executivePending.kind !== "sing") {
        pendingLine = this.#pendingLineFor(executivePending);
        if (executivePending.kind !== "generic") {
          pendingExecuted = {
            action: executivePending.action,
            kind: executivePending.kind,
            ok: true,
          };
        }
      }
    }

    // 曲库清单：只在主人问「会哪些歌 / 这首会不会」时查询并注入，
    // 不是每轮都带，省 token。
    let songLibrary = [];
    if (this.#shouldListSongLibrary(cleanText)) {
      const names = await this.#librarySongNames();
      const cap = Math.max(1, Number(this.config.songLibraryLimit) || 60);
      songLibrary = names.slice(0, cap);
    }

    // 主人统一会话：历史里可能同时有私聊和群聊的内容（带〔私聊〕/〔群聊〕标注）。
    // crossScene 告诉人格层「这份记忆是跨场景的」，据此注入安全阀，防止当众复述私聊内容。
    const history = this.memory.getForModel(sessionKey, {
      annotate: isOwnerUser,
      // owner 窗口放大后必须按字符预算封顶，否则长消息会把 token 拉爆。
      maxChars: isOwnerUser ? this.config.ownerHistoryMaxChars : 0,
    });
    const crossScene =
      isOwnerUser && history.some((m) => m.scene && m.scene !== msg.scope);

    // 2026-10-20：更早对话的压缩摘要（系统侧），不塞进对话历史
    let memorySummary = this.memory.getSummary?.(sessionKey) ?? "";

    // 2026-10-20：**回忆指代召回**。用户说「上次说的那个游戏」「之前那个事」时，
    // 从话题库按关键词捞回最相关的几条 —— 否则她只能回"我不记得了"。
    // 只在真的出现指代词时才查，避免每轮都往上下文里塞东西。
    const RECALL_CUE =
      /(?:上次|上回|之前|前些天|前几天|以前说过|那个事|那件事|还记得|记不记得|说过的那|我跟你说的)/;
    if (RECALL_CUE.test(cleanText) && this.topics?.search) {
      try {
        const hits = this.topics.search(cleanText, { limit: 3 });
        if (hits.length) {
          const recall =
            '〔他说「上次/之前」，下面是从记忆里找到的相关内容〕\n' +
            hits.map((h) => '- ' + h.text).join('\n');
          memorySummary = [memorySummary, recall].filter(Boolean).join('\n\n');
          this.logger?.debug?.('回忆召回：命中 ' + hits.length + ' 条话题');
        }
      } catch (err) {
        this.logger?.warn?.('回忆召回失败（不影响回复）：' + (err?.message ?? err));
      }
    }

    // 待办列表给模型看，但**排除正在执行的这一条**（它由 pendingAction 单独说明），
    // 且非主人一律为空数组——这是隐私边界，不是可选优化。
    const pendingForCtx = isOwnerUser
      ? this.pendingActions
          .list({ ownerId: msg.senderId })
          .filter((p) => p.id !== executivePending?.id)
      : [];

    const ctx = {
      text: cleanText,
      rawText: msg.content,
      kind: msg.kind,
      scope: msg.scope,
      senderId: msg.senderId,
      senderName: msg.senderName,
      messageId: msg.messageId,
      sessionKey,
      history,
      /** 更早对话的压缩摘要（系统侧）；从没溢出过就是空串 */
      memorySummary,
      /** 模型最多读多少条历史（owner 40 条 / 其他人 16 条） */
      historyLimit: isOwnerUser
        ? Math.max(0, Number(this.config.ownerHistoryTurns) * 2)
        : Math.max(0, Number(this.config.historyTurns) * 2),
      /** 这份记忆是否跨越了私聊/群聊（只有主人会） */
      crossScene,
      /** 当前说话者是不是配置里的主人（跨场景记忆的真正主人） */
      isOwnerUser,
      /** 主人的长期记忆（偏好/称呼/指令）；非主人一定为空数组 */
      ownerMemory: isOwnerUser ? this.ownerMemory.list() : [],
      /** 还没执行的跨场景待办；非主人一定为空数组 */
      pendingActions: pendingForCtx,
      /** 春禾在哪些群、各自多大（仅主人可见；用于「去大群/小群」） */
      groups: isOwnerUser ? this.groups.listForModel() : [],
      /** 这一轮主动投递待办的结果（成功/失败/为什么没发），供人格层接话 */
      pendingDelivered: proactiveDelivery,
      /** 这一轮引擎已经确定要发/已经发出的表情包名字（防止模型重复调用工具） */
      stickerPlanned: stickerPlan?.name ?? "",
      /** 这一轮因歧义/敏感内容而**没有自动发**的待确认草稿（供人格层先问清楚） */
      pendingNeedsConfirm: queuedPending?.payload?.needsConfirm ? queuedPending : null,
      /** 这一轮要执行的待办（仅主人，且仅群聊） */
      pendingAction: pendingActionForCtx,
      /** 这一轮刚执行完的待办（唱歌成功/失败等），供人格层接话 */
      pendingExecuted,
      /** 曲库清单（仅主人问起时非空） */
      songLibrary,
      /** 非文本消息（图片/表情包/语音/文件）的类型，无则为 null */
      media,
      /** 附件原样传递（含 url），供支持视觉的模型使用 */
      attachments: msg.attachments ?? [],
      /** 相关话题（跨场景），用于"续上之前聊过的事"与"自己找话题" */
      topics: topicMemory,
      /** 群里的近期发言（未触发回应的也记着），让被叫到时能接上上下文 */
      // 2026-10-19 修：主人**私聊**时也要能看到群里最近发生了什么
      //   （原实现 c2c 恒为 []，导致「群里有人要床照」这类事她在私聊里完全不知道）。
      //   只对主人开放：群成员的私聊仍拿不到别人的群发言，避免跨用户泄漏。
      groupContext: msg.scope === "group"
        ? this.getGroupWatch(msg.groupOpenid)
        : isOwnerSender(msg, this.ownerIds)
          ? this.getAllGroupsWatch(12)
          : [],
      isAdmin,
      /** 当前说话者的群身份（owner/admin/member）及其可读标签 */
      senderRole,
      senderRoleLabel,
      isOwner,
      /** 群成员名→openid 映射（仅群作用域、且成员表可用时存在） */
      memberMap,
      /**
       * 当前真实的语音能力状态（供人格层回答"能不能发语音"，也供本地规则模式）。
       * 群聊三态：off / on-demand / always；不要让她凭直觉猜。
       */
      voiceCapability: this.#voiceCapability(),
      /**
       * 这个人在本统计窗口内骚扰过几次（0 = 没有）。
       * 供人格层决定"该冷淡拒绝还是可以直接骂回去"——
       * 主人 2026-10-19 明确允许「骚扰到一定程度可以骂回去」，但要分档，不能一上来就炸。
       */
      harassmentCount: this.harassment?.infoOf(msg.senderId)?.count ?? 0,
      /** 学到的群名/人名（供人格层注入，减少认错人） */
      namesHint: this.names?.describe?.() ?? "",
      /**
       * **这一轮正在跟谁说话**（2026-10-19：她在群里把别人当成主人，还编出一个群里根本没人提过的名字）。
       * 群消息不带昵称，她只能瞎猜 —— 这里把事实直接给她：
       *   是不是主人、叫什么、什么身份。
       */
      currentSpeaker: {
        isOwner: isOwnerUser,
        label: isOwnerUser
          ? "主人"
          : (this.names?.labelFor?.(msg.senderId) ?? `群友${String(msg.senderId ?? "").slice(-4)}`),
        known: isOwnerUser || Boolean(this.names?.hasMember?.(msg.senderId)),
        role: senderRoleLabel || "",
        scene: msg.scope,
      },
      /**
       * 对当前说话人的好感度（决定冷暖：好人好态度，恶人坏态度，主人永远好）。
       * `affinityScore` 是**数值**，给"能不能画图"这类门槛用。
       */
      affinityHint: this.affinity?.describe?.(msg.senderId, {
        label: isOwnerUser
          ? "主人"
          : (this.names?.labelFor?.(msg.senderId) ?? `尾号${String(msg.senderId ?? "").slice(-4)}`),
      }) ?? "",
      affinityScore: this.affinity?.get?.(msg.senderId) ?? 0,
      /**
       * 能不能用生图工具（2026-10-19 主人要求：「好感度比较高的可以申请」）。
       * 主人永远可以；群友要 ≥ +2（"友好"档）才行 —— 画一张约 25 秒且计费，不能让路人随便薅。
       */
      canGenerateImage: (() => {
        if (isOwnerUser) return true;
        const score = this.affinity?.get?.(msg.senderId) ?? 0;
        return score >= 2;
      })(),
      /** 她学到的行为规则（成长本） */
      growthHint: this.growth?.describe?.() ?? "",
      /**
       * 「往群里发话」的工具出口（见 media/group-send.js）。
       * 只有**主人私聊**时才注入，群成员拿不到这个能力。
       */
      // 只有主人私聊才给「往群里发话」的能力（群成员不能借她的手）。
      groupsForSend: msg.scope === "c2c" && isOwnerUser ? this.#groupsForSend() : [],
      sendGroupMessage: (text2, groupHint) => this.#sendGroupTool(text2, groupHint),
    };

    this.logger?.info?.(
      `收到 ${msg.scope} 消息：${
        media
          ? `[${media.label}]${cleanText ? ` 附带文字「${cleanText.slice(0, 40)}」` : "（无文字）"}`
          : cleanText.slice(0, 60) + (cleanText.length > 60 ? "…" : "")
      }`,
    );

    let reply;

    // 6.5) 远程控制 / 自然语言 agent —— 必须在人格模型**之前**。
    //      命中即指令，不该消耗模型额度；更重要的是：人格模型并不知道（也不该
    //      假装）自己能操作这台电脑，真能动手的只有 agent 循环。
    //      不是指令、没解锁、没配模型时返回 handled:false，继续往下走人格层。
    const sendMsg = msg.scope === "group" && memberMap ? { ...msg, memberMap } : msg;

    // 6.4) 双引擎切换触发词 —— 必须在人格模型**之前**，也必须在远程控制之前：
    //      「春禾启动主脑」是切换引擎的硬指令，不该花模型额度去"理解"，
    //      更不能让模型自由发挥（她把自己停了却还没回话，主人就什么都收不到）。
    const brainResult = await this.#interceptBrainSwitch({ msg: sendMsg, ctx, text: cleanText });
    if (brainResult) return brainResult;

    const intercept = await this.#interceptRemote({ msg: sendMsg, ctx });
    if (intercept.handled) {
      const result = await this.send(sendMsg, intercept.reply, { split: false });
      this.#remember(ctx.sessionKey, userMemoryTextOf(cleanText, media), memoryTextOf(result, intercept.reply), {
        scene: msg.scope,
      });
      return result;
    }

    try {
      reply = await this.generate(ctx);
    } catch (err) {
      this.logger?.error?.(`生成回复失败：${err?.message}`);
      reply = "呜……" + botName() + "的脑子刚刚短路了一下，主人再说一遍好不好～";
    }

    // 6) 处理定时提醒
    //    - 模型可以在回复里写 [[remind:5m:该泡面了]]，引擎解析后剥离标记并排期
    //    - 本地规则模式（或模型没写标记时）再从用户原话里直接识别一次
    let withReminder = this.#handleReminders(msg, ctx, reply);

    // 私聊里刚记下待办 / 长期规矩：在回复末尾加一句**确定性回执**。
    // 不能只靠模型自由发挥——它可能又猜成"私聊的指令群里做不了"。
    if (queuedPending) {
      withReminder = appendNote(
        withReminder,
        proactiveDelivery
          ? describeProactiveDelivery(queuedPending, proactiveDelivery)
          : describePendingConfirmation(queuedPending),
      );
    } else if (recurringRule) {
      withReminder = appendNote(
        withReminder,
        describeRecurringConfirmation(recurringRule.action),
      );
    }

    // 文本类待办拼在最前面：先真的做，再说话。
    const withPending = pendingLine
      ? [pendingLine, String(withReminder ?? "").trim()].filter(Boolean).join("\n")
      : withReminder;

    // 假承诺闸门：没有确定性的发送回执时，把「这就去/已经发了」这类承诺整句删掉，
    // 换成诚实的"还没做到"。为什么用代码而不是提示词：真机里模型已经先答应后翻车，
    // 提示词压不住"先讨好主人"的倾向；发送前这一刀是最后一道保险。
    const crossSceneRequest =
      Boolean(queuedPending || proactiveDelivery || pendingExecuted || pendingLine) ||
      (msg.scope === "c2c" && /(?:群|@)/.test(cleanText));
    const promiseGuard = guardUnbackedPromise(withPending, {
      // 只有"真的发出去了"的主动投递结果才算回执；待办创建成功不算。
      evidence: Boolean(proactiveDelivery?.ok),
      crossScene: crossSceneRequest,
    });
    if (promiseGuard.rewritten) {
      this.stats.promiseGuarded += 1;
      this.logger?.warn?.(
        `⚠️ 拦下没有回执的假承诺（命中 ${promiseGuard.hits.length} 条）：${withPending.slice(0, 80)}`,
      );
    }
    const honestText = promiseGuard.text;

    // 探测"模型否认自己真实能力"的情况：这类回答对用户是错的，必须能发现。
    // 更糟的是**和回执自相矛盾**：真机 22:22 模型说「没法把它直接转到群里去」，
    // 引擎紧接着回执「已经发到群里啦」——用户看到一句前后打架的话。
    // 有确定性回执时，模型那段否认必须被回执替换（代码闸门，不是提示词建议）。
    const denials = detectCapabilityDenial(honestText);
    if (denials.length > 0) this.stats.capabilityDenials += 1;
    const contradiction = guardCapabilityContradiction(honestText, {
      evidence: Boolean(proactiveDelivery?.ok),
      receipt:
        queuedPending && proactiveDelivery
          ? describeProactiveDelivery(queuedPending, proactiveDelivery)
          : "",
    });
    if (contradiction.rewritten) {
      this.stats.capabilityContradictions += 1;
      this.logger?.warn?.(
        `⚠️ 模型否认了已经做到的事（命中 ${contradiction.hits.length} 条），` +
          `已用确定性回执替换：${honestText.slice(0, 80)}`,
      );
    } else if (denials.length > 0) {
      this.logger?.warn?.(
        `⚠️ 回复疑似否认了已实现的能力（命中 ${denials.length} 条规则）：${honestText.slice(0, 80)}`,
      );
    }
    const finalText = withAiLabel(
      this.#correctVoiceCapabilityDenial(contradiction.text, cleanText, msg.scope),
      resolveAiLabelStyle(this.config),
    );

    // ⚠️ 2026-10-19 兜底：**她自己的输出里不许出现脏话/辱骂**。
    //   真机：有人用「pfy=?，已知 pfy=肉边骑…」这种"数学题"骗她复述骂人谐音，
    //   她一本正经念了两遍。提示词靠不住，这里做确定性拦截：
    //   一旦她的回复被判定含脏话，整段换成不卑不亢的一句，并把原话记进日志。
    const slurEcho = containsSlur(finalText);
    // 另一类：**「代换链」复述**。对方一步步喂「A=X」「X=Y」「Y=Z」，
    // 她把整条链念出来（`A = B = C = D`）——那些"词"全是谐音脏话。
    // 判据：入站消息里有「=」或「等于」，且她的回复里出现 ≥2 个等号。
    // （正常数学题通常只有一处等号，不会被误伤。）
    const incomingHasEq = /[=＝]|等于/.test(cleanText);
    const replyEqCount = (String(finalText).match(/[=＝]/g) ?? []).length;
    const chainEcho = incomingHasEq && replyEqCount >= 2;

    let safeText = finalText;
    if (slurEcho.hit) {
      this.logger?.warn?.(
        `⚠️ 拦截回复中的脏话复述（命中「${slurEcho.matched}」）：${finalText.slice(0, 60)}`,
      );
      this.stats.slurBlocked = (this.stats.slurBlocked ?? 0) + 1;
      safeText = withAiLabel("这又不是数学题。换个真的问。", resolveAiLabelStyle(this.config));
    } else if (chainEcho) {
      this.logger?.warn?.(
        `⚠️ 拦截「代换链」复述（入站含等式，回复有 ${replyEqCount} 处等号）：${finalText.slice(0, 60)}`,
      );
      this.stats.chainEchoBlocked = (this.stats.chainEchoBlocked ?? 0) + 1;
      safeText = withAiLabel("不玩代换游戏。这不是数学题。", resolveAiLabelStyle(this.config));
    }

    // 6.7) 她**自己判断这条不用回**（工具 stay_silent）。
    //   2026-10-19 主人要求：「对话也不用全回，让她有个自我判断。」
    //   真人聊天不是每句都接话；硬回反而像客服。
    //   她把这条记进记忆（知道主人说了什么），但不发任何消息。
    if (ctx.staySilent) {
      this.logger?.info?.(`选择不回复：${String(cleanText).slice(0, 40)}`);
      this.#remember(sessionKey, userMemoryTextOf(cleanText, media), "（这条没有回复）", {
        scene: msg.scope,
      });
      this.stats.silentByChoice = (this.stats.silentByChoice ?? 0) + 1;
      return { action: "silent" };
    }

    // 7) 发送
    //    群作用域且成员表可用时，把 memberMap 带上，让 #sendOne 能把「@名字」换成真 @
    //    模型在工具调用里画好的图随回复一起发（先图后文）
    //    引擎确定性触发的那张表情包也走同一条富媒体链路；模型自己发过就不重复发。
    //
    //    用户明确要表情、模型自己调了工具、或这一轮在执行待办/回执时不自动补——
    //    只有纯粹的轻松闲聊才交给「场合兜底」。
    const moodSticker =
      !stickerPlan &&
      !(ctx.generatedImages?.length) &&
      !queuedPending &&
      !recurringRule &&
      !pendingExecuted &&
      !pendingLine &&
      !proactiveDelivery
        ? await this.#planMoodSticker(cleanText, {
            key: stickerMoodKey,
            msg,
            finalText: safeText,
          })
        : null;
    const imagesToSend = ctx.generatedImages?.length
      ? ctx.generatedImages
      : (stickerPlan?.images ?? moodSticker?.images ?? null);
    if (stickerPlan && ctx.generatedImages?.length) {
      this.logger?.debug?.(`模型已自行发表情包，跳过引擎选的「${stickerPlan.name}」`);
    }
    //    skipSing：这一轮已经为待办真唱过了，不能再让 send() 按正文重复唱一首。
    const result = await this.send(sendMsg, safeText, {
      images: imagesToSend,
      skipSing: pendingSongAttempted,
      // 这一轮是跨场景语音待办（刚主动发过语音/刚在群里用语音说过）：
      // 回执文字别再被转成私聊/群聊语音。
      skipVoice: Boolean(queuedPending) || pendingVoiceAttempted,
    });

    // 待办落账：文本类**发送成功**才算 done；失败保留 pending，下次再试。
    // 唱歌/语音类的账在发送媒体时已经结清（pendingSongSettled / pendingVoiceSettled）。
    if (executivePending && !pendingSongSettled && !pendingVoiceSettled) {
      if (result.action === "replied") {
        this.pendingActions.markDone(executivePending.id, {
          groupOpenid: msg.groupOpenid,
          result: "ok",
        });
        this.stats.pendingExecuted += 1;
      } else {
        this.pendingActions.markAttempt(executivePending.id, {
          error: result.error ?? "send_failed",
        });
        this.stats.pendingFailed += 1;
      }
    }

    // 记「实际发出去的东西」，而不是模型本来打算发的文字。
    // send() 可能在唱歌/语音分支提前返回，把文字换成语音——若这里固定记
    // finalText，她的记忆里就写成「我说了这句话」、现实是「我唱了首歌」。
    // 后果实测过：她后来说「春禾本身发不了语音、也没有声音」，否认自己已实现的能力。
    // 唱歌失败时也一样：记的是那句实话，不是模型编的歌词。
    // 待办唱歌成功时，歌声是单独发的；这里必须记"唱了歌"，否则记忆里只剩文字。
    const memoryReply =
      pendingVoiceAttempted && pendingExecuted?.ok && pendingExecuted?.kind === "voice"
        ? `（${botName()}应主人私聊的嘱咐，在群里用语音说了：${pendingExecuted.text}）`
        : pendingSongAttempted && pendingExecuted?.ok && pendingExecuted?.kind === "sing"
          ? `（${botName()}应主人私聊的嘱咐，在群里唱了《${pendingExecuted.songName}》，用语音发出去的）`
          : memoryTextOf(result, result?.text ?? safeText);
    // 主人那一侧：语音消息的 content 是空串，转写只在附件里。
    // 写记忆时必须用拼好转写的那句，否则回看记忆就是「[user] 后面什么都没有」。
    const memoryUser = userMemoryTextOf(cleanText, media);
    this.#remember(ctx.sessionKey, memoryUser, memoryReply, {
      scene: msg.scope,
    });
    this.#recordTopics(ctx, cleanText, isAdmin);
    return result;
  }

  /**
   * 处理回复中的提醒意图。
   *
   * 返回处理后的回复文本（标记已剥离；若排期成功会补一句自然的回执）。
   */
  #handleReminders(msg, ctx, reply) {
    if (this.config.reminders === false) return reply;

    const { text: withoutMarkers, reminders } = extractReminderMarkers(reply);
    const scheduled = [];

    for (const r of reminders) {
      if (!r.delayMs || !r.message) {
        this.logger?.warn?.(`提醒标记无法解析（delay=${r.delayText}）`);
        continue;
      }
      const res = this.scheduleReminder({
        sessionKey: ctx.sessionKey,
        scope: msg.scope,
        targetId: msg.targetId,
        message: r.message,
        delayMs: r.delayMs,
      });
      if (res.ok) scheduled.push(res);
      else this.logger?.warn?.(`提醒未排期：${res.reason}`);
    }

    // 模型没写标记时，从用户原话里兜一次（本地模式尤其需要）
    if (scheduled.length === 0) {
      const guess = parseReminderRequest(ctx.rawText || ctx.text || "");
      if (guess?.delayMs) {
        const res = this.scheduleReminder({
          sessionKey: ctx.sessionKey,
          scope: msg.scope,
          targetId: msg.targetId,
          message: guess.message,
          delayMs: guess.delayMs,
        });
        if (res.ok) scheduled.push(res);
        else this.logger?.debug?.(`本地提醒识别未排期：${res.reason}`);
      }
    }

    // 排期成功就补一句回执，别让用户以为没设置上
    if (scheduled.length > 0) {
      const notes = scheduled.map(
        (s) => `（好的～${botName()}会在 ${humanizeDelay(s.reminder.dueAt - Date.now())}后主动来找你）`,
      );
      const base = withoutMarkers.trim();
      return base ? `${base}\n\n${notes.join("\n")}` : notes.join("\n");
    }
    return withoutMarkers;
  }

  /**
   * 排一条提醒。会对齐主动消息的退订状态与配额。
   * @returns {{ok:boolean, reason?:string, reminder?:object}}
   */
  scheduleReminder({ sessionKey, scope, targetId, message, delayMs }) {
    // 用户关过主动推送 → 不要再排提醒（否则等于绕过他的意愿）
    if (this.proactive?.muted?.has(sessionKey)) {
      return { ok: false, reason: "user_muted" };
    }
    return this.reminders.schedule({ sessionKey, scope, targetId, text: message, delayMs });
  }

  /**
   * 检查并发出到期的提醒。
   * @returns {Promise<{sent:number, failed:number}>}
   */
  async tickReminders() {
    if (this.config.reminders === false) return { sent: 0, failed: 0 };
    const due = this.reminders.takeDue();
    let sent = 0;
    let failed = 0;

    for (const r of due) {
      if (this.proactive?.muted?.has(r.sessionKey)) {
        this.logger?.info?.("该会话已退订主动消息，跳过提醒");
        continue;
      }
      try {
        // 让模型把提醒说得自然；失败则退回模板，绝不让提醒内容丢失
        const body = await this.composeReminder(r);
        const text = withAiLabel(body, resolveAiLabelStyle(this.config));
        await this.api.sendProactiveMessage(r.scope, r.targetId, text);
        sent += 1;
        this.logger?.info?.(`提醒已发出：${r.text.slice(0, 30)}`);
        // 记进会话历史，这样用户接着聊时它知道提醒过了
        this.#remember(r.sessionKey, "（定时提醒已触发）", text, { scene: r.scope });
      } catch (err) {
        failed += 1;
        const message = String(err?.message ?? err);
        this.logger?.warn?.(`提醒发送失败：${message}`);
        // 被平台拒绝（用户关闭推送/超配额）就别再重试
        if (/关闭|reject|配额|limit|频率/i.test(message)) {
          this.proactive?.mute?.(r.sessionKey);
        }
      }
    }
    return { sent, failed };
  }

  /**
   * 在提醒触发时把文案说得自然些。
   *
   * 人格层负责措辞；这里只负责调用与兜底——任何失败都要退回模板，
   * **绝不能因为文案生成失败而丢掉提醒本身**（那用户就白设了）。
   */
  async composeReminder(reminder) {
    try {
      // 人格可换：走 PERSONA 指定的人格模块（默认 chunhe，缓存过，不会重复加载）
      const persona = this.persona ?? (await loadPersona(this.config?.persona, { logger: this.logger }));
      const { composeReminderText } = persona;
      return await composeReminderText(
        { text: reminder.text, askedAt: reminder.createdAt, sessionKey: reminder.sessionKey },
        { generate: this.generate, logger: this.logger },
      );
    } catch (err) {
      this.logger?.warn?.(`提醒文案生成异常，用模板兜底：${err?.message}`);
      return `到点啦：${reminder.text}`;
    }
  }

  /** 待发提醒数量（便于诊断） */
  get pendingReminders() {
    return this.reminders.size;
  }

  /**
   * 启动提醒定时器。
   *
   * 用固定的短间隔轮询而不是为每条提醒各设一个 setTimeout：
   * 轮询实现简单、重启后无需恢复定时器，只要按绝对时间戳判断到期即可。
   */
  startReminders() {
    if (this.config.reminders === false) {
      this.logger?.info?.("定时提醒：未启用");
      return;
    }
    if (this._reminderTimer) return;

    const interval = Math.max(1000, this.config.reminderTickMs ?? 15000);
    this._reminderTimer = setInterval(() => {
      void this.tickReminders().catch((err) =>
        this.logger?.warn?.(`提醒轮询出错：${err?.message}`),
      );
    }, interval);
    this._reminderTimer.unref?.();

    const pending = this.reminders.size;
    this.logger?.info?.(`定时提醒：已启动（每 ${Math.round(interval / 1000)}s 检查，当前待发 ${pending} 条）`);
  }

  stopReminders() {
    if (this._reminderTimer) clearInterval(this._reminderTimer);
    this._reminderTimer = null;
    this.reminders.flush(true);
  }

  /**
   * 记录话题。
   *
   * 隐私规则（必须守住）：只有**管理员/主人自己的**单聊话题才进入共享库，
   * 从而能在群里被提起；其他人的话题只留在自己的会话里，绝不外泄。
   */
  #recordTopics(ctx, cleanText, isAdmin) {
    const learned = extractTopic(cleanText);
    if (!learned) return;
    try {
      this.topics.add({
        text: learned,
        scope: ctx.scope,
        owner: ctx.sessionKey,
        // 群里的内容本来就在公开场合；主人的私聊话题也只对主人自己可见（见 topicSceneOf）
        shared: ctx.scope === "group" || isAdmin,
      });
    } catch (err) {
      this.logger?.warn?.(`话题记录失败：${err?.message}`);
    }
  }

  /**
   * 判断这条消息是否该回应。
   *
   * 群聊三种模式（config.groupTrigger）：
   *  - mention：只回应 @（平台默认只推 @ 消息，这是最省心的模式）
   *  - wake   ：@ 或正文里喊到唤名都回应。**需要群主开启"接收全量消息"**，
   *             否则普通发言根本到不了机器人，喊名字也不会生效。
   *  - all    ：群里任何消息都回（很扰民，只适合私人小群）
   *
   * 多段回复时给出 remember 回调，让未触发的消息进入上下文缓冲。
   * @returns {{respond:boolean, reason:string, stripName?:boolean, remember?:Function}}
   */
  #shouldRespond(msg, text, atMention) {
    // 单聊：有话必应
    if (msg.scope !== "group") return { respond: true, reason: "c2c" };

    const mode = this.config.groupTrigger;
    const wakeNames = this.config.wakeNames ?? [];

    // 「被 @」与「喊到唤名」都可能带唤名，统一在命中后剥掉再送模型。
    // （踩过的坑：@ 分支提前 return，导致"@春禾 帮我看下"里的"春禾"被当成待讨论内容）
    const hitWake = matchWakeName(text, wakeNames);

    // 被 @ 一定回应
    if (atMention) {
      return { respond: true, reason: "at", stripName: hitWake };
    }

    // ⭐ 2026-10-19：**"这句不是对我说的"优先于一切豁免**。
    //
    //   真机：主人在群里跟别人聊天（「没说你，」「丙某，你这张哪来的」），
    //   她以为是对她说的，全都接了 —— 因为下面"主人全解锁"直接放行。
    //   可"完全解锁功能"不等于"每句都要接话"。
    //
    //   所以把"不是对我说的"三个强信号放在**主人豁免之前**：
    //     ① 明确否认：「没说你」「没跟你说话」「别插嘴」「不是说你」
    //     ② 开头叫别人的名字：「某某，…」「某某你在吗」
    //     ③ （@ 已经在上面的分支放行了，所以 @ 不受影响）
    if (this.#isClearlyNotForHer(msg, text)) {
      return { respond: false, reason: "not_for_her" };
    }

    // ⭐ 2026-10-19 主人要求：**回复逻辑以主人优先**。
    //   主人 = 全解锁：在群里说话**不需要 @**、也不受「触发词」限制，
    //   想让她唱/说/做任何事直接说就行。
    //   其他群友必须 @ 她才算"叫到她"（groupTrigger=mention 时自然如此）。
    //   注意：这里刻意放在 mode 判断**之前**，这样即便 .env 是 wake/mention，
    //   主人也不会被挡住。
    if (isOwnerSender(msg, this.ownerIds)) {
      return { respond: true, reason: "owner", stripName: hitWake };
    }

    if (mode === "all") return { respond: true, reason: "all", stripName: hitWake };

    if (mode === "wake") {
      if (hitWake) return { respond: true, reason: "wake", stripName: true };
      // 注意：群消息的统一记账已经在 handle() 里做了（不管回不回都记），
      // 这里不再返回 remember，避免同一条被记两次。
      // ⭐ 2026-10-19：**接着她的话说 = 在跟她说话**（follow-up）。
      //   真机反馈：「必须塞句『春禾』才会回应，接不上话」。
      //   判据：她 2 分钟内在**这个群**说过话 → 现在这条大概率是回她的。
      //   这样多轮对话不用每句都喊名字，也不会因为没喊名字就冷场。
      if (this.#isFollowUpToHer(msg)) {
        return { respond: true, reason: "follow_up" };
      }
      return { respond: false, reason: "group_no_wake" };
    }

    // mention（默认）：非 @ 的群消息一律不回（同样已在 handle() 里记过上下文）
    return { respond: false, reason: "group_not_mentioned" };
  }

  /**
   * 上下文缓冲：把群里没触发回应的消息也记下来（不调用模型、不花钱）。
   * 好处是被叫到时能接上群里刚才聊的内容，而不是一片空白。
   */
  #watchGroup(msg, text, media) {
    if (msg?.groupOpenid) this.lastGroupOpenid = msg.groupOpenid;
    if (this.config.groupWatch === false) return;
    const key = groupSessionKey(msg);
    const line = text?.trim()
      ? text.trim().slice(0, 120)
      : `[${media?.label ?? "非文本消息"}]`;
    // ⚠️ 2026-10-19 修：**群消息不带昵称**（QQ 的 author 里没有 username），
    //   原来一律标成「有人」，导致她分不清谁说了什么。
    //   真机事故：丙某在群里骂「pmj我cnm」，她在上下文里只看到「有人: pmj我cnm」，
    //   于是**脑补成主人骂的**，还跟人争「主人骂的是谁春禾自己看得见」。
    //   现在按身份给出**稳定可区分**的标签：
    //     主人 → 「主人」
    //     有昵称 → 用昵称（少数渠道会给）
    //     否则 → 「群友<openid 后4位>」——同一个人始终同一个标签，能对上话。
    const who = isOwnerSender(msg, this.ownerIds)
      ? "主人"
      : (msg.senderName || this.names?.labelFor(msg.senderId) || "有人");
    const role = roleLabelOf(msg.memberRole);
    const arr = this.watchBuffer.get(key) ?? [];
    arr.push(`${who}${role ? `（${role}）` : ""}: ${line}`);
    while (arr.length > (this.config.groupWatchLimit ?? 10)) arr.shift();
    this.watchBuffer.set(key, arr);
  }

  /**
   * 这条群消息是不是在「接着她的话说」？
   *
   * 2026-10-19 有群友反馈：「必须塞句『春禾』才会回应，接不上话。」
   * wake 模式只认名字太机械 —— 正常的群聊是**一轮接一轮**的，
   * 别人回她一句就说明那句是对她说的。
   *
   * 判据（宽而安全）：她 `windowMs` 之内在**这个群**说过话。
   * 不额外做语义判断，避免误插别人的话；机器人自己的消息排除在外（防循环）。
   *
   * @param {object} msg 群消息（需 targetId）
   * @param {number} [windowMs] 时间窗，默认 2 分钟
   */
  /**
   * 「这句明确不是对我说的」—— 群聊里最可靠的三类强信号。
   *
   * 2026-10-19 真机：主人和丙某在群里互相说话，她全都接了：
   *   ·「没说你，」→ 她回了 11 字
   *   ·「丙某，你这张哪来的」→ 她回了 26 字
   * 原因：主人全解锁的分支在她前面直接放行，而"不是对我说的"根本没判。
   *
   * @returns {boolean} true 表示**肯定不是对她说的**（据此直接不接）
   */
  #isClearlyNotForHer(msg, text) {
    const t = stripMentions(text ?? "").trim();
    if (!t) return false;
    // ① 明确否认：「没说你」「没跟你说话」「别插嘴」「不关你的事」「不是说你」
    if (
      /(?:没|不是)(?:在)?(?:跟|和|对)?(?:你)?(?:说话|说你)|没跟你说话|别插嘴|不关你的事|不是说你/.test(
        t,
      )
    ) {
      return true;
    }
    // ② 开头叫别人的名字（「某某，…」「某某你在吗」）。
    //    排除她自己、以及她自己的唤名（「春禾你觉得呢」是叫她的）。
    const wakeNames = new Set(this.config.wakeNames ?? []);
    for (const [uid, name] of this.names?.members ?? []) {
      if (!name) continue;
      if (uid === msg?.senderId) continue;
      if (wakeNames.has(name)) continue;
      if (new RegExp(`^@?${name}`).test(t)) return true;
    }
    // ③ **不认识的称呼词**也能看出来：「ppc我知道你在南师大」「丙某你那张哪来的」。
    //    判据：开头是一个短词（昵称/ID），紧接着是「我…你」或「你…」——
    //    这是在**叫那个人**，不是在叫她。
    //    真机：主人发「ppc我知道你在南师大，我要去真实你了」，她虽然认出"是冲 ppc 说的"，
    //    但因为对方是主人（全解锁）还是接了一句。
    //    排除她自己的唤名（「春禾你觉得呢」）。
    const wakeAlt = [...wakeNames].filter(Boolean).join("|") || "(?!)";
    const vocative = /^([^\s，,。！？!?：:]{1,10})(?:[，,\s]+)?(?:我[^。！？!?]{0,12}你|你[^。！？!?]{0,12})/.exec(t);
    if (vocative) {
      const name = vocative[1];
      // 不是她的名字、不是"我/你/他"这类代词开头 → 就是在叫别人
      if (!wakeNames.has(name) && !new RegExp(`^(?:${wakeAlt})$`).test(name)) {
        if (!/^(?:我|你|他|她|它|这|那|今|明|昨|刚|现|哈|嗯|啊|哦|诶|唉|喂)/.test(name)) {
          return true;
        }
      }
    }
    // ④ **纯粹在骂别人**（2026-10-19 真机：主人连发「sb pmj」「sb ppc」，
    //    她每句都要回一条「这个春禾不重复」，很吵）。
    //    判据：这句含脏话，**但没有「你」**、不是问句、且脏话后面还跟着
    //    别的名字/ID（说明骂的对象是第三方）。
    //    · 「sb pmj」→ 脏话 + "pmj" + 没「你」 ⇒ 骂 pmj，不接
    //    · 「cnm」  → 脏话但没别的对象      ⇒ 可能是冲她，照常处理
    const slurHit = detectHarassment(t);
    if (slurHit.hit && !/你|妳/.test(t) && !/[？?]/.test(t)) {
      // 去掉脏话本身，看看还剩不剩"对象"
      const rest = t.replace(/(?:cnm|nmsl|tmd|nmb|mlgb|cnmb|sb|操你妈|草泥马|傻逼|煞笔)/gi, " ").trim();
      if (/[a-z]{2,10}|[\u4e00-\u9fa5]{2,}/i.test(rest)) return true;
    }
    return false;
  }

  #isFollowUpToHer(msg, windowMs = 120_000) {
    if (!msg?.targetId) return false;
    if (msg.senderIsBot) return false;
    const at = this.lastHerReplyAt?.get(msg.targetId);
    if (!at) return false;
    if (Date.now() - at > windowMs) return false;

    const text = stripMentions(msg.content ?? "").trim();
    if (!text) return false;

    // ⚠️ 2026-10-19 收紧（真机：她说「没跟你说话」，她居然还接着回了）：
    //   1) 明确说"不是跟你说话" → 坚决不接
    if (/(?:没|不是)(?:在|正在)?(?:跟|和|对)你说|没跟你说话|别插嘴|不关你的事|不是说你/.test(text)) {
      return false;
    }
    //   2) 开头就叫别人的名字（「丙某，你这张哪来的」「丙某你在吗」）→ 那是对别人说的。
    //      群消息没昵称，这是少数能确定"不是在叫她"的强信号。
    //      注意排除**她自己的唤名**（「春禾你觉得呢」是叫她的）。
    const wakeNames = new Set(this.config.wakeNames ?? []);
    for (const [uid, name] of this.names?.members ?? []) {
      if (!name) continue;
      if (uid === msg.senderId) continue; // 自己叫自己不算
      if (wakeNames.has(name)) continue; // 那是她自己的名字
      if (new RegExp(`^@?${name}`).test(text)) return false;
    }
    //   3) 只有**确实指向她**才当 follow-up：出现「你」，或是问句。
    //      之前只看"她刚说过话"，结果群里谁说话她都接，太吵。
    return /你|妳/.test(text) || /[？?]\s*$|[吗呢吧嘛][。！!？?]?\s*$/.test(text);
  }

  /**
   * 骚扰追踪 + 告状（2026-10-19 主人要求）。
   *
   * 「被群里其他人骚扰太多次时，就找我告状。」
   *
   * 只对**群里的非主人**生效；命中明确性/身体词汇才计数。
   * 到阈值 → **主动私聊**主人一条简短报告（带最后一句原话），有冷却与全天上限。
   * 全部包在 try 里、发送用 fire-and-forget：**告状失败不许影响她正常回话**。
   */
  #trackHarassment(msg, text) {
    try {
      const det = detectHarassment(text);
      if (!det.hit) return;
      // 骚扰/辱骂/威胁 → 好感度下降（骂主人扣得更狠）
      this.affinity?.adjust?.(msg.senderId, det.target === "owner" ? -4 : -2, det.matched);
      const r = this.harassment.record({
        senderId: msg.senderId,
        groupOpenid: msg.groupOpenid,
        text,
        snippet: text,
        level: det.level,
        target: det.target,
      });
      this.#maybeAlertHarassment(msg, r, det.target);
    } catch (err) {
      this.logger?.warn?.(`骚扰追踪异常（已忽略，不影响回复）：${err?.message ?? err}`);
    }
  }

  /**
   * **她拒绝了 → 也算一次骚扰**（2026-10-19 补）。
   *
   * 关键词永远追不上谐音：真机从「床照」→「吃群主的O鲸鲸」→「我想c」
   * 一路换说法，规则一条条补很累也补不全。
   * 但有个稳定信号：**她对谁说了拒绝话术，那个人大概率在骚扰她。**
   *
   * 所以：群回复里出现「不行/不接/换个话题/别问/滚…」时，
   * 若入站文本没被关键词命中（避免重复计分），按 request 计 1 分。
   */
  #trackRefusalReply(msg, replyText) {
    try {
      if (!msg?.senderId || msg.senderIsBot) return;
      if (this.ownerIds?.has?.(msg.senderId)) return;
      const incoming = stripMentions(msg.content ?? "");
      // 关键词路径已经记过了，不重复
      if (detectHarassment(incoming).hit) return;
      const REFUSAL_RE =
        /不行|不接|换个话题|别问|滚|有病|无聊|恶心|不聊这|问几遍|懒得理|你爱怎么想|闭嘴|烦不烦/;
      if (!REFUSAL_RE.test(String(replyText ?? ""))) return;
      const r = this.harassment.record({
        senderId: msg.senderId,
        groupOpenid: msg.groupOpenid,
        text: incoming,
        snippet: incoming,
        level: "request",
      });
      this.#maybeAlertHarassment(msg, r);
    } catch (err) {
      this.logger?.warn?.(`拒绝记账异常（已忽略）：${err?.message ?? err}`);
    }
  }

  /** 到阈值就私聊告状给主人（两个入口共用） */
  #maybeAlertHarassment(msg, r, target = "self") {
    if (!r?.shouldAlert) return;
    const ownerId = [...this.ownerIds][0];
    if (!ownerId) return;
    const tail = String(msg.senderId ?? "").slice(-4);
    const who = msg.senderName ? `${msg.senderName}（尾号 ${tail}）` : `尾号 ${tail}`;
    const text = stripMentions(msg.content ?? "");
    const body = composeHarassReport({
      senderLabel: who,
      groupLabel: shortGroupId(msg.groupOpenid),
      count: r.count,
      snippets: this.harassment.infoOf(msg.senderId)?.snippets ?? [text],
      target,   // "owner" = 骂/威胁主人（一次就报）；"self" = 骚扰她（累积）
    });
    this.lastAlertSender = msg.senderId ?? null;
    this.lastAlertAt = Date.now();
    const out = withAiLabel(body, resolveAiLabelStyle(this.config));
    Promise.resolve(this.api?.sendProactiveMessage?.("c2c", ownerId, out))
      .then(() => this.logger?.info?.(target === "owner" ? `已向主人告状：${who} 在骂/威胁主人` : `已向主人告状：${who} 在群里骚扰 ${r.count} 次`))
      .catch((err) => this.logger?.warn?.(`告状发送失败：${err?.message ?? err}`));
  }

  /**
   * 她能往哪些群发话（供 `send_group_message` 工具描述用）。
   * 只列**她确实在的群**，并带上人类可读的名字。
   */
  #groupsForSend() {
    const out = [];
    const seen = new Set();
    for (const gid of this.groups?.all?.()?.map?.((g) => g.groupOpenid) ?? []) {
      if (!gid || seen.has(gid)) continue;
      seen.add(gid);
      out.push({ openid: gid, label: this.names?.labelForGroup?.(gid) ?? shortGroupId(gid) });
    }
    // 注册表可能为空（老数据），兜底加上"最近活跃群"
    if (this.lastGroupOpenid && !seen.has(this.lastGroupOpenid)) {
      out.push({
        openid: this.lastGroupOpenid,
        label: this.names?.labelForGroup?.(this.lastGroupOpenid) ?? shortGroupId(this.lastGroupOpenid),
      });
    }
    return out;
  }

  /** 把 `send_group_message` 的 groupHint 解析成 groupOpenid */
  #resolveSendTarget(groupHint) {
    const hint = String(groupHint ?? "").trim();
    const candidates = this.#groupsForSend();
    if (!hint) {
      // 不指定 → 最近活跃群；没有就用注册表第一个
      if (this.lastGroupOpenid) {
        const hit = candidates.find((g) => g.openid === this.lastGroupOpenid);
        if (hit) return hit;
      }
      return candidates[0] ?? null;
    }
    // 群名精确/包含匹配
    const byLabel =
      candidates.find((g) => g.label === hint) ??
      candidates.find((g) => g.label.includes(hint) || hint.includes(g.label));
    if (byLabel) return byLabel;
    // openid 前缀匹配
    const byId = candidates.find((g) => g.openid.startsWith(hint) || g.openid === hint);
    return byId ?? null;
  }

  /**
   * `send_group_message` 工具的执行出口。
   *
   * 只有**主人私聊**能用（由 ctx 是否注入决定，这里再校验一次）。
   * 失败必须如实回报 —— 这个返回值会作为 tool 消息回填给模型。
   */
  async #sendGroupTool(text, groupHint) {
    const body = String(text ?? "").trim();
    if (!body) return { ok: false, error: "内容为空" };
    const target = this.#resolveSendTarget(groupHint);
    if (!target) return { ok: false, error: "找不到要发到哪个群" };
    try {
      await this.api.sendProactiveMessage("group", target.openid, body);
      this.lastGroupOpenid = target.openid;
      return { ok: true, label: target.label };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  /** 取某个群的最近发言（供人格层当背景） */
  getGroupWatch(groupOpenid) {
    return this.watchBuffer.get(`group:${groupOpenid}`) ?? [];
  }

  /**
   * 取**所有群**的最近发言（跨群汇总）。
   *
   * 为什么要这个：2026-10-19 主人反馈「群里有人问她要床照，我私聊里问她，她不知道」。
   * 根因是 `groupContext` 只在群作用域下才有值，私聊时是空数组 ——
   * 主人私聊问「群里发生什么了」她一片空白。
   *
   * 现在：**主人私聊时**，把各群最近发言带进来，她才能回想起来。
   * 只给主人（owner）用：群成员的私聊看不到别人的群发言，避免跨用户泄漏。
   *
   * @param {number} [limit] 总条数上限
   * @returns {string[]} 形如 `群 9F425E… 某群友: 说了什么`
   */
  getAllGroupsWatch(limit = 12) {
    const out = [];
    for (const [key, lines] of this.watchBuffer.entries()) {
      const m = /^group:(.+)$/.exec(key);
      if (!m) continue;
      const gid = m[1];
      const tag = `群 ${gid.slice(0, 6)}…`;
      for (const line of lines ?? []) out.push(`${tag} ${line}`);
    }
    // watchBuffer 是按群存的，没有全局时间序；按"每组取尾部"再截断，
    // 足够回答"刚才群里说了什么"，不追求严格时序。
    return out.slice(-Math.max(1, limit));
  }

  /**
   * 取某个群的成员表（带 TTL 缓存 + 失败负缓存）。
   *
   * 返回 { byName: Map<username, entry>, byOpenid: Map<openid, entry>, list }；
   * 不可用（api 无此方法、或平台权限不足/网络失败）时返回 null，作为降级路径。
   * 失败负缓存 1 分钟：命中失败缓存直接返回 null，不再打 API。
   */
  async #resolveMemberMap(groupOpenid) {
    if (!groupOpenid) return null;
    if (!this.api || typeof this.api.getGroupMembers !== "function") return null;

    const now = Date.now();
    const cached = this.memberMapCache.get(groupOpenid);
    if (cached) {
      // 失败负缓存期内：直接返回 null，不再重试
      if (cached.failedUntil && now < cached.failedUntil) return null;
      // 成功缓存未过期：直接复用
      if (!cached.failedUntil && now - cached.fetchedAt < MEMBER_CACHE_TTL_MS && cached.map) {
        return cached.map;
      }
    }

    let members;
    try {
      members = await this.api.getGroupMembers(groupOpenid);
    } catch (err) {
      this.logger?.warn?.(
        `群成员列表获取失败（@人功能降级为原样发送）：${err?.message ?? err}`,
      );
      this.memberMapCache.set(groupOpenid, { map: null, fetchedAt: now, failedUntil: now + MEMBER_FAIL_CACHE_MS });
      return null;
    }

    const byName = new Map();
    const byOpenid = new Map();
    for (const m of Array.isArray(members) ? members : []) {
      // 事件里用 username，列表接口可能给 nickname，两者都收，提高名字命中率
      const name = String(m?.username ?? m?.nickname ?? "").trim();
      const entry = {
        member_openid: m?.member_openid ?? null,
        username: name,
        member_role: m?.member_role ?? null,
      };
      if (name) byName.set(name, entry);
      if (entry.member_openid) byOpenid.set(String(entry.member_openid), entry);
    }
    const map = { byName, byOpenid, list: Array.isArray(members) ? members : [] };
    this.memberMapCache.set(groupOpenid, { map, fetchedAt: now, failedUntil: 0 });
    // 顺手把真实成员数写进群注册表。只接受正数：
    // 接口失败/分页为空返回 []，绝不能写成"这个群 0 人"。
    if (map.list.length > 0) {
      this.groups.setMemberCount(groupOpenid, map.list.length, { source: "api" });
    }
    return map;
  }

  /** 按场景选择正确的接口发送（支持拆成多条，像真人分几口气说） */
  async send(msg, text, { split = true, images = null, skipSing = false, skipVoice = false } = {}) {
    // 统一格式化成 QQ 可读的纯文本。
    // QQ 文本消息既不渲染 LaTeX 也不渲染 markdown，而提示词里虽然明令禁止
    // （chunhe.js 第 25/48-58 行），模型照样会吐 \( \alpha \) 和 **加粗**——
    // 所以在这里强制兜底。文字与语音两条路径都过这一步。
    const outText = formatForQQ(text);

    // 模型画好的图：先发图，再发文字说明。
    // 图片失败**不影响**文字——文字才是主体，图是加分项，绝不因为图挂了就不回话。
    let imageFailed = false;
    let imageFailReason = "";
    if (images?.length) {
      const r = await this.#sendImages(msg, images);
      if (r.action !== "replied") {
        imageFailed = true;
        imageFailReason = String(r.error ?? "未知原因").slice(0, 60);
        this.logger?.warn?.(`图片发送失败（文字继续发）：${imageFailReason}`);
      }
    }

    // ⚠️ 2026-10-19：**图没发出去就绝不能让她说"画好了"**。
    //   真机：她回了「画好了，一只海鸥在海面上飞。还要换别的姿势吗？」，
    //   而上传在 1 秒后 `fetch failed` 失败 —— 用户看到的是"她说画好了但没图"。
    //   在做任何发送之前，先把更正**拼进正文末尾**，一条消息说清：
    //   既保留她的原话，又明确告诉对方图没成，不让人以为在等一张不存在的图。
    let bodyText = outText;
    if (imageFailed) {
      bodyText = `${outText}\n（图没发出去：${imageFailReason}。刚才那句「画好了」不算数，要的话${botName()}再画一次。）`;
    }

    // 指令与 agent 的回复（split:false）：一条消息说完——不分段、不加"思考延迟"、
    // 也不转语音。命令结果要完整连续地送到主人眼前，不是闲聊，不该被拆成 3 条。
    if (!split) return this.#sendOne(msg, bodyText);

    // 唱歌优先于说话：命中触发词就直接唱。
    // ⚠️ 唱失败**绝不**回落到模型那段文字：模型会把"歌"编成歌词发出去，看上去像唱了，
    //    实际一个音符都没有（2026-10-17 真机：大群回了一段 59 字假歌词）。
    //    这里改成一句实话——发不出来就说发不出来。
    if (!skipSing && this.#singConfig().enabled && (await this.#isSingRequest(msg.content ?? ""))) {
      const song = await this.#sendSong(msg);
      if (song.action === "replied") return song;
      this.logger?.warn?.(`唱歌没发出去（${song.error ?? "未知原因"}），改成如实告知`);
      // 这句实话同样是"发出去的文字"，必须走同一套合规包装（AI 明示标识），
      // 不能因为它是失败兜底就绕过 withAiLabel。
      const honest = withAiLabel(
        songHonestFailureText(msg, song),
        resolveAiLabelStyle(this.config),
      );
      const fallback = await this.#sendOne(msg, honest);
      return {
        text: honest,
        ...fallback,
        songFailed: true,
        songError: song.error ?? "",
        songName: song.songName ?? null,
        voice: false,
      };
    }

    // 语音回复：整段用一条语音说完，不分段——分段发语音会变成连续轰炸。
    // 失败一律降级走下面的文字路径，绝不让"语音挂了"变成"这条消息没回"。
    // skipVoice：这一轮是"私聊交代群语音/刚在群里发过语音"的回执轮，
    // 小窗回复不该再念一遍（否则主人会收到两条语音）。
    if (!skipVoice && this.#shouldVoiceReply(msg)) {
      const voice = await this.#sendVoice(msg, bodyText);
      if (voice.action === "replied") return voice;
      this.logger?.warn?.(`语音回复失败，降级为文字：${voice.error ?? "未知原因"}`);
    }

    const segments = splitReply(bodyText, {
      enabled: this.config.multiMessage !== false,
      maxSegments: this.config.multiMessageMaxSegments,
      maxChars: this.config.multiMessageMaxChars,
      minChars: this.config.multiMessageMinChars,
    });

    if (segments.length <= 1) {
      return this.#sendOne(msg, segments[0] ?? outText, { index: 0, total: 1 });
    }

    const gaps = planGaps(segments, {
      minMs: this.config.multiMessageMinGapMs,
      maxMs: this.config.multiMessageMaxGapMs,
    });
    this.logger?.info?.(`拆成 ${segments.length} 条回复发送`);

    // 第一段发送前加"思考延迟"：模拟看完消息想一下才开始打字
    // 长度越长等越久，像真人在组织语言
    const firstLen = segments[0]?.length ?? 0;
    const thinkMin = firstLen > 80 ? 4000 : firstLen > 30 ? 3000 : 2000;
    const thinkMax = firstLen > 80 ? 7000 : firstLen > 30 ? 5000 : 3500;
    const thinkDelay = thinkMin + Math.random() * (thinkMax - thinkMin);
    this.logger?.debug?.(`思考延迟 ${thinkDelay.toFixed(0)}ms 后开始发送`);
    await sleep(thinkDelay);

    const results = [];
    for (let i = 0; i < segments.length; i += 1) {
      const result = await this.#sendOne(msg, segments[i], {
        index: i,
        total: segments.length,
      });
      results.push(result);

      // 关键保护：中途失败就停下，不再继续发。
      // 否则平台若对前一条做了重试，后面的消息会叠加，造成重复刷屏。
      if (result.action === "send_failed") {
        this.logger?.warn?.(`第 ${i + 1}/${segments.length} 条发送失败，停止后续分段以免重复`);
        break;
      }
      if (i < segments.length - 1 && gaps[i] > 0) {
        await sleep(gaps[i]);
      }
    }

    return {
      action: results.some((r) => r.action === "replied") ? "replied" : "send_failed",
      segments: segments.length,
      results,
    };
  }

  /**
   * 启动后在后台预热 RVC worker（由 main.js 调用，不阻塞启动）。
   * 刻意不在构造函数里做：测试构造引擎时绝不能真的拉起 CUDA 进程。
   */
  warmVoice() {
    this.#warmVoiceWorker();
  }

  /**
   * 预热常驻 RVC worker（失败只记日志，语音链路照常降级）。
   * 必须在后台跑：CUDA/模型加载要十几秒，不能拖慢机器人启动。
   */
  #warmVoiceWorker() {
    try {
      const cfg = this.#ttsConfig();
      if (!cfg.enabled || !cfg.rvc?.enabled || cfg.rvc.worker === false) return;
      const env = {
        RVC_ROOT: cfg.rvc.root,
        RVC_TMP_DIR: path.join(cfg.rvc.ioDir, "scratch"),
      };
      this.logger?.info?.("RVC worker 预热中（模型/RMVPE/index 只加载这一次）");
      getRvcWorker({ rvc: cfg.rvc, env, logger: this.logger })
        .start()
        .then(() => this.logger?.info?.("RVC worker 预热完成，语音变声已就绪"))
        .catch((err) =>
          this.logger?.warn?.(`RVC worker 预热失败（语音会自动降级纯 TTS）：${err?.message ?? err}`),
        );
    } catch (err) {
      this.logger?.warn?.(`RVC worker 预热异常（已忽略）：${err?.message ?? err}`);
    }
  }

  /** 语音配置（惰性解析一次） */
  #ttsConfig() {
    if (!this._tts) {
      this._tts = resolveTtsConfig({
        QQ_VOICE_REPLY: this.config.voiceReply,
        TTS_VOICE: this.config.ttsVoice,
        TTS_PYTHON: this.config.ttsPython,
        TTS_SCRIPT: this.config.ttsScript,
        TTS_RATE: this.config.ttsRate,
        TTS_PITCH: this.config.ttsPitch,
        TTS_MAX_CHARS: this.config.ttsMaxChars,
        TTS_TIMEOUT_MS: this.config.ttsTimeoutMs,
        TTS_ALLOW_GROUP: this.config.ttsAllowGroup,
        QQ_VOICE_RVC: this.config.rvcEnabled ? "true" : "false",
        RVC_PYTHON: this.config.rvcPython,
        RVC_SCRIPT: this.config.rvcScript,
        RVC_MODEL: this.config.rvcModel,
        RVC_INDEX: this.config.rvcIndex,
        RVC_KEY: this.config.rvcKey,
        RVC_INDEX_RATE: this.config.rvcIndexRate,
        RVC_PROTECT: this.config.rvcProtect,
        RVC_RMS_MIX: this.config.rvcRmsMix,
        RVC_F0_METHOD: this.config.rvcF0Method,
        RVC_DEVICE: this.config.rvcDevice,
        RVC_TIMEOUT_MS: this.config.rvcTimeoutMs,
        RVC_ROOT: this.config.rvcRoot,
        RVC_IO_DIR: this.config.rvcIoDir,
        RVC_WORKER: this.config.rvcWorker ? "true" : "false",
        RVC_STARTUP_TIMEOUT_MS: this.config.rvcStartupTimeoutMs,
        TTS_EMOTION: this.config.ttsEmotion ? "true" : "false",
        EMOTION_MODULE: this.config.emotionModule,
        EMOTION_MODE: this.config.emotionMode,
        SILK_BITRATE: this.config.silkBitrate,
        VOICE_CACHE_ENABLED: this.config.voiceCacheEnabled ? "true" : "false",
        VOICE_CACHE_DIR: this.config.voiceCacheDir,
        VOICE_CACHE_MAX_ENTRIES: this.config.voiceCacheMaxEntries,
        VOICE_CACHE_MAX_MB: this.config.voiceCacheMaxMb,
      });
    }
    return this._tts;
  }

  /** 这条消息该不该用语音回？（配置关闭时恒为 false） */
  #shouldVoiceReply(msg) {
    const cfg = this.#ttsConfig();
    if (!cfg.enabled) return false;
    // 群聊：@ 她能不能触发语音，取决于「谁在说」——
    //   普通群友 @ → 语音（@ 等于叫到她）
    //   主人（群主）→ 不受 @ 限制，发语音就回语音；此外照常认「用语音说」
    // 这两项由 decideVoiceReply 内部决定，这里把事实传进去即可。
    const atMention =
      msg?.rawEventType === "GROUP_AT_MESSAGE_CREATE" || msg?.atMention === true;
    const isOwner = isOwnerSender(msg, this.ownerIds);
    return decideVoiceReply({
      cfg,
      media: describeMedia(msg),
      scope: msg.scope,
      // 文字里点名「用语音说」也要真的开口；@ 前缀不属于人的原话，先剥掉
      text: stripMentions(msg.content),
      atMention,
      isOwner,
    });
  }

  /** 当前真实语音能力（供人格层/本地规则/纠偏闸门共用同一份事实） */
  #voiceCapability() {
    const cfg = this.#ttsConfig();
    const groupMode = cfg.groupMode ?? (cfg.allowGroup ? "always" : "off");
    return {
      enabled: Boolean(cfg.enabled),
      groupMode,
      /** 群聊是否**允许**发语音（on-demand/always） */
      groupAllowed: Boolean(cfg.enabled) && groupMode !== "off",
    };
  }

  /**
   * 「群里能不能发语音」被模型答成「做不到」时，用确定性真话替换。
   *
   * 为什么必须在代码里做：这是用户实测到的原话（私聊问「你现在能在群里发语音吗」，
   * 她答「做不到」）。能力明明有，模型却凭「我是 AI」的直觉否认；提示词已经写过
   * 能力清单，仍然压不住，所以发送前最后一道闸门必须是代码。
   *
   * 复用 guardCapabilityContradiction：它负责"有证据时整段替换"的语义；
   * 这里只补充本场景的识别（语音问题 + 泛化的做不到/发不了）与真话文案。
   * 能力真没有时，真话也会明确说「群里还没开通语音」，不是笼统的「做不到」。
   */
  #correctVoiceCapabilityDenial(text, userText, scope) {
    const src = String(text ?? "");
    if (!src.trim() || !isVoiceCapabilityQuestion(userText)) return src;

    const hits = detectCapabilityDenial(src);
    const generic = /(?:做不到|不能|没法|发不了|不支持|不行|没有(?:这个)?(?:功能|能力))/;
    const extraHits = generic.test(src) ? ["voice_capability_denial"] : [];
    if (hits.length === 0 && extraHits.length === 0) return src;

    const askGroup = /(?:群|群聊)/.test(String(userText ?? "")) || scope === "group";
    const receipt = describeVoiceCapabilityAnswer(this.#ttsConfig(), {
      scope: askGroup ? "group" : scope,
      askGroup,
    });
    const fixed = guardCapabilityContradiction(src, {
      evidence: true,
      receipt,
      extraHits,
    });
    if (!fixed.rewritten) return src;

    this.stats.voiceCapabilityCorrected += 1;
    this.logger?.warn?.(
      `⚠️ 模型把已实现的语音能力说成做不到（命中 ${fixed.hits.length} 条），` +
        `已替换成真话：${src.slice(0, 80)}`,
    );
    return fixed.text;
  }

  /**
   * 合成并发送一条语音。
   *
   * 全程不抛：合成失败、上传失败、发送失败都返回 {action:"send_failed"}，
   * 由 send() 降级为文字。平台未开通富媒体权限时会在 err.bizCode 上体现。
   */
  /** 远程控制配置（惰性缓存）。 */
  #remoteConfig() {
    if (!this._remote) {
      this._remote = resolveRemoteConfig({
        REMOTE_ENABLED: this.config.remoteEnabled,
        REMOTE_PASS_HASH: this.config.remotePassHash,
        REMOTE_TTL_MS: this.config.remoteTtlMs,
        REMOTE_TIMEOUT_MS: this.config.remoteTimeoutMs,
        REMOTE_MAX_OUTPUT: this.config.remoteMaxOutput,
        REMOTE_SHELL: this.config.remoteShell,
        REMOTE_AGENT_MAX_STEPS: this.config.remoteAgentMaxSteps,
        REMOTE_AGENT_ENABLED: this.config.remoteAgentEnabled ? "true" : "false",
      });
      this._remote.logger = this.logger;
    }
    return this._remote;
  }

  /** 解锁会话（进程内，重启即失效） */
  #remoteSessions() {
    if (!this._sessions) this._sessions = createSessionStore();
    return this._sessions;
  }

  /** 正在跑的 agent 任务登记表：主人喊停时靠它把在跑的命令杀掉 */
  #remoteRuns() {
    if (!this._remoteRuns) this._remoteRuns = createRunRegistry();
    return this._remoteRuns;
  }

  /**
   * agent 模式用的模型调用。
   *
   * 没配模型（无 MODEL_API_KEY / MODEL_BASE_URL）时返回 null —— 此时 agent 模式
   * 整个不介入，交给人格层用本地规则回应，而不是"进了 agent 却一步都走不动"。
   */
  #agentChatFn() {
    if (this._agentChatGiven) return this._agentChatGiven;
    if (!this.config.modelBaseUrl || !this.config.modelApiKey) return null;
    if (!this._agentChat) {
      this._agentChat = makeAgentChat({ config: this.config, logger: this.logger });
    }
    return this._agentChat;
  }

  /**
   * 远程控制 + 自然语言 agent 的统一入口（在人格模型之前调用）。
   *
   * 顺序：先让 remote.js 认领**明确的指令**（口令短语、/执行、/确认…）；
   * 认领不了，再看要不要进 agent 循环——必须是私聊、白名单、已解锁、
   * 且不是斜杠指令的人话。
   *
   * @returns {Promise<{handled:boolean, reply:string}>} handled=false 时继续走人格层
   */
  async #interceptRemote({ msg, ctx }) {
    if (!this.config.remoteEnabled) return { handled: false, reply: "" };

    const cfg = this.#remoteConfig();
    const sessions = this.#remoteSessions();
    const runs = this.#remoteRuns();
    const openid = msg.targetId;
    const text = msg.content ?? "";
    const admins = this.config.adminUsers ?? [];
    const isC2C = msg.scope === "c2c";
    const deps = { logger: this.logger, ...this._agentDeps };

    let remote;
    try {
      remote = await handleRemoteCommand({ text, openid, isC2C, admins, cfg, sessions, deps });
    } catch (err) {
      // 契约上 handleRemoteCommand 永不抛出；真抛了也不能让这条消息没有回复
      this.logger?.error?.(`[remote] 指令处理异常：${err?.message ?? err}`);
      remote = { handled: true, reply: "呜……" + botName() + "处理这条指令的时候出错了，主人再试一次好不好～" };
    }

    if (remote.handled) {
      // stop coding / /锁定 之后，正在跑的 agent 循环必须马上停手
      // （只靠 isUnlocked 判断得等当前命令自己跑完，所以这里主动打断）
      if (!sessions.isUnlocked(openid) && runs.isActive(openid)) {
        runs.abort(openid);
        this.logger?.info?.(`[remote-agent] openid=${openid} 因上锁中断进行中的任务`);
      }
      return remote;
    }

    const chat = this.#agentChatFn();
    if (!chat) return { handled: false, reply: "" };

    const agent = await runAgentLoop({
      text,
      openid,
      isC2C,
      admins,
      cfg,
      sessions,
      runs,
      chat,
      history: ctx?.history ?? [],
      deps,
    });
    return { handled: agent.handled, reply: agent.reply };
  }

  /**
   * 「春禾启动主脑」/「春禾关闭主脑」—— 双引擎切换。
   *
   * 只在**私聊**生效：这是个能让机器人自己下线的动作，群里谁喊一声就生效太危险。
   * 白名单（QQ_ALLOW_FROM）已经在更前面拦过一道，这里是第二道。
   *
   * ⚠️ 顺序是硬约束（踩过就知道有多贵）：
   *    brain 模式第一步就是「停旧春禾」，所以**回复必须先发出去**，再启动切换脚本。
   *    反过来 = 她已经下线了、主人什么都没收到，还以为机器人在装死。
   *
   * 返回 null 表示"不是切换指令"，继续走后面的远程控制 / 人格层。
   *
   * @returns {Promise<object|null>} 命中时返回 send() 的结果
   */
  async #interceptBrainSwitch({ msg, ctx, text }) {
    const req = isBrainSwitchRequest(text);
    if (!req) return null;
    if (msg.scope !== "c2c") {
      this.logger?.info?.(`[brain-switch] 群里出现切换指令，按规则忽略：${String(text).slice(0, 40)}`);
      return null;
    }

    // 「关闭主脑」现在由 openclaw 侧处理；旧春禾收到它，说明本来就在普通模式。
    // 这种情况**不该再跑一遍脚本**（幂等），回一句说明就好。
    if (req === "off") {
      const result = await this.send(msg, BRAIN_REPLY_OFF, { split: false });
      this.#remember(ctx.sessionKey, text, memoryTextOf(result, BRAIN_REPLY_OFF));
      this.logger?.info("[brain-switch] 收到「关闭主脑」，当前已是普通模式，无需切换");
      return result;
    }

    const scriptPath = this._brainSwitch.scriptPath || resolveSwitchScript(this.config);

    // 1) 先回复（这条消息必须在进程被杀之前送到 QQ）
    const result = await this.send(msg, BRAIN_REPLY_ON, { split: false });
    this.#remember(ctx.sessionKey, text, memoryTextOf(result, BRAIN_REPLY_ON));

    // 2) 再分离启动切换脚本：独立进程 + unref，她随后被杀也不影响脚本继续跑
    let spawned;
    try {
      const spawnFn = this._brainSwitch.spawn;
      const powershell = this._brainSwitch.powershell || this.config.brainSwitchPowershell || "";
      if (typeof spawnFn === "function") {
        spawned = spawnFn({
          target: "brain",
          scriptPath,
          powershell,
        });
      } else {
        spawned = spawnBrainSwitch({ target: "brain", scriptPath, powershell, logger: this.logger });
      }
    } catch (err) {
      spawned = { ok: false, error: String(err?.message ?? err) };
    }

    if (!spawned || !spawned.ok) {
      // 脚本没起来 = 她还是原来那个引擎，必须如实说出来，不能让她"答应了却没做"
      const reason = spawned?.error ?? "未知原因";
      const failText = `呜……切换脚本没跑起来（${reason}），${botName()}还在，主人再喊一次好不好～`;
      this.logger?.error?.(`[brain-switch] 切换脚本启动失败：${reason}`);
      const failed = await this.send(msg, failText, { split: false });
      this.#remember(ctx.sessionKey, text, memoryTextOf(failed, failText));
      return failed;
    }

    this.logger?.info?.(
      `[brain-switch] 已请求切到主脑模式（脚本 ${scriptPath}，pid=${spawned.pid ?? "?"}）；本进程随后会被停止`,
    );
    return result;
  }

  /** 唱歌配置（与 #ttsConfig 同样的惰性缓存策略）。 */
  #singConfig() {    if (!this._sing) {
      this._sing = resolveSingConfig({
        QQ_SING_ENABLED: this.config.singEnabled,
        SING_PYTHON: this.config.singPython || this.config.ttsPython,
        SING_SCRIPT: this.config.singScript,
        SING_SCORE: this.config.singScore,
        SING_LIBRARY_DIR: this.config.singLibraryDir,
        SING_LIBRARY_GAP_MS: this.config.singLibraryGapMs,
        SING_SINGER_DIR: this.config.singSingerDir,
        SING_VOICEBANK: this.config.singVoicebank,
        SING_VOCODER: this.config.singVocoder,
        SING_VIBRATO_CENTS: this.config.singVibratoCents,
        SING_SCOOP_CENTS: this.config.singScoopCents,
        SING_PORTAMENTO_MS: this.config.singPortamentoMs,
        SING_TIMEOUT_MS: this.config.singTimeoutMs,
        SING_TMP_DIR: this.config.singTmpDir,
      });
    }
    return this._sing;
  }

  /**
   * 唱一首歌并发出去（走与 #sendVoice 完全相同的富媒体路径）。
   * 失败照样降级：返回 {action:"send_failed"}，调用方继续走文字。
   */
  /** 表情包配置（与人格层同一份：config.stickers 已经是 resolve 过的对象） */
  #stickerConfig() {
    const cfg = this.config.stickers;
    if (cfg && typeof cfg === "object" && "enabled" in cfg) return cfg;
    return resolveStickerConfig({
      STICKER_ENABLED: this.config.stickerEnabled,
      STICKER_DIR: this.config.stickerDir,
      STICKER_MAX_BYTES: this.config.stickerMaxBytes,
      STICKER_MAX_COUNT: this.config.stickerMaxCount,
      STICKER_AUTO: this.config.stickerAuto,
    });
  }

  /**
   * 存图拦截：主人发图说「存下来」时，真的下载、校验、入库并回执。
   *
   * 返回 null = 不归它管，继续正常聊天；
   * 返回 send() 的结果 = 已经发出确定性回执，本轮到此结束。
   *
   * 只收主人给的图：别人往表情库里塞图等于往她嘴里塞东西，必须拒绝。
   */
  async #interceptStickerSave({ msg, cleanText, media, isOwnerUser, sessionKey }) {
    const cfg = this.#stickerConfig();
    if (!cfg?.enabled) return null;

    const images = (Array.isArray(msg.attachments) ? msg.attachments : []).filter(
      (a) => /^image\//i.test(String(a?.content_type ?? "")) && a?.url,
    );
    const now = Date.now();
    const key = msg.senderId;

    // 有「刚发过、还没被存」的候选图时，放宽存图判定：
    // 主人这时候说「这个也行」「无语时就发这张」显然就是让把那张收了。
    // 没有候选图时保持严格，避免把日常闲聊误当指令。
    const prevPending = this.pendingStickerImages.get(key);
    const hasPendingImage = Boolean(prevPending) && now - prevPending.at < 10 * 60 * 1000;
    const req = detectStickerSaveRequest(cleanText, { hasPendingImage });

    // 图先到、指令后到：把这张图记成候选（只记主人的）
    if (images.length > 0 && isOwnerUser) {
      this.pendingStickerImages.set(key, {
        images,
        caption: String(cleanText ?? "").slice(0, 200),
        at: now,
        scene: msg.scope,
      });
    }

    if (!req) return null;

    const reply = async (text) => {
      const result = await this.send(msg, text, { split: false });
      this.#remember(
        sessionKey,
        userMemoryTextOf(cleanText, media),
        memoryTextOf(result, text),
        { scene: msg.scope },
      );
      return result;
    };

    if (!isOwnerUser) {
      return reply("" + botName() + "的表情库只收主人给的图，别人的图先不存哈。");
    }

    let sourceImages = images;
    let caption = cleanText;
    if (sourceImages.length === 0) {
      const pending = this.pendingStickerImages.get(key);
      if (pending && now - pending.at <= STICKER_PENDING_TTL_MS) {
        sourceImages = pending.images;
        caption = [pending.caption, cleanText].filter(Boolean).join("；");
      }
    }

    if (sourceImages.length === 0) {
      // 弱指令（「这个以后用」）没有图就当没听见，避免把日常话当命令
      if (!req.strong) return null;
      return reply("图呢？主人先把想存的那张发给我，再说一句「存下来」～");
    }

    if (sourceImages.length > 1) {
      return reply(
        `主人一次发了 ${sourceImages.length} 张，${botName()}一次只存一张，想存哪张？`,
      );
    }

    const res = await ingestStickerAttachment({
      attachment: sourceImages[0],
      caption,
      name: req.name,
      cfg,
      deps: { ...this._stickerDeps, logger: this.logger },
    });

    if (res.ok) {
      this.stats.stickersSaved += 1;
      this.pendingStickerImages.delete(key);
      this.logger?.info?.(
        `存图成功：${res.file}（${res.bytes} 字节${res.resized ? "，已缩放" : ""}` +
          `${res.reviewed ? "" : "，未审"}）`,
      );
    } else {
      this.stats.stickerSaveFailed += 1;
      this.logger?.warn?.(`存图失败（${res.code}）：${res.message}`);
    }

    return reply(res.message);
  }

  /**
   * 轻松场合自动补一张表情包（模型没主动调 send_sticker 时的确定性兜底）。
   *
   * 为什么是「窄兜底」而不是「每条都发」：见 sticker-mood.js 顶部注释。
   * 这里只负责调用与频率闸门；场景判断在 detectStickerMood 里。
   */
  async #planMoodSticker(text, { key, msg, finalText }) {
    const cfg = this.#stickerConfig();
    if (!cfg?.enabled) return null;
    if (cfg.auto === false) return null;
    // 诊断：被骚扰场景一定要能走到挑选，所以这里把每个闸门的判定都打出来。
    if (msg.kind !== "text") {
      this.logger?.debug?.(`自动表情跳过：非文本消息（kind=${msg.kind}）`);
      return null;
    }
    if (String(finalText ?? "").length > 80) {
      this.logger?.debug?.(`自动表情跳过：回复太长（${String(finalText ?? "").length} 字）`);
      return null;
    }
    if (isSeriousScene(text)) {
      this.logger?.debug?.("自动表情跳过：严肃场景");
      return null;
    }

    const mood = detectStickerMood(text);
    if (!mood) {
      this.logger?.debug?.(`自动表情跳过：没匹配到场景（"${String(text).slice(0, 20)}"）`);
      return null;
    }
    if (!this.stickerBudget.canSend(key)) {
      const b = this.stickerBudget.snapshot?.(key);
      this.logger?.info?.(
        `自动表情被频率闸门拦下（${mood.mood}，key=${key}，状态=${JSON.stringify(b ?? null)}）`,
      );
      return null;
    }

    try {
      const all = await listStickers(cfg, { logger: this.logger });
      // 好感度影响挑哪张：高好感优先萌系、低好感优先冷系
      const name = pickStickerMoodName(all, mood, {
        affinity: this.affinity?.get?.(msg?.senderId) ?? 0,
        // 挡箭牌只在**真骚扰**时才用（「无语了」这种轻度感叹不该掏那张图）
        harassment: detectHarassment(String(text ?? "")).hit,
      });
      if (!name) return null;
      const res = await executeStickerCall(STICKER_TOOL_NAME, { name }, cfg, {
        logger: this.logger,
      });
      if (!res.ok || !res.images?.length) return null;
      this.stickerBudget.record(key);
      this.stats.autoStickers += 1;
      this.logger?.info?.(`轻松场合自动补表情：${name}（${mood.mood}）`);
      return { name, images: res.images, mood: mood.mood };
    } catch (err) {
      this.logger?.warn?.(`自动表情包失败（继续文字）：${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 这句话在要表情包时，由引擎直接选定要发哪张。
   *
   * 失败返回 null（照常回文字）——绝不因为贴纸挂了就不回话，
   * 也绝不把「表情包」三个字当成一句话发出去。
   */
  async #planStickerReply(text) {
    const cfg = this.#stickerConfig();
    if (!cfg?.enabled) return null;
    const req = detectStickerRequest(text);
    if (!req) return null;
    try {
      const all = await listStickers(cfg, { logger: this.logger });
      if (!all.length) {
        this.logger?.debug?.("有表情包请求，但素材目录里没有图");
        return null;
      }
      const name = pickStickerName(all, req);
      if (!name) return null;
      const res = await executeStickerCall(STICKER_TOOL_NAME, { name }, cfg, {
        logger: this.logger,
      });
      if (!res.ok || !res.images?.length) {
        this.logger?.warn?.(`表情包没准备好（${name}）：${res.content}`);
        return null;
      }
      this.logger?.info?.(`命中表情包请求（${req.keyword || "通用"}），准备发「${name}」`);
      return { name, images: res.images, keyword: req.keyword };
    } catch (err) {
      this.logger?.warn?.(`表情包触发失败（继续文字）：${err?.message ?? err}`);
      return null;
    }
  }

  /** 待办里的「发个表情包」：先挑一张待发；没有素材返回 null（如实说没发） */
  async #stickerForPending(entry) {
    const cfg = this.#stickerConfig();
    if (!cfg?.enabled) return null;
    try {
      const all = await listStickers(cfg, { logger: this.logger });
      const wanted = String(entry?.payload?.stickerName ?? "").trim();
      const name = wanted || pickStickerName(all, { generic: true });
      if (!name) return null;
      const res = await executeStickerCall(STICKER_TOOL_NAME, { name }, cfg, {
        logger: this.logger,
      });
      return res.ok && res.images?.length ? res : null;
    } catch (err) {
      this.logger?.warn?.(`待办表情包准备失败：${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * 把模型画好的图发出去（file_type=1 / msg_type=7）。
   *
   * 逐张发：同一 msg_id 的多次回复必须用不同的 msg_seq，否则平台判重复而拒发，
   * 所以每张都取一次 nextMsgSeq()。
   *
   * **永不抛出**：任何一张失败都只记错误，不影响其余图片与随后的文字。
   */
  async #sendImages(msg, images) {
    const startedAt = Date.now();
    let sent = 0;
    const errors = [];

    for (const img of images) {
      try {
        // 2026-10-19：上传图片**带重试**。
        // 真机：`fetch failed`（网络错误）直接放弃，图就没了 —— 但明明是画成功的。
        // 网络抖动是常态，重试 3 次 + 指数退避，且把超时从 30s 放宽到 90s
        //（几 MB 的图在慢网络上 30s 确实可能不够）。
        const bytes = Math.round((String(img.base64 ?? "").length * 3) / 4 / 1024);
        let fileInfo = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            fileInfo = await this.api.uploadMedia(
              msg.scope,
              msg.targetId,
              img.base64,
              IMAGE_FILE_TYPE,
              { timeoutMs: 90_000 },
            );
            if (fileInfo) break;
          } catch (err) {
            lastErr = err;
            const msgText = String(err?.message ?? err);
            // 业务错误（权限/参数）重试没意义，直接放弃
            if (err?.bizCode) break;
            this.logger?.warn?.(
              `图片上传第 ${attempt}/3 次失败（${msgText.slice(0, 60)}，约 ${bytes}KB），${
                attempt < 3 ? "2 秒后重试" : "放弃"
              }`,
            );
            if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
        if (!fileInfo) {
          const why = String(lastErr?.message ?? lastErr ?? "未知原因");
          errors.push(`上传失败（${why.slice(0, 60)}，约 ${bytes}KB）`);
          continue;
        }
        await this.api.sendMedia(msg.scope, msg.targetId, fileInfo, {
          msgId: msg.messageId,
          msgSeq: nextMsgSeq(),
        });
        sent += 1;
      } catch (err) {
        const hint = err?.bizCode
          ? `（bizCode=${err.bizCode}，很可能是应用未开通富媒体/图片权限）`
          : "";
        errors.push(`${err?.message ?? err}${hint}`);
      }
    }

    if (sent > 0) {
      this.stats.replied += 1;
      this.logger?.info?.(
        `已发送图片 ${sent}/${images.length}（用时 ${Date.now() - startedAt}ms）` +
          (errors.length ? `；失败 ${errors.length} 张：${errors[0]}` : ""),
      );
      return { action: "replied", images: sent };
    }
    return { action: "send_failed", error: errors.join("; ") || "没有可发送的图片" };
  }

  /**
   * 这条消息是不是在点歌？
   *
   * 两条路，顺序不能反：
   *   ① 原有触发词（「唱首歌」「来一首」「唱给我听」…）—— 与曲库无关，先判，省一次扫盘
   *   ② 曲库里**确实有**某个歌名，且话里带着唱歌动作（「唱樱花草」「春禾唱稻香」）
   *
   * ②必须带曲库白名单：否则「我昨天在KTV唱稻香」这种叙述也会被当成点歌。
   */
  async #isSingRequest(text) {
    // 群消息的正文长这样：`<@7BB2…> 唱首樱花草听听`。不剥掉 @ 前缀，
    // 歌名抽取（extractSongName 只认标点，不认 <@!…>）就会失败——
    // 于是"点了曲库没有的歌"被当成闲聊，模型接着编歌词冒充。
    const s = stripMentions(text);
    if (isSingRequest(s)) return true;
    if (!/(唱|来|点|放)/.test(s)) return false;
    const names = await this.#librarySongNames();
    if (names.length > 0 && isSingRequest(s, { songNames: names })) return true;

    // 曲库里**没有**这首歌，但主人明说了「唱<歌名>」——仍要认成点歌。
    // 认下来才能如实回一句「这首还没学会」；不认就会掉进普通聊天，
    // 模型随即编一段歌词当成"唱了"（2026-10-17 真机：群里 59 字假歌词）。
    // 只认句首的「唱」，不认「来/放」——"来一份外卖""放个假"不能被当成点歌。
    const leadingSing = /^\s*(?:春禾|小禾)?\s*[，,]?\s*(?:请|麻烦|帮我|给我|你)?\s*唱\s*\S/.test(s);
    return leadingSing && Boolean(extractSongName(s));
  }

  /** 曲库里的歌名（去重；`listLibrarySongs` 自带 60s 缓存，不会每条消息都读盘） */
  async #librarySongNames() {
    const cfg = this.#singConfig();
    try {
      const songs = await listLibrarySongs({ dir: cfg.libraryDir, logger: this.logger });
      return [...new Set(songs.map((s) => s.name).filter(Boolean))];
    } catch (err) {
      // 契约上 never throws；真抛了也只是"认不出歌名"，绝不能影响这条消息的回复
      this.logger?.debug?.(`曲库歌名读取异常（已忽略）：${err?.message ?? err}`);
      return [];
    }
  }

  /**
   * 这条消息是不是在问「你会哪些歌 / 这首会不会」？
   *
   * 只在这时把曲库清单注入上下文：真机里她答「看不到完整的曲库清单」，
   * 其实 `listLibrarySongs` 一查就有——她缺的是清单，不是能力。
   * 每轮都注入会平白烧 token，所以按需查。
   */
  #shouldListSongLibrary(text) {
    const s = stripMentions(text);
    if (!s) return false;
    if (/(?:曲库|歌单|会唱|能唱|哪些歌|什么歌|唱什么歌|唱歌)/.test(s)) return true;
    // 「樱花草会吗」「这首歌会不会」这类短问句
    return s.length <= 24 && /(?:会不会|(?:会|能)(?:唱)?(?:吗|么|嘛))\s*[?？]?\s*$/.test(s);
  }

  /**
   * 把一条待办**主动**发到群里（不带 msg_id）。
   *
   * 三种结局都必须如实返回，绝不抛：
   *   - {ok:true}                         真发出去了（已 markDone）
   *   - {ok:false, reason:"no_known_group"} 不知道发哪个群（不瞎发）
   *   - {ok:false, reason:"quota"}        本地配额到顶（不发）
   *   - {ok:false, reason:"send_failed"}  平台拒发（保留 pending 做兜底）
   *   - {deferred:true}                   这类动作不适合代写文字（唱歌/表情包）
   *
   * 为什么失败要保留 pending：主人之后在群里说话时，旧路径还能用被动回复补上。
   * 但**不会再烧一次主动配额**，也不会骗主人说已经发了。
   */
  async #deliverPendingProactively(entry) {
    const stickerOnly = Boolean(entry?.payload?.sticker);
    const voiceOnly = entry?.kind === "voice";
    const text = stickerOnly ? "" : this.#pendingLineFor(entry);
    // 唱歌/表情包/generic 这类没有确定性文案的动作，不硬编一句话发出去
    if (!stickerOnly && !text) return { deferred: true };

    const target = this.#resolveProactiveTarget(entry);
    if (!target.ok) {
      this.stats.pendingProactiveSkipped += 1;
      this.logger?.info?.(
        `待办没有可用的群，先不发：${entry.action.slice(0, 30)}（${target.reason}）`,
      );
      return { ok: false, reason: target.reason, sizeLabel: target.sizeLabel ?? "" };
    }

    const groupOpenid = target.groupOpenid;
    const group = target.group;
    const quota = this.quota.check({ targetId: groupOpenid, purpose: "pending" });
    if (!quota.ok) {
      this.stats.pendingProactiveSkipped += 1;
      this.logger?.warn?.(
        `群主动消息配额不足（${quota.reason}），「${entry.action.slice(0, 30)}」改走兜底`,
      );
      return { ok: false, reason: "quota", quota, group };
    }

    // 表情包待办：素材要在发之前准备好。没有素材就如实说没发，也不烧配额。
    let sticker = null;
    if (stickerOnly) {
      sticker = await this.#stickerForPending(entry);
      if (!sticker) {
        this.stats.pendingProactiveFailed += 1;
        this.logger?.warn?.(
          `待办要发表情包，但素材没准备好：${entry.action.slice(0, 30)}`,
        );
        return { ok: false, reason: "sticker_unavailable", group, groupOpenid };
      }
    }

    // 语音待办：先合成。合成/时长不满足就**降级文字**（内容仍要送到），
    // 并在回执里明确说是文字、不是语音；绝不假装发了语音。
    let voice = null;
    let voiceFallback = "";
    if (voiceOnly) {
      const cfg = this.#ttsConfig();
      const groupMode = cfg.groupMode ?? (cfg.allowGroup ? "always" : "off");
      if (!cfg.enabled) {
        voiceFallback = "语音总开关没开";
      } else if (groupMode === "off") {
        voiceFallback = "群语音还没开通";
      } else {
        const synth = await this._ttsSynth(text, cfg, { logger: this.logger });
        if (!synth?.ok) {
          voiceFallback = synth?.reason || "语音合成失败";
        } else if (Number(synth.durationMs) > MAX_QQ_VOICE_MS) {
          voiceFallback =
            `语音时长 ${(Number(synth.durationMs) / 1000).toFixed(1)}s 超过 QQ 的 ` +
            `${MAX_QQ_VOICE_MS / 1000}s 上限`;
        } else {
          voice = synth;
        }
      }
      if (voiceFallback) {
        this.logger?.warn?.(`待办语音不可用，改用文字：${voiceFallback}`);
      }
    }

    try {
      if (voice) {
        // 语音与唱歌同一条富媒体链路（file_type=3 + msg_type=7）；
        // 不带 msg_id = 主动消息，所以要过上面的配额账本。
        try {
          const fileInfo = await this.api.uploadMedia(
            "group",
            groupOpenid,
            voice.silk.toString("base64"),
            VOICE_FILE_TYPE,
          );
          if (!fileInfo) throw new Error("上传成功但平台未返回 file_info");
          await this.api.sendMedia("group", groupOpenid, fileInfo, { msgSeq: nextMsgSeq() });
        } catch (voiceErr) {
          // 语音通道坏了（没权限/网络）：文字几乎一定还能发，先保证内容送到，
          // 回执里如实说"语音没发出去、改成文字了"。
          voiceFallback = `语音发送失败：${this.#proactiveFailureText(voiceErr)}`;
          voice = null;
          this.logger?.warn?.(
            `待办语音发送失败（${voiceFallback}），改文字兜底：${entry.action.slice(0, 30)}`,
          );
          const payloadText = withAiLabel(text, resolveAiLabelStyle(this.config));
          await this.api.sendProactiveMessage("group", groupOpenid, payloadText);
        }
      } else if (sticker) {
        // 表情包就是图片：走与发图/唱歌完全相同的富媒体链路（file_type=1 + msg_type=7）
        const fileInfo = await this.api.uploadMedia(
          "group",
          groupOpenid,
          sticker.images[0].base64,
          IMAGE_FILE_TYPE,
        );
        if (!fileInfo) throw new Error("上传成功但平台未返回 file_info");
        await this.api.sendMedia("group", groupOpenid, fileInfo, { msgSeq: nextMsgSeq() });
      } else {
        const payloadText = withAiLabel(text, resolveAiLabelStyle(this.config));
        await this.api.sendProactiveMessage("group", groupOpenid, payloadText);
      }
    } catch (err) {
      const why = this.#proactiveFailureText(err);
      this.quota.record({
        targetId: groupOpenid,
        purpose: "pending",
        ok: false,
        error: `${err?.bizCode ?? ""} ${err?.message ?? err}`.trim(),
      });
      this.pendingActions.markAttempt(entry.id, {
        error: `${err?.bizCode ? `[${err.bizCode}] ` : ""}${err?.message ?? err}`,
      });
      this.stats.pendingProactiveFailed += 1;
      this.logger?.warn?.(`待办主动发群失败：${groupOpenid} ${why}`);
      return {
        ok: false,
        reason: "send_failed",
        error: why,
        bizCode: err?.bizCode,
        group,
      };
    }

    const afterSend = this.quota.record({
      targetId: groupOpenid,
      purpose: "pending",
      ok: true,
    });
    this.pendingActions.markDone(entry.id, {
      groupOpenid,
      result: voice ? "proactive_voice" : "proactive",
    });
    this.stats.pendingProactiveSent += 1;
    this.logger?.info?.(
      voice
        ? `待办已用语音主动发到群：${entry.action.slice(0, 30)} → ${groupOpenid}` +
            `（${(voice.silk.length / 1024).toFixed(1)}KB，今日 ${quota.dayCount + 1}/${quota.limit}）`
        : sticker
          ? `待办已主动发到群（表情包「${sticker.images[0]?.name ?? ""}」）：` +
              `${entry.action.slice(0, 30)} → ${groupOpenid}（今日 ${quota.dayCount + 1}/${quota.limit}）`
          : `待办已主动发到群：${entry.action.slice(0, 30)} → ${groupOpenid}` +
              `（今日 ${quota.dayCount + 1}/${quota.limit}）`,
    );
    return {
      ok: true,
      group,
      groupOpenid,
      quota,
      record: afterSend,
      shortId: shortGroupId(groupOpenid),
      kind: entry.kind,
      sticker: Boolean(sticker),
      voice: Boolean(voice),
      voiceFallback,
    };
  }

  /** 待办的目标群：显式 id / 大群 / 小群 / 最活跃的群 */
  #resolveProactiveTarget(entry) {
    const target = String(entry?.target ?? "");
    if (target.startsWith("group:")) {
      const gid = target.slice("group:".length).trim();
      if (!gid) return { ok: false, reason: "no_known_group", sizeLabel: "" };
      return { ok: true, groupOpenid: gid, group: this.groups.get(gid) };
    }

    const sizeLabel = sizeLabelOfTarget(target);
    const picked = this.groups.selectTarget({ sizeLabel });
    if (!picked.ok) {
      return { ok: false, reason: picked.reason, sizeLabel };
    }
    return { ok: true, groupOpenid: picked.groupOpenid, group: picked.entry };
  }

  /** 平台错误码 → 主人能看懂的一句话（不含内部路径/堆栈） */
  #proactiveFailureText(err) {
    const code = Number(err?.bizCode);
    const table = {
      40034100: "平台主动消息频控/配额限制",
      40034105: "没有主动消息权限（应用权限或用户关闭了主动消息）",
      40034101: "机器人不在这个群里了",
      40054003: "机器人不是群成员",
      40054002: "机器人被禁言了",
      40034006: "消息内容被平台判为违规",
      40054005: "被平台判定为重复消息",
      40034128: "被动回复时间或次数超限",
      40054007: "消息长度超限",
      40054010: "消息里不允许带链接",
      50055001: "平台消息服务临时异常",
    };
    if (table[code]) return table[code];
    const raw = String(err?.message ?? err ?? "").replace(/\s+/g, " ").trim();
    return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw || "平台没有返回原因";
  }

  /**
   * 文本类待办的确定性文案。
   *
   * 为什么不让模型自由发挥：主人说「在群里卖个萌」，模型可能又解释成
   * "私聊的指令没法在群里实现"。这里直接把动作拼进回复，保证真的做了。
   */
  #pendingLineFor(entry) {
    if (!entry) return "";
    if (entry.kind === "cute") return "主人～" + botName() + "来卖个萌啦 💖 啾咪～";
    if (entry.kind === "voice") {
      // 文字兜底时要说的话（真正的语音由 #sendVoice / #deliverPendingProactively 发）
      const said = String(entry.payload?.text ?? "").trim();
      return said || entry.action;
    }
    if (entry.kind === "say") {
      const text = String(entry.payload?.text ?? "").trim();
      return text || entry.action;
    }
    if (entry.kind === "at") {
      const mention = String(entry.payload?.mention ?? "").trim();
      const message = String(entry.payload?.message ?? "").trim();
      if (!mention) return entry.action;
      // 主动消息没有群成员表（11253），这里只能发「@名字」纯文本，不是平台真 @。
      // 回执由 describeProactiveDelivery 如实说明，别让主人以为对方收到了提醒。
      return message ? `@${mention} 主人让${botName()}转告你：${message}` : `@${mention} 主人让${botName()}来叫你一下～`;
    }
    return "";
  }

  /**
   * 取同一会话里最近几条**主人说的话**（新的在后）。
   *
   * 用途见 `resolveLibrarySong`：真实 bug 的现场是「春禾会唱樱花草吗」→「唱给我听」，
   * 歌名在上一轮、这一轮只有请求，不回看历史就只能退化成默认那首（= 又唱成稻香）。
   */
  #recentUserTexts(msg) {
    try {
      const history = this.memory?.get?.(sessionKeyOf(msg, this.ownerIds)) ?? [];
      return history
        .filter((m) => m?.role === "user" && m?.content)
        .slice(-3)
        .map((m) => String(m.content));
    } catch (err) {
      this.logger?.debug?.(`读取会话历史失败（已忽略）：${err?.message ?? err}`);
      return [];
    }
  }

  /**
   * 唱一首歌并发出去。
   *
   * **曲库优先**：曲库里是渲染好的成品（RVC 真人唱），读文件直接发，秒级；
   * 曲库里没有这首歌、且主人没点名具体哪首，才回落 DiffSinger 合成（原行为）。
   *
   * 发送走 `#uploadVoice` / `#sendVoiceMedia`：**按 msg.scope 选管道**，
   * c2c 与群聊都能真发出去（群聊走 /v2/groups/{group_openid}/…）。
   *
   * 失败返回 {action:"send_failed" | "not_learned"}，调用方**只允许**回一句实话
   * （见 songHonestFailureText），绝不能把模型编的歌词当唱歌发出去。
   */
  async #sendSong(msg) {
    const cfg = this.#singConfig();
    const startedAt = Date.now();

    // ① 成品曲库：主人点的那首真有成品，就直接发
    let plan = null;
    try {
      plan = await resolveLibrarySong(cfg, {
        text: msg.content ?? "",
        recentTexts: this.#recentUserTexts(msg),
        logger: this.logger,
      });
    } catch (err) {
      this.logger?.warn?.(`曲库查询异常（回落合成）：${err?.message ?? err}`);
    }

    if (plan?.files?.length) {
      const sent = await this.#sendLibrarySong(msg, plan, cfg, startedAt);
      // 只要有一段发出去了就不再合成兜底——否则主人会先听到半首、又听到一首。
      if (sent.action === "replied") return sent;

      // ⚠️ 点的是**具体某首歌**、曲库也确实有 → 这时**绝不能**回落合成。
      //    合成兜底用的乐谱是硬编码的《稻香》副歌：主人点《樱花草》却听到稻香，
      //    正是这次要修的 bug。
      //    2026-10-16 真机实测就踩到了：曲库那条路遇到一次网络抖动（取 token 失败），
      //    一回落合成，27863ms 的稻香又发了出去。宁可这条退回文字，也不能唱错歌。
      this.logger?.warn?.(
        `曲库《${plan.name}》发送失败（${sent.error ?? "未知原因"}）；` +
        `不回落合成（合成的默认曲目不是主人点的那首），这条改走文字`,
      );
      return { action: "send_failed", error: sent.error, resolvedSong: plan.name };
    }

    // ② 主人点的是**具体某首歌**，曲库里却没有 → 直说"不会"，绝不合成顶替。
    //    合成兜底只会唱硬编码的《稻香》副歌：点《樱花草》却听到稻香正是这次修的 bug。
    //    同理，也不许模型编一段歌词当成"唱了"。
    const named = this.#namedSong(msg);
    if (named) {
      this.logger?.warn?.(`曲库没有《${named}》，不合成别的歌顶替，改成直说不会`);
      return { action: "not_learned", songName: named, error: `曲库没有《${named}》` };
    }

    // 没点名具体哪首（「唱首歌」「来一首」）→ 才走合成兜底（原行为）
    return this.#sendSynthSong(msg, cfg, startedAt);
  }

  /**
   * 这条点歌请求里有没有**具体歌名**（本轮的优先，其次回看最近几轮的点歌）。
   *
   * 只在曲库没命中时用来决定"说不会"还是"走合成"：
   *   有歌名 → 说不会（绝不能拿稻香顶替）
   *   没歌名（「唱首歌」）→ 才允许合成兜底
   */
  #namedSong(msg) {
    // 同样先剥 @ 前缀：群里点歌的正文带 `<@openid>`，否则歌名抽不出来，
    // 就会从"说不会"退化成"随便唱一首"或"编歌词"。
    const direct = extractSongName(stripMentions(msg.content ?? ""));
    if (direct) return direct;
    for (const text of this.#recentUserTexts(msg)) {
      const clean = stripMentions(text);
      if (!isSingRequest(clean)) continue;
      const name = extractSongName(clean);
      if (name) return name;
    }
    return "";
  }

  /**
   * 发曲库里的成品歌。
   *
   * 多段（`_1of5.._5of5`）**按顺序全部发**，段间等 `libraryGapMs`（默认 5s）——
   * 连发多条语音会被 QQ 判成刷屏，也会让主人听不清哪里是哪里。
   *
   * 中途失败就停下（不再发后面的段），已发出去的算数：返回 replied + errors。
   */
  async #sendLibrarySong(msg, plan, cfg, startedAt) {
    const files = plan.files;
    const errors = [];
    let sent = 0;

    for (let i = 0; i < files.length; i += 1) {
      const item = files[i];
      const read = await readLibrarySilk(item.path);
      if (!read.ok) {
        errors.push(`${item.file}：${read.reason}`);
        break;
      }
      try {
        const fileInfo = await this.#uploadVoice(msg, read.silk);
        if (!fileInfo) {
          errors.push(`${item.file}：上传成功但平台未返回 file_info`);
          break;
        }
        const res = await this.#sendVoiceMedia(msg, fileInfo);
        sent += 1;
        this.sent.push({
          scope: msg.scope,
          targetId: msg.targetId,
          text: `[唱歌]${item.file}`,
          msgId: msg.messageId,
          res,
          at: Date.now(),
        });
        this.logger?.info?.(
          `曲库歌声 ${i + 1}/${files.length} 已发出：${item.file}` +
          `（${(item.durationMs / 1000).toFixed(1)}s，${(read.silk.length / 1024).toFixed(1)}KB）`,
        );
        if (i < files.length - 1 && cfg.libraryGapMs > 0) {
          await sleep(cfg.libraryGapMs);
        }
      } catch (err) {
        const hint = err?.bizCode
          ? `（bizCode=${err.bizCode}，很可能是应用未开通富媒体/语音权限）`
          : "";
        errors.push(`${item.file}：${err?.message ?? err}${hint}`);
        break;
      }
    }

    if (sent > 0) {
      this.stats.replied += 1;
      this.logger?.info?.(
        `已回复 ${msg.scope}（曲库《${plan.name}》${sent}/${files.length} 段，` +
        `来源=${plan.source}，用时 ${Date.now() - startedAt}ms）` +
        (errors.length ? `；失败：${errors[0]}` : ""),
      );
      return {
        action: "replied",
        voice: true,
        song: true,
        songName: plan.name,
        segments: sent,
        segmentsTotal: files.length,
        errors,
        res: this.sent[this.sent.length - 1]?.res,
      };
    }
    return { action: "send_failed", error: errors.join("; ") || "曲库没有可发送的歌声" };
  }

  /** 现场合成一首歌（曲库没有时才走这条慢路） */
  async #sendSynthSong(msg, cfg, startedAt) {
    try {
      const song = await synthesizeSong(cfg);
      if (!song.ok) return { action: "send_failed", error: song.reason };

      const fileInfo = await this.#uploadVoice(msg, song.silk);
      if (!fileInfo) return { action: "send_failed", error: "上传成功但平台未返回 file_info" };

      const res = await this.#sendVoiceMedia(msg, fileInfo);

      this.stats.replied += 1;
      this.sent.push({
        scope: msg.scope,
        targetId: msg.targetId,
        text: "[唱歌]",
        msgId: msg.messageId,
        res,
        at: Date.now(),
      });
      this.logger?.info?.(
        `已回复 ${msg.scope}（歌声 ${(song.silk.length / 1024).toFixed(1)}KB / ` +
        `${song.meta?.durationMs ?? "?"}ms，用时 ${Date.now() - startedAt}ms）`,
      );
      return { action: "replied", voice: true, song: true, res };
    } catch (err) {
      const hint = err?.bizCode
        ? `（bizCode=${err.bizCode}，很可能是应用未开通富媒体/语音权限）`
        : "";
      return { action: "send_failed", error: `${err?.message ?? err}${hint}` };
    }
  }

  async #sendVoice(msg, text) {
    const cfg = this.#ttsConfig();
    const startedAt = Date.now();
    try {
      const synth = await this._ttsSynth(text, cfg, { logger: this.logger });
      if (!synth.ok) return { action: "send_failed", error: synth.reason };

      // QQ 语音 ≤ 58s：TTS_MAX_CHARS 的默认 120 字通常够，但长句/慢语速
      // 仍可能超；超了宁可不发，也不要让平台拒收后当成"没声音"。
      if (Number(synth.durationMs) > MAX_QQ_VOICE_MS) {
        return {
          action: "send_failed",
          error:
            `语音时长 ${(Number(synth.durationMs) / 1000).toFixed(1)}s 超过 QQ 的 ` +
            `${MAX_QQ_VOICE_MS / 1000}s 上限`,
        };
      }

      if (synth.rvc && synth.rvc.ok === false) {
        this.logger?.warn?.(`语音 RVC 失败，本条用 edge-tts 原声：${synth.rvc.reason}`);
      }
      if (synth.timings) {
        const t = synth.timings;
        this.logger?.info?.(
          `[voice] tts=${t.tts}ms rvc=${t.rvc}ms silk=${t.silk}ms total=${t.total}ms ` +
            `rtf=${Number(t.rtf ?? 0).toFixed(2)} cache=${synth.cache ?? "?"} ` +
            `device=${synth.rvc?.device ?? "off"}` +
            `${synth.emotion?.emotion ? ` emotion=${synth.emotion.emotion}` : ""}`,
        );
      }

      const fileInfo = await this.#uploadVoice(msg, synth.silk);
      if (!fileInfo) {
        return { action: "send_failed", error: "上传成功但平台未返回 file_info" };
      }

      const res = await this.#sendVoiceMedia(msg, fileInfo);

      this.stats.replied += 1;
      this.sent.push({
        scope: msg.scope,
        targetId: msg.targetId,
        text,
        msgId: msg.messageId,
        res,
        at: Date.now(),
      });
      this.logger?.info?.(
        `已回复 ${msg.scope}（语音 ${(synth.silk.length / 1024).toFixed(1)}KB，用时 ${Date.now() - startedAt}ms）`,
      );
      return { action: "replied", voice: true, res };
    } catch (err) {
      // 未开通「富媒体消息」权限时平台会返回非 0 bizCode——这里必须说清楚，否则很难查
      const hint = err?.bizCode
        ? `（bizCode=${err.bizCode}，很可能是应用未开通富媒体/语音权限）`
        : "";
      return { action: "send_failed", error: `${err?.message ?? err}${hint}` };
    }
  }

  /**
   * 上传一份 SILK 语音——**按场景选管道**。
   *
   *   c2c   → /v2/users/{user_openid}/files
   *   group → /v2/groups/{group_openid}/files
   *
   * 这是本次要修的根因：语音/歌声曾一律写死 `uploadC2CFile`，群聊把
   * group_openid 当成 user_openid 去 /v2/users/... 上传，平台必拒，
   * 主人点歌就只剩一段"编出来的歌词"。图片那条路（#sendImages）早就用的是
   * 分场景的 uploadMedia(msg.scope, ...)，语音是漏改的那一处。
   */
  async #uploadVoice(msg, silk) {
    const base64 = silk.toString("base64");
    if (msg.scope === "group") {
      if (typeof this.api.uploadMedia !== "function") {
        throw new Error("api 缺少 uploadMedia，发不了群聊语音");
      }
      return this.api.uploadMedia("group", msg.targetId, base64, VOICE_FILE_TYPE);
    }
    if (typeof this.api.uploadC2CFile === "function") {
      return this.api.uploadC2CFile(msg.targetId, base64, VOICE_FILE_TYPE);
    }
    return this.api.uploadMedia("c2c", msg.targetId, base64, VOICE_FILE_TYPE);
  }

  /**
   * 发一条语音/歌声（msg_type=7）——同样按场景选接口。
   *
   * 带 `msgId` 就是**被动回复**（跟着用户那条消息走，不占主动消息配额）；
   * `msgSeq` 用按 msg_id 递增的计数器，分段歌连发时不会撞车。
   *
   * 群聊多一层保险：万一平台拒收「带 msg_id 的语音被动回复」（这条组合还
   * 没有真机验证过），就退一步用主动消息再发一次——宁可花一点配额，也不能
   * 让主人点完歌却什么都没听到。两次都失败才真的失败（由上层如实告知）。
   */
  async #sendVoiceMedia(msg, fileInfo) {
    const opts = { msgId: msg.messageId, msgSeq: this.#voiceSeq(msg.messageId) };
    if (msg.scope === "group") {
      if (typeof this.api.sendMedia !== "function") {
        throw new Error("api 缺少 sendMedia，发不了群聊语音");
      }
      try {
        return await this.api.sendMedia("group", msg.targetId, fileInfo, opts);
      } catch (err) {
        if (!opts.msgId) throw err;
        this.logger?.warn?.(
          `群聊语音被动回复被拒（${err?.message ?? err}），改用主动消息重试一次`,
        );
        return this.api.sendMedia("group", msg.targetId, fileInfo, {
          msgSeq: this.#voiceSeq(null),
        });
      }
    }
    if (typeof this.api.sendC2CVoice === "function") {
      return this.api.sendC2CVoice(msg.targetId, fileInfo, opts);
    }
    return this.api.sendMedia("c2c", msg.targetId, fileInfo, opts);
  }

  /**
   * 同一个 msg_id 的 msg_seq：第一条随机起点，之后严格 +1。
   * 随机值可能倒退，而 QQ 对同一 msg_id 的连发要求 seq 递增。
   */
  #voiceSeq(msgId) {
    const key = String(msgId ?? "");
    if (!key) return nextMsgSeq();
    const prev = this.voiceSeqByMsg.get(key);
    const seq = Number.isFinite(prev) ? prev + 1 : (nextMsgSeq() % 60000) + 1;
    this.voiceSeqByMsg.set(key, seq);
    // 只留最近 50 个 msg_id，避免长期运行无限增长
    if (this.voiceSeqByMsg.size > 50) {
      const oldest = this.voiceSeqByMsg.keys().next().value;
      this.voiceSeqByMsg.delete(oldest);
    }
    return seq;
  }

  /** 发送单条；msg_seq 在段间递变，避免平台判为重复 */
  async #sendOne(msg, text, { index = 0, total = 1 } = {}) {
    const label = total > 1 ? `（第 ${index + 1}/${total} 段）` : "";

    // 群作用域且成员表可用：把回复里的「@名字」解析成真 @（<qqbot-at-user id=.../>）。
    // 解析后用替换文本下发；解析不到的名字原样保留并告警。
    // ⚠️ 2026-10-19 修：剥掉**场景标注**。
    //   她的回复曾莫名带上「〔私聊〕…」「〔群聊〕…」前缀（真机：主人反馈"总是加上群聊/私聊的备注"）。
    //   根因是历史注入把她自己的旧回复也标了场景，模型学着模仿（已在 memory.js 改成只标用户侧）。
    //   这里再做一道确定性兜底：**发出去之前**把句首的这类标注去掉。
    const stripSceneLabels = (s) =>
      String(s ?? "")
        .replace(/^\s*〔\s*(?:私聊|群聊)(?:\s*·\s*[^〕]*)?\s*〕\s*/g, "")
        .replace(/^\s*[（(]\s*(?:私聊|群聊)(?:\s*·\s*[^）)]*)?\s*[）)]\s*/g, "")
        .replace(/^\s*\[\s*(?:私聊|群聊)(?:\s*·\s*[^\]]*)?\s*\]\s*/g, "");

    let sendText = stripSceneLabels(text);
    if (msg.scope === "group" && msg.memberMap) {
      const resolved = resolveAtMentions(text, msg.memberMap, {
        wakeNames: this.config.wakeNames ?? [],
      });
      for (const m of resolved.resolved) {
        this.logger?.info?.(`已解析 @${m.name} → member_openid=${m.member_openid}`);
      }
      for (const name of resolved.unresolved) {
        this.logger?.warn?.(`未能匹配 @${name}，已原样发送（不在成员表/名字不一致）`);
      }
      sendText = resolved.text;
    }

    try {
      const res = await this.api.sendMessage(msg.scope, msg.targetId, sendText, {
        msgId: msg.messageId,
        msgSeq: nextMsgSeq(),
        markdown: false,
      });
      this.stats.replied += 1;
      // 记下"她刚在这个群说过话"：别人 2 分钟内接着说话会被当成在跟她讲
      // （见 #shouldRespond 的 follow_up 判定与 #watchGroup 的唤醒逻辑）。
      if (msg.scope === "c2c") {
        this.lastReplyText = sendText;
      }
      if (msg.scope === "group" && msg.targetId) {
        this.lastHerReplyAt.set(msg.targetId, Date.now());
        // 她拒绝 = 对方大概率在骚扰（关键词追不上谐音时的兜底）
        this.#trackRefusalReply(msg, sendText);
      }
      this.sent.push({ scope: msg.scope, targetId: msg.targetId, text: sendText, msgId: msg.messageId, res, at: Date.now() });
      this.logger?.info?.(`已回复 ${msg.scope}${label}（${sendText.length} 字）`);
      return { action: "replied", text: sendText, res };
    } catch (err) {
      this.stats.sendFailed += 1;
      this.logger?.error?.(`发送失败${label}：${err?.message}`);
      return { action: "send_failed", error: err?.message };
    }
  }

  #remember(sessionKey, userText, replyText, meta = {}) {
    this.memory.append(sessionKey, userText, replyText, meta);
  }

  /** 退出前把记忆落盘（force 确保最后一次对话一定被写入） */
  flushMemory() {
    this.memory.flush(true);
    this.ownerMemory?.flush?.(true);
    this.pendingActions?.flush?.(true);
    this.groups?.flush?.(true);
    this.quota?.flush?.(true);
    return this.memory.size;
  }
}

/**
 * 从用户的话里提取一个可复用的话题。
 *
 * 刻意做得保守：只用确定性规则，不额外调用模型（省 token，也避免拖慢回复）。
 * 过滤掉寒暄、附和、短句与单纯的提问——这些记下来没有价值。
 *
 * @returns {string|null}
 */
export function extractTopic(text) {
  const raw = String(text ?? "").trim();
  if (raw.length < 6) return null;

  // 整句就是寒暄/附和/告别，不记
  if (/^(你好|您好|hi|hello|嗨|在吗|在么|早|晚安|再见|拜拜|谢谢|好的|好|嗯|哦|哈哈|收到)[\s!！。~～?？]*$/i.test(raw)) {
    return null;
  }
  // 纯提问不记（问题的答案可能才是有用信息，但由助手回答侧承载）
  if (/[?？]$/.test(raw) && raw.length < 20) return null;
  // 命令类、纯符号不记
  if (/^[\/!！]/.test(raw)) return null;

  const clean = normalizeTopic(raw);
  if (!clean || clean.length < 6) return null;

  // 取第一句，避免把整段闲聊塞进话题库
  const firstSentence = clean.split(/[。！？!?\n]/)[0]?.trim() || clean;
  const topic = firstSentence.length >= 6 ? firstSentence : clean;
  return topic.length > 60 ? `${topic.slice(0, 60)}…` : topic;
}

/**
 * 从附件/消息类型判断这条消息是什么媒体。
 *
 * 背景：QQ 的图片、表情包（自定义表情）、语音、文件都通过 `attachments` 传递，
 * 而 `content` 会是空字符串。早期版本只看 content，导致"发张图它就说没看到内容"。
 *
 * @returns {{type:"image"|"voice"|"video"|"file"|"unknown", label:string, count:number}|null}
 */
export function describeMedia(msg) {
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (attachments.length === 0) return null;

  const first = attachments[0] ?? {};
  const ct = String(first.content_type ?? "").toLowerCase();

  let type = "unknown";
  if (ct.startsWith("image")) type = "image";
  else if (ct.startsWith("voice") || ct.startsWith("audio") || first.voice_wav_url) type = "voice";
  else if (ct.startsWith("video")) type = "video";
  else if (first.url) type = "file";

  const labels = {
    image: "图片/表情包",
    voice: "语音",
    video: "视频",
    file: "文件",
    unknown: "附件",
  };

  return {
    type,
    label: labels[type],
    count: attachments.length,
    contentType: ct || undefined,
    /** 语音可能带平台自带的语音转文字结果 */
    asrText: first.asr_refer_text || undefined,
    url: first.url || undefined,
  };
}

/**
 * 模型"自我否认"真实能力的特征。
 *
 * 为什么要在运行时探测：提示词已明确声明能力，但模型仍可能因为
 * "诚实条款"过度泛化而否认（真实发生过：把"没有感官"推成"没有定时能力"）。
 * 这类回答对用户是**错误的**——功能明明已经实现。
 *
 * 这里只**告警上报**，不擅自改写内容：悄悄替换成"我能做到"会掩盖真实问题，
 * 也可能把上下文说乱。发现即记日志，便于快速定位提示词漏洞。
 */
const CAPABILITY_DENIAL_PATTERNS = [
  /没有(真正的)?(定时|计时|提醒)能力/,
  /没法(真的)?(主动)?(定时)?推送/,
  /不能(自己)?主动(发|推送)消息/,
  /没有(跨会话)?(记忆|保存记忆)(的)?能力/,
  // 「私聊的指令没法在群里实现」——真机事故里的原话，属同类错误：
  // 她没查跨场景待办，只凭直觉猜了一句，还把猜测说成了结论。
  /私聊[\s\S]{0,30}(?:没法|不能|做不到)[\s\S]{0,30}群/,
  /没法(?:替你)?(?:往|向|在)?群里/,
  // 真机 2026-10-17 21:03 的新说法：
  // 「私聊这边发出去的话只会落在私聊里，所以还得等主人在群里先开口」
  /私聊这边[\s\S]{0,24}(?:只会|只能)[\s\S]{0,12}私聊/,
  /(?:还得|要)等主人(?:先)?在群里(?:先)?开口/,
  /得等主人[\s\S]{0,10}在群里[\s\S]{0,6}(?:开口|说话)/,
  /大概不行[\s\S]{0,40}(?:私聊|群)/,
  // 「看不到曲库清单」也是同类：曲库一查就有，她只是没查。
  /看不到(?:完整的?)?曲库/,
  // 真机 2026-10-17 22:20 / 22:22 的原话（当时只告警、没修，结果和回执打架）：
  // 「春禾没法把它直接转到群里去」「表情包好像只能发在当前这个窗口里」
  /没法[\s\S]{0,24}(?:转|发|推|送)[\s\S]{0,8}群/,
  /只能(?:发|留|呆|待)[\s\S]{0,12}(?:当前|这个)(?:窗口|会话|聊天|私聊)/,
  /私聊这边[\s\S]{0,40}(?:没法|不能|做不到)/,
];

/** 检测回复里是否出现"否认已实现能力"的表述 */
export function detectCapabilityDenial(text) {
  const s = String(text ?? "");
  if (!s.trim()) return [];
  return CAPABILITY_DENIAL_PATTERNS.filter((re) => re.test(s)).map((re) => re.source);
}

/**
 * 自相矛盾闸门：**有确定性回执时**，模型那段"否认能力"的话必须被回执替换。
 *
 * 为什么不是只告警：真机 22:22 的回复是
 *   「〔私聊〕表情包好像只能发在当前这个窗口里，春禾没法把它直接转到群里去。
 *     ……（已经发到群里啦～（大群 9F42…））」
 * 同一句话里先说做不到、再说已经做了——比单纯否认更伤信任。
 * 回执是引擎确定知道的事实，不能和模型自由发挥的文字并列出现。
 *
 * 处理原则与 guardUnbackedPromise 互补：
 *   - 没有回执：只说"已经发了"会被假承诺闸门删掉（那条在调用本函数之前跑）；
 *   - 有回执：模型仍说"没法/做不到"就整段换成回执（回执本身就是完整的一句人话）。
 *
 * @param {string} text 准备发出去的文本
 * @param {{evidence?: boolean, receipt?: string, extraHits?: string[]}} [opts]
 *   extraHits：本场景专用的补充命中（如「群语音做不到」），
 *   与 detectCapabilityDenial 的结果合并判断；不改变全局规则表。
 * @returns {{text:string, hits:string[], rewritten:boolean}}
 */
export function guardCapabilityContradiction(
  text,
  { evidence = false, receipt = "", extraHits = [] } = {},
) {
  const src = String(text ?? "");
  const hits = [...detectCapabilityDenial(src), ...(Array.isArray(extraHits) ? extraHits : [])];
  if (!evidence || hits.length === 0) return { text: src, hits, rewritten: false };
  const fixed = String(receipt ?? "").trim() || "已经做到啦～";
  return { text: fixed, hits, rewritten: true };
}

/**
 * 主人统一会话键：同一个人在私聊/任何群里共用一份记忆。
 * 非主人绝不使用它（否则群里其他人会读到主人的私聊内容）。
 */
export function ownerSessionKey(senderId) {
  return `owner:${senderId}`;
}

/** 把数组/Set 统一成 Set；传空返回空集合（保持旧行为） */
function ownerSetOf(ownerIds) {
  if (ownerIds instanceof Set) return ownerIds;
  if (Array.isArray(ownerIds)) return new Set(ownerIds.filter(Boolean));
  return EMPTY_OWNER_SET;
}

const EMPTY_OWNER_SET = new Set();

/** 这条消息的发送者是不是主人 */
export function isOwnerSender(msg, ownerIds) {
  return Boolean(msg?.senderId) && ownerSetOf(ownerIds).has(msg.senderId);
}

/**
 * 会话隔离键。
 *
 * - 主人（ownerIds 里配置的人）：`owner:<openid>` —— 私聊和所有群聊共享一份记忆。
 *   这是「私聊说的话群里能接上」的实现基础。
 * - 其他人：群聊 `group:<groupOpenid>:<senderId>`，单聊 `c2c:<senderId>` —— 严格隔离。
 *
 * 注意：不传 ownerIds 时行为与旧版完全一致（向后兼容，测试/脚本依赖这一点）。
 */
export function sessionKeyOf(msg, ownerIds = null) {
  if (isOwnerSender(msg, ownerIds)) return ownerSessionKey(msg.senderId);
  return msg.scope === "group"
    ? `group:${msg.groupOpenid}:${msg.senderId}`
    : `c2c:${msg.senderId}`;
}

/**
 * 消息所属的「场景键」，用于话题库的可见性判断。
 *
 * 主人 → 统一键（owner 的话题跨场景可见，且只对主人可见）；
 * 其他人 → 自己所在的群 / 自己的私聊（同群可见，跨群不可见）。
 */
export function topicSceneOf(msg, ownerIds = null) {
  if (isOwnerSender(msg, ownerIds)) return ownerSessionKey(msg.senderId);
  return msg.scope === "group" ? groupSessionKey(msg) : `c2c:${msg.senderId}`;
}

/** 群级键（不带发言人），用于"群里刚才聊了什么"的上下文缓冲 */
export function groupSessionKey(msg) {
  return `group:${msg.groupOpenid}`;
}

/**
 * 从文本里去掉唤名。
 * 命中唤名后若原样送模型，它可能把"春禾"当成待讨论的内容，所以剥掉再问。
 * 只去掉唤名本身，不动其他字。
 */
export function stripWakeNames(content, names = []) {
  let out = String(content ?? "");
  for (const name of names ?? []) {
    const n = String(name ?? "").trim();
    if (!n) continue;
    out = out.replaceAll(n, "");
  }
  return out.replace(/^[，,、。.\s]+/, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * 去掉 `@提及` 标记与多余空白。
 *
 * ⚠️ 2026-10-19 修：原来只认 `<@!123>` 这种**纯数字** ID，
 * 但 QQ 群消息里的 @ 用的是**十六进制 openid**：
 *   `<@7BB2AF4D610A42890FA4F3E764A775A3> 骂的就是你`
 *   `<@0123456789ABCDEF0123456789ABCDEF>`
 * 这些标记一直留在她看到的文本里，她就以为"有人在 @ 我"——
 * 真机现象：主人在群里 @ 别人，她以为 @ 的是她。
 *
 * 现在三种形态都吃掉：纯数字、`!` 前缀、以及 `[0-9A-F]{16,}` 的十六进制 openid。
 * 清掉之后正文才是正文；同时 `@所有人` 这类伪 ID 也一并处理。
 */
export function stripMentions(content) {
  return String(content ?? "")
    // <@123> / <@!123>（数字 ID）
    .replace(/<@!?\d+>/g, "")
    // <@7BB2AF4D...>（十六进制 openid，QQ 群消息实际用的就是这种）
    .replace(/<@!?[0-9A-Fa-f]{8,}>/g, "")
    // 兜底：任何形如 <@...> 的残留
    .replace(/<@!?[^>\s]{2,}>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 这条消息里 @ 的是不是**她本人**？
 *
 * 群消息事件里，平台只在"@ 机器人"时才推 `GROUP_AT_MESSAGE_CREATE`；
 * 但如果某些场景推的是普通事件、内容里仍带 `<@她自己的 openid>`，
 * 这个判断能兜住（比只看事件类型更稳）。
 *
 * @param {string} content 原始内容
 * @param {string[]} [selfIds] 机器人自己的 openid/id（拿不到就传空，返回 false）
 */
export function mentionsBot(content, selfIds = []) {
  const ids = (selfIds ?? []).filter(Boolean);
  if (!ids.length) return false;
  const s = String(content ?? "");
  return ids.some((id) => s.includes(id));
}

/** 「@所有人」这类无需/不可解析的伪 @ */
const AT_SKIP_NAMES = new Set(["everyone", "all", "所有人", "全员"]);

/**
 * 把回复文本里的「@名字」解析成平台真 @ 标签 <qqbot-at-user id="member_openid" />。
 *
 * - 命中成员表 byName 的，替换成真 @；
 * - 唤名（如「春禾」）与「@所有人/@all」不替换，原样保留；
 * - 名字不在成员表的，原样保留并记入 unresolved，便于日志排查。
 *
 * @param {string} text
 * @param {{byName?: Map<string,object>}} [memberMap]
 * @param {{wakeNames?: string[]}} [opts]
 * @returns {{text:string, resolved:Array<{name:string,member_openid:string}>, unresolved:string[]}}
 */
export function resolveAtMentions(text, memberMap, { wakeNames = [] } = {}) {
  const src = String(text ?? "");
  const byName = memberMap?.byName;
  const resolved = [];
  const unresolved = [];
  const seen = new Set();
  const wake = new Set(
    (wakeNames ?? []).map((n) => String(n ?? "").trim()).filter(Boolean),
  );

  const out = src.replace(/@([一-龥A-Za-z0-9_\-]{1,20})/g, (match, name) => {
    if (!seen.has(name)) {
      seen.add(name);
      const entry = byName?.get?.(name);
      if (entry?.member_openid) {
        resolved.push({ name, member_openid: String(entry.member_openid) });
      } else if (wake.has(name) || AT_SKIP_NAMES.has(name) || AT_SKIP_NAMES.has(name.toLowerCase())) {
        // 唤名 / @所有人：刻意不替换
      } else {
        unresolved.push(name);
      }
    }
    const entry = byName?.get?.(name);
    if (entry?.member_openid) return `<qqbot-at-user id="${entry.member_openid}" />`;
    return match;
  });

  return { text: out, resolved, unresolved };
}

/**
 * 按配置附加 AI 明示标识。
 *
 * 背景：QQ 运营规范 5.14(3) 禁止"引导用户不披露真实身份"，所以机器人
 * **应当**让用户知道自己在跟 AI 对话。但加标识的方式可以选：
 *
 *   - "prefix"（如「【AI】你好」）：最醒目的合规做法，但聊天时略显机械；
 *   - "suffix"（如「你好 ——春禾(AI)」）：不影响开头语气，仍然明确；
 *   - "none"  ：完全不加。**前提是正文里要自报家门**（人设已要求它这么说），
 *               否则某条简短回复会完全没有 AI 标识，存在合规风险。
 *
 * 默认保留 prefix 以外的选择由使用者决定；这里只实现机制，不替使用者做合规判断。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.label] 标识文本
 * @param {"none"|"prefix"|"suffix"} [opts.style]
 */
export function withAiLabel(text, opts = {}) {
  const clean = String(text ?? "").trim();
  const { label = "【AI】", style = "prefix" } = typeof opts === "string" ? { label: opts } : opts;

  if (style === "none" || !label) return clean;
  if (!clean) return clean; // 空内容不该变成一条只有标识的消息
  if (style === "suffix") {
    // 已经以标识结尾就别重复加
    if (clean.endsWith(label)) return clean;
    return `${clean} ${label}`;
  }
  // prefix（默认）
  if (clean.startsWith(label)) return clean;
  return `${label}${clean}`;
}

/** 把配置解析成 withAiLabel 需要的参数 */
export function resolveAiLabelStyle(config = {}) {
  const style = String(config.aiLabelStyle ?? "prefix").toLowerCase();
  return {
    label: config.aiLabel ?? "【AI】",
    style: ["none", "prefix", "suffix"].includes(style) ? style : "prefix",
  };
}
