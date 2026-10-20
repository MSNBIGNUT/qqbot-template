/**
 * 配置加载：全部走环境变量，**密钥绝不写进代码或提交进仓库**。
 *
 * 用法：
 *   QQ_APP_ID=xxx QQ_APP_SECRET=yyy npm start
 * 或放 .env（已在 .gitignore 中排除）。
 */

import { resolveImageGenConfig } from "./media/imagegen.js";
import { resolveStickerConfig } from "./media/stickers.js";

/** intents 位 → 可读名称，用于诊断（数字本身看不出权限，这些名字可以） */
export const INTENT_NAMES = [
  [1 << 0, "GUILDS 频道基础"],
  [1 << 1, "GUILD_MEMBERS 频道成员"],
  [1 << 12, "DIRECT_MESSAGE 频道私信"],
  [1 << 25, "GROUP_AND_C2C 单聊与群@消息"],
  [1 << 26, "INTERACTION 按钮互动"],
  [1 << 30, "PUBLIC_GUILD_MESSAGES 频道@消息"],
];

/** 把 intents 掩码翻译成可读列表 */
export function describeIntents(mask) {
  return INTENT_NAMES.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
}

/** 缺哪些关键权限（用于诊断「群里为什么没反应」） */
export function missingKeyIntents(mask) {
  const missing = [];
  if ((mask & (1 << 25)) === 0) missing.push("GROUP_AND_C2C（单聊/群@消息）");
  if ((mask & (1 << 30)) === 0) missing.push("PUBLIC_GUILD_MESSAGES（频道@消息）");
  return missing;
}

/** 解析极简 .env（KEY=VALUE，支持 # 注释与引号） */
export function parseDotenv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/** 把逗号/空格分隔的 ID 列表解析成数组 */
export function parseIdList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 构建配置。
 * @param {Record<string,string|undefined>} [env]
 * @param {Record<string,string>} [overrides]
 */
export function loadConfig(env = process.env, overrides = {}) {
  const pick = (key, fallback) => {
    const v = overrides[key] ?? env[key];
    return v === undefined || v === "" ? fallback : v;
  };
  const num = (key, fallback) => {
    const v = Number(pick(key, fallback));
    return Number.isFinite(v) ? v : fallback;
  };
  /** BOT_NAME 是否被显式配置：没配时优先用「人格文件里的名字」 */
  const explicitBotName = String(overrides.BOT_NAME ?? env.BOT_NAME ?? "").trim();

  return {
    appId: pick("QQ_APP_ID", ""),
    clientSecret: pick("QQ_APP_SECRET", ""),

    /** 机器人自称（人格文件里的名字优先；这里是没有明确自我介绍时的兜底） */
    botName: pick("BOT_NAME", "春禾"),
    /** BOT_NAME 是否显式配置（未配时 main.js 会采用人格模块的 PERSONA_NAME） */
    botNameExplicit: explicitBotName !== "",
    /**
     * 人格模块：
     *   chunhe（默认，示例人格）
     *   default（通用助手人格）
     *   ./my-bot.js（你自己的文件，相对项目根目录）
     */
    persona: pick("PERSONA", "chunhe"),

    /** 正式环境 / 沙箱环境 */
    sandbox: String(pick("QQ_SANDBOX", "false")).toLowerCase() === "true",
    apiBase: pick("QQ_API_BASE", "https://api.sgroup.qq.com"),
    tokenBase: pick("QQ_TOKEN_BASE", "https://bots.qq.com"),
    sandboxApiBase: pick("QQ_SANDBOX_API_BASE", "https://sandbox.api.sgroup.qq.com"),

    /** 订阅事件掩码，默认「频道基础 + 单聊/群消息 + 互动」 */
    intents: num("QQ_INTENTS", (1 << 0) | (1 << 30) | (1 << 25) | (1 << 26)),

    /** 访问控制：空 = 全放开（仅调试），非空 = 仅白名单可用 */
    allowUsers: parseIdList(pick("QQ_ALLOW_FROM", "")),
    denyUsers: parseIdList(pick("QQ_DENY_FROM", "")),
    allowGroups: parseIdList(pick("QQ_ALLOW_GROUPS", "")),

    /**
     * 主人/管理员的用户标识（单聊的 user_openid）。
     * 只有这些人的话题才会进入**跨场景共享话题库**，从而能在群里续上。
     * 留空 = 不启用共享话题（避免把别人的私聊内容漏给群里）。
     */
    adminUsers: parseIdList(pick("QQ_ADMIN_USERS", "")),

    /**
     * 额外的「主人身份」标识（可选）。
     *
     * 为什么单独一项：QQ 的私聊标识是 user_openid，群内标识是 member_openid，
     * 平台在多数情况下并不保证两者相同（隐私设计）。默认把 QQ_ADMIN_USERS
     * 里的人也当成主人；如果真机上群内 openid 不同，把它补在这里，
     * 主人的私聊/群聊才能共享同一份记忆。
     */
    ownerUsers: parseIdList(pick("QQ_OWNER_USERS", "")),

    /** 主人长期记忆（偏好/称呼/指令）持久化路径 */
    ownerMemoryFile: pick("QQ_OWNER_MEMORY_FILE", "data/owner-memory.json"),
    /** 长期记忆最多保留多少条 */
    ownerMemoryMaxFacts: num("QQ_OWNER_MEMORY_MAX", 50),

    /** 话题库持久化路径 */
    topicFile: pick("QQ_TOPIC_FILE", "data/topics.json"),
    /** 共享受限：最多带多少条话题进上下文 */
    topicContextLimit: num("QQ_TOPIC_CONTEXT_LIMIT", 5),

    /**
     * 主动消息（"自己找话说"）。
     * 默认关闭：平台对主动消息有每日配额，且用户可关闭推送，需要显式开启。
     */
    proactive: String(pick("QQ_PROACTIVE", "false")).toLowerCase() === "true",
    proactiveIdleMinutes: num("QQ_PROACTIVE_IDLE_MINUTES", 90),
    proactiveDailyLimit: num("QQ_PROACTIVE_DAILY_LIMIT", 3),
    proactiveQuietHours: pick("QQ_PROACTIVE_QUIET_HOURS", "23-8"),
    proactiveCheckIntervalMs: num("QQ_PROACTIVE_CHECK_INTERVAL_MS", 60000),
    proactiveStateFile: pick("QQ_PROACTIVE_STATE_FILE", "data/proactive.json"),

    /** 限流：每个用户每分钟最多回复次数 */
    rateLimitPerMinute: num("QQ_RATE_LIMIT_PER_MINUTE", 12),
    /** 单会话上下文保留条数 */
    historyTurns: num("QQ_HISTORY_TURNS", 8),
    /**
     * 主人统一会话单独放大的窗口（轮）。
     *
     * 为什么只给主人放大：主人是唯一跨私聊/群聊共享记忆的人，私聊下的指令
     * 需要留在窗口里更久；其他人放大会平白增加 token。20 轮 ≈ 40 条，
     * 相对原来的 16 条是 +24 条；实际 token 由下面的字符预算兜底。
     */
    ownerHistoryTurns: num("QQ_OWNER_HISTORY_TURNS", 20),
    /**
     * 主人历史送模型前的字符预算（0=不限）。
     * 中文按 1 token/字保守估算，3000 字 ≈ 3000 token 上限；
     * 超出就从最旧的整轮开始丢，保证 token 不随窗口放大失控。
     */
    ownerHistoryMaxChars: num("QQ_OWNER_HISTORY_MAX_CHARS", 3000),

    /**
     * 跨场景待办：主人在私聊说「待会到群里做 X」，独立存起来，到群里执行。
     * 不占上面的 historyTurns 配额——这是本次修复的核心。
     */
    pendingEnabled: String(pick("QQ_PENDING_ACTIONS", "true")).toLowerCase() !== "false",
    pendingFile: pick("QQ_PENDING_FILE", "data/pending-actions.json"),
    /** 待办有效期（小时）；隔天再执行一句「卖个萌」会很突兀，默认 24h */
    pendingTtlHours: num("QQ_PENDING_TTL_HOURS", 24),
    /** 待办文件最多保留多少条（含 done/expired 审计记录） */
    pendingMaxActions: num("QQ_PENDING_MAX", 50),

    /**
     * 私聊指令怎么在群里执行：
     *   proactive（默认）= 创建后**立即主动发到群里**，不再等主人开口；
     *   deferred        = 旧行为：等主人到群里说话时随回复执行。
     */
    pendingDelivery:
      String(pick("QQ_PENDING_DELIVERY", "proactive")).toLowerCase() === "deferred"
        ? "deferred"
        : "proactive",
    /**
     * 主动消息配额账本（发之前查、发完记，重启不清零）。
     * 平台限制（官方文档）：群聊主动消息 单群 20 条/分钟、1000 条/天；
     * 功能软限制 pendingProactiveDailyLimit（默认 20/天）防止她替主人刷屏。
     */
    proactiveQuotaFile: pick("QQ_PROACTIVE_QUOTA_FILE", "data/proactive-quota.json"),
    groupProactiveDailyLimit: num("QQ_GROUP_PROACTIVE_DAILY_LIMIT", 1000),
    groupProactiveMinuteLimit: num("QQ_GROUP_PROACTIVE_MINUTE_LIMIT", 20),
    pendingProactiveDailyLimit: num("QQ_PENDING_PROACTIVE_DAILY_LIMIT", 20),
    proactiveWarnRatio: num("QQ_PROACTIVE_WARN_RATIO", 0.8),

    /**
     * 群注册表：春禾要知道「我在哪些群、每个群大概多大」。
     * 成员数接口（/v2/groups/{gid}/members）真机实测 11253 无权限，
     * 所以 observed（见过的发言人数）是下限；阈值都可配。
     */
    groupsFile: pick("QQ_GROUPS_FILE", "data/groups.json"),
    /** API 真实成员数的大群阈值 */
    groupLargeThreshold: num("QQ_GROUP_LARGE_THRESHOLD", 10),
    /** observed 下限的大群阈值（observed 系统性低估，所以比 10 低） */
    groupObservedLargeThreshold: num("QQ_GROUP_OBSERVED_LARGE_THRESHOLD", 5),
    /** 主人只说「群里」时怎么选：active=最活跃的群（默认）/ small=小群优先 */
    groupDefaultPick:
      String(pick("QQ_GROUP_DEFAULT_PICK", "active")).toLowerCase() === "small"
        ? "small"
        : "active",

    /** 主人问曲库时，最多把多少首歌名注入上下文（控制 token） */
    songLibraryLimit: num("QQ_SONG_LIBRARY_LIMIT", 60),
    /** 记忆持久化路径；留空则只放在内存里（重启即忘） */
    memoryFile: pick("QQ_MEMORY_FILE", "data/memory.json"),
    /** 消息去重窗口大小 */
    dedupeWindow: num("QQ_DEDUPE_WINDOW", 2000),

    /**
     * 群聊触发方式。
     *  - mention（默认）：只在被 @ 时回复（对应 GROUP_AT_MESSAGE_CREATE）
     *  - wake：被 @ 或正文里喊到唤名都回复（需要群主开启"接收全量消息"，
     *    否则平台只推 @ 消息，普通发言根本到不了机器人）
     *  - all：群里任何消息都回（很扰民，除非是私人小群，否则不建议）
     */
    groupTrigger: String(pick("QQ_GROUP_TRIGGER", "mention")).toLowerCase(),
    /** 唤名列表（逗号分隔） */
    wakeNames: parseIdList(pick("QQ_WAKE_NAMES", "春禾")),
    /** 非触发消息也记入上下文缓冲，让被叫到时能接上群里的对话 */
    groupWatch: String(pick("QQ_GROUP_WATCH", "true")).toLowerCase() !== "false",
    /** 上下文缓冲保留多少条 */
    groupWatchLimit: num("QQ_GROUP_WATCH_LIMIT", 10),

    /**
     * 定时提醒：让春禾能在"过一会儿"主动说一句话。
     * 属于主动消息，会占平台配额，所以有每日上限与最短延迟限制。
     */
    reminders: String(pick("QQ_REMINDERS", "true")).toLowerCase() !== "false",
    reminderFile: pick("QQ_REMINDER_FILE", "data/reminders.json"),
    reminderDailyLimit: num("QQ_REMINDER_DAILY_LIMIT", 10),
    reminderMinDelayMs: num("QQ_REMINDER_MIN_DELAY_MS", 5000),
    reminderMaxDelayMs: num("QQ_REMINDER_MAX_DELAY_MS", 7 * 86400000),
    /** 检查到期提醒的间隔（毫秒） */
    reminderTickMs: num("QQ_REMINDER_TICK_MS", 15000),

    /** 多段回复：像真人一样分几口气说，而不是一条长文 */
    multiMessage: String(pick("QQ_MULTI_MESSAGE", "true")).toLowerCase() !== "false",
    multiMessageMaxSegments: num("QQ_MULTI_MESSAGE_MAX", 3),
    multiMessageMaxChars: num("QQ_MULTI_MESSAGE_CHARS", 120),
    multiMessageMinChars: num("QQ_MULTI_MESSAGE_MIN", 60),
    multiMessageMinGapMs: num("QQ_MULTI_MESSAGE_MIN_GAP", 800),
    multiMessageMaxGapMs: num("QQ_MULTI_MESSAGE_MAX_GAP", 2000),

    /** 模型（OpenAI 兼容） */
    modelBaseUrl: pick("MODEL_BASE_URL", ""),
    modelApiKey: pick("MODEL_API_KEY", ""),
    modelName: pick("MODEL_NAME", ""),
    modelTimeoutMs: num("MODEL_TIMEOUT_MS", 60000),
    modelMaxTokens: num("MODEL_MAX_TOKENS", 800),
    /** 陌生人的初始好感度（默认 0）；主人恒定最高，不受影响 */
    affinityDefault: num("QQ_AFFINITY_DEFAULT", 0),
    /** 联网查阅（web_search / web_fetch）总开关 */
    webToolsEnabled: pick("WEB_TOOLS_ENABLED", "true") !== "false",
    /** 文件工具（列目录/读/写/搜内容）—— 仅主人 + 仅私聊 */
    fileToolsEnabled: pick("FILE_TOOLS_ENABLED", "true") !== "false",
    /** 文件工具能碰的根目录；越界一律拒绝 */
    fileToolsRoot: pick("FILE_TOOLS_ROOT", "C:/大肥鱼的小宝库"),
    /** 待办清单（多步任务跟踪）—— 仅主人 + 仅私聊 */
    todosEnabled: pick("TODOS_ENABLED", "true") !== "false",
    todoFile: pick("QQ_TODO_FILE", "data/todos.json"),
    modelTemperature: num("MODEL_TEMPERATURE", 0.9),
    /** 关闭真实模型，使用本地规则回复（无 key 时自动如此） */
    personaMode: pick("PERSONA_MODE", "auto"),

    /**
     * 视觉能力：是否把图片下载后以 base64 送给模型。
     * 实测结论：直链交给模型会因其服务端拉不到而 400，必须用 base64。
     * 非视觉模型请设为 false，否则它会对着图片凭空编造。
     */
    modelVision: String(pick("MODEL_VISION", "false")).toLowerCase() === "true",
    /** 送进模型的图片大小上限（字节） */
    visionMaxBytes: num("MODEL_VISION_MAX_BYTES", 5 * 1024 * 1024),
    /** 图片下载超时（毫秒） */
    visionTimeoutMs: num("MODEL_VISION_TIMEOUT_MS", 15000),

    /**
     * 语音回复（TTS）。
     *
     * off    = 不发语音（默认；语音能力完全可选，关掉不影响任何文字功能）
     * mirror = 收到语音才用语音回（对称、且是被动消息，不受主动配额限制）
     * always = 私聊所有回复都用语音
     *
     * 合成在可选的 Python 助手里完成（tools/tts_silk.py），助手缺失时自动降级为文字。
     */
    voiceReply: String(pick("QQ_VOICE_REPLY", "off")).toLowerCase(),
    /** 音色；默认 zh-CN-XiaoyiNeural（年轻活泼） */
    ttsVoice: pick("TTS_VOICE", "zh-CN-XiaoyiNeural"),
    /** 跑助手的 Python；留空则用 PATH 上的 python */
    ttsPython: pick("TTS_PYTHON", ""),
    /** 助手脚本路径；留空使用仓库内默认位置 */
    ttsScript: pick("TTS_SCRIPT", ""),
    ttsRate: pick("TTS_RATE", "+0%"),
    ttsPitch: pick("TTS_PITCH", "+0Hz"),
    /** 单条语音最长念多少字（QQ 语音有时长上限） */
    ttsMaxChars: num("TTS_MAX_CHARS", 120),
    ttsTimeoutMs: num("TTS_TIMEOUT_MS", 20000),
    /**
     * 群聊语音策略（原样传给 media/tts.js 解析）：
     *   false（默认）/ off   = 群里一律不发语音
     *   on-demand            = 只在明确要求「用语音说…」时才发
     *   true / always        = 与私聊一致（mirror/always）
     * 不在这里转布尔：on-demand 需要第三态，转 boolean 会把语义压扁。
     */
    ttsAllowGroup: String(pick("TTS_ALLOW_GROUP", "false")).trim().toLowerCase(),

    // ---- 语音音色：RVC 绮萱变声（edge-tts 小易 → 绮萱）----
    // 关掉就退回纯 edge-tts；RVC 失败/超时也会自动退回，不会没声音。
    rvcEnabled: String(pick("QQ_VOICE_RVC", "true")).toLowerCase() !== "false",
    /** 必须用变声器自带的 CUDA torch python，不能用 .voice-venv */
    rvcPython: pick("RVC_PYTHON", ""),
    rvcScript: pick("RVC_SCRIPT", ""),
    rvcModel: pick("RVC_MODEL", ""),
    rvcIndex: pick("RVC_INDEX", ""),
    /** 上一轮试听选出的最优组合：小易 + key+2 + idx0.7 + prot0.33 */
    rvcKey: num("RVC_KEY", 2),
    rvcIndexRate: num("RVC_INDEX_RATE", 0.7),
    rvcProtect: num("RVC_PROTECT", 0.33),
    rvcRmsMix: num("RVC_RMS_MIX", 0.25),
    rvcF0Method: pick("RVC_F0_METHOD", "rmvpe"),
    rvcDevice: pick("RVC_DEVICE", "cuda"),
    rvcTimeoutMs: num("RVC_TIMEOUT_MS", 30000),
    /** RVC 源码/中间文件的 ASCII junction（Windows 窄字符路径限制） */
    rvcRoot: pick("RVC_ROOT", ""),
    rvcIoDir: pick("RVC_IO_DIR", ""),
    /** 常驻 worker：模型/RMVPE/index 只加载一次，否则每句固定 20~30s */
    rvcWorker: String(pick("RVC_WORKER", "true")).toLowerCase() !== "false",
    rvcStartupTimeoutMs: num("RVC_STARTUP_TIMEOUT_MS", 60000),
    /** 情绪韵律层（一条回复判一次） */
    ttsEmotion: String(pick("TTS_EMOTION", "true")).toLowerCase() !== "false",
    emotionModule: pick("EMOTION_MODULE", ""),
    emotionMode: pick("EMOTION_MODE", "rules"),
    /** RVC 链路的 SILK 码率：48kbps 明显比 24k 干净 */
    silkBitrate: num("SILK_BITRATE", 48000),
    // ---- 成品语音缓存（重复短句秒回）----
    voiceCacheEnabled: String(pick("VOICE_CACHE_ENABLED", "true")).toLowerCase() !== "false",
    voiceCacheDir: pick("VOICE_CACHE_DIR", ""),
    voiceCacheMaxEntries: num("VOICE_CACHE_MAX_ENTRIES", 200),
    voiceCacheMaxMb: num("VOICE_CACHE_MAX_MB", 50),

    /**
     * 画图（DeepSeek 工具调用 → 火山方舟 Seedream → QQ 富媒体图片）。
     *
     * ⚠️ 没有 ARK_API_KEY 时 enabled=false，buildToolList 返回空数组，
     * 请求体里连 tools 字段都不会出现——等于这个功能不存在，
     * 而不是给模型装一个必然失败的工具（那会每轮都调、每次都失败）。
     */
    imageGen: resolveImageGenConfig({
      ARK_API_KEY: pick("ARK_API_KEY", ""),
      ARK_BASE_URL: pick("ARK_BASE_URL", ""),
      ARK_IMAGE_MODEL: pick("ARK_IMAGE_MODEL", ""),
      ARK_IMAGE_SIZE: pick("ARK_IMAGE_SIZE", ""),
      // 角色参考图：配上它，春禾画出来就一直是「她自己」的长相
      ARK_IMAGE_REFERENCE: pick("ARK_IMAGE_REFERENCE", ""),
      // 角色锚定：不可妥协的人设特征，每次生图都拼在最前面
      IMAGE_GEN_CHARACTER_LOCK: pick("IMAGE_GEN_CHARACTER_LOCK", ""),
      IMAGE_GEN_ENABLED: pick("IMAGE_GEN_ENABLED", "true"),
      IMAGE_GEN_TIMEOUT_MS: pick("IMAGE_GEN_TIMEOUT_MS", ""),
      IMAGE_GEN_MAX_ROUNDS: pick("IMAGE_GEN_MAX_ROUNDS", ""),
      IMAGE_GEN_MAX_BYTES: pick("IMAGE_GEN_MAX_BYTES", ""),
    }),

    /**
     * 表情包（自定义贴图）。
     *
     * QQ 没有独立的表情包消息类型，所以走的就是图片那条路（file_type=1）。
     * 素材目录为空时不注册工具——与画图没 key 就不注册同一个原则。
     */
    stickers: resolveStickerConfig({
      STICKER_ENABLED: pick("STICKER_ENABLED", "true"),
      STICKER_DIR: pick("STICKER_DIR", ""),
      STICKER_MAX_BYTES: pick("STICKER_MAX_BYTES", ""),
      STICKER_MAX_COUNT: pick("STICKER_MAX_COUNT", ""),
      STICKER_AUTO: pick("STICKER_AUTO", "true"),
    }),

    // ---- 唱歌（DiffSinger 歌声合成）----
    // 复用 TTS 的 Python 解释器（同一个 .voice-venv 里既有 edge-tts 也有 onnxruntime）
    singEnabled: String(pick("QQ_SING_ENABLED", "true")).toLowerCase() !== "false",
    singPython: pick("SING_PYTHON", ""),
    singScript: pick("SING_SCRIPT", ""),
    singScore: pick("SING_SCORE", ""),
    /** 成品曲库目录（点歌优先发这里的成品；留空 = 用 sing.js 里的默认路径） */
    singLibraryDir: pick("SING_LIBRARY_DIR", ""),
    /** 多段成品歌之间的间隔（毫秒），默认 5000 */
    singLibraryGapMs: num("SING_LIBRARY_GAP_MS", 5000),
    singSingerDir: pick("SING_SINGER_DIR", ""),
    singVoicebank: pick("SING_VOICEBANK", ""),
    singVocoder: pick("SING_VOCODER", ""),
    singVibratoCents: num("SING_VIBRATO_CENTS", 70),
    singScoopCents: num("SING_SCOOP_CENTS", 150),
    singPortamentoMs: num("SING_PORTAMENTO_MS", 35),
    singTimeoutMs: num("SING_TIMEOUT_MS", 240000),
    singTmpDir: pick("SING_TMP_DIR", ""),

    // ---- 远程控制（第四档：任意命令执行，仅私聊）----
    // 默认关闭。启用需同时设置 REMOTE_ENABLED=true 与 REMOTE_PASS_HASH
    remoteEnabled: String(pick("REMOTE_ENABLED", "false")).toLowerCase() === "true",
    remotePassHash: pick("REMOTE_PASS_HASH", ""),
    remoteTtlMs: num("REMOTE_TTL_MS", 600000),
    remoteTimeoutMs: num("REMOTE_TIMEOUT_MS", 30000),
    remoteMaxOutput: num("REMOTE_MAX_OUTPUT", 1500),
    remoteShell: pick("REMOTE_SHELL", "cmd"),
    /**
     * 自然语言 agent：解锁后主人说人话，模型自己翻译成命令、执行、看结果、再下一步。
     * maxSteps 是连续执行的步数上限（刹车，防止它自己绕圈烧 token）。
     */
    remoteAgentEnabled: String(pick("REMOTE_AGENT_ENABLED", "true")).toLowerCase() !== "false",
    remoteAgentMaxSteps: num("REMOTE_AGENT_MAX_STEPS", 5),

    /**
     * 文件识别：收到 .docx/.xlsx/.pptx/代码/CSV 等附件时，下载并提取文本交给模型。
     * 注意：这会让模型读到文件内容，务必保证只给自己信任的会话开启（配合白名单）。
     */
    fileReading: String(pick("MODEL_FILE_READING", "true")).toLowerCase() !== "false",
    /** 下载的文件大小上限（字节） */
    fileMaxBytes: num("MODEL_FILE_MAX_BYTES", 10 * 1024 * 1024),
    /** 文件下载超时（毫秒） */
    fileTimeoutMs: num("MODEL_FILE_TIMEOUT_MS", 20000),
    /** 提取文本的总长度上限（字符） */
    fileMaxChars: num("MODEL_FILE_MAX_CHARS", 20000),
    /** 放进提示词的文件内容上限（字符，比 maxChars 小，控制 token） */
    filePromptChars: num("MODEL_FILE_PROMPT_CHARS", 6000),

    /**
     * AI 明示标识。
     * 合规背景：QQ 运营规范禁止"引导用户不披露真实身份"，所以默认保留标识。
     *   prefix — 【AI】你好（默认）
     *   suffix — 你好 【AI】
     *   none   — 不加标识；此时必须靠正文自报家门，否则简短回复会没有 AI 提示
     */
    aiLabel: pick("AI_LABEL", "【AI】"),
    aiLabelStyle: pick("AI_LABEL_STYLE", "none"),

    logLevel: pick("LOG_LEVEL", "info"),
    /** 打开后打印网关收到的每一个原始事件（排查「为什么收不到某类消息」用） */
    debugRawEvents: String(pick("QQ_DEBUG_RAW_EVENTS", "false")).toLowerCase() === "true",
    /** 会话持久化路径（含 session_id，敏感） */
    sessionFile: pick("QQ_SESSION_FILE", "data/session.json"),

    /**
     * 双引擎切换脚本（「春禾启动主脑」用）。
     * 留空 = 按源码目录 / 项目根 / cwd 自动查找 switch-brain.ps1
     * （脚本放在宝库根 C:\大肥鱼的小宝库\，不在项目里）。
     */
    brainSwitchScript: pick("QQ_BRAIN_SWITCH_SCRIPT", ""),
    /** 跑切换脚本用的 PowerShell；留空 = 系统自带 5.1 */
    brainSwitchPowershell: pick("QQ_BRAIN_SWITCH_POWERSHELL", ""),
  };
}

/** 配置自检：返回问题列表，空数组表示可用 */
export function validateConfig(cfg, { requireCredentials = true } = {}) {
  const problems = [];
  if (requireCredentials) {
    if (!cfg.appId) problems.push("缺少 QQ_APP_ID");
    if (!cfg.clientSecret) problems.push("缺少 QQ_APP_SECRET");
    if (cfg.appId && !/^[0-9]{6,}$/.test(cfg.appId)) {
      problems.push(`QQ_APP_ID 格式可疑：${cfg.appId}`);
    }
  }
  if (cfg.rateLimitPerMinute <= 0) problems.push("QQ_RATE_LIMIT_PER_MINUTE 必须为正");
  if (cfg.historyTurns < 0) problems.push("QQ_HISTORY_TURNS 不能为负");
  if (cfg.ownerHistoryTurns < 0) problems.push("QQ_OWNER_HISTORY_TURNS 不能为负");
  if (cfg.ownerHistoryMaxChars < 0) problems.push("QQ_OWNER_HISTORY_MAX_CHARS 不能为负");
  if (cfg.pendingTtlHours <= 0) problems.push("QQ_PENDING_TTL_HOURS 必须为正");
  if (cfg.pendingProactiveDailyLimit < 0) {
    problems.push("QQ_PENDING_PROACTIVE_DAILY_LIMIT 不能为负");
  }
  if (cfg.groupProactiveDailyLimit <= 0 || cfg.groupProactiveMinuteLimit <= 0) {
    problems.push("QQ_GROUP_PROACTIVE_DAILY_LIMIT / MINUTE_LIMIT 必须为正");
  }
  if (cfg.groupLargeThreshold <= 0 || cfg.groupObservedLargeThreshold <= 0) {
    problems.push("QQ_GROUP_LARGE_THRESHOLD / OBSERVED_LARGE_THRESHOLD 必须为正");
  }
  return problems;
}

/** 取当前环境对应的 API 基址（沙箱 vs 正式） */
export function resolveApiBase(cfg) {
  return cfg.sandbox ? cfg.sandboxApiBase : cfg.apiBase;
}
