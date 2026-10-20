/**
 * 语音合成（TTS）→ tencent SILK。
 *
 * 设计约束（都很重要）：
 *
 *  1. **JS 侧保持零依赖。** Node 官方没有任何可用的中文 TTS，也没有 tencent SILK
 *     编码器。所以真正的合成交给一个**可选的 Python 助手**
 *     （tools/tts_silk.py，依赖 edge-tts + pysilk + miniaudio），本模块只负责
 *     拼命令行、跑子进程、读结果。助手不存在时功能自动失效，文字聊天毫发无伤。
 *
 *  2. **任何失败都降级，绝不抛。** 调用方拿到的一律是 {ok, reason}，
 *     所以「语音挂了」永远不会升级成「这条消息没回」。
 *
 *  3. **为什么必须是 tencent SILK。** QQ 官方平台的富媒体语音只吃
 *     tencent silk（`\x02#!SILK_V3` 头），mp3/wav 直接上传会被拒。
 *     pysilk 的 `tencent=True` 正是产出这个头。
 */

import { spawn as nodeSpawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatForQQ } from "../util/format.js";
import { getRvcWorker } from "./rvc-worker.js";
import { botName } from "../persona/naming.js";
import {
  SILK_MAGIC,
  createVoiceCache,
  resolveVoiceCacheConfig,
} from "./voice-cache.js";

/** 温柔但年轻活泼的音色；Xiaoyi 的官方标签就是 Lively。 */
export const DEFAULT_VOICE = "zh-CN-XiaoyiNeural";

export const VOICE_MODES = {
  OFF: "off",
  /** 收到语音才用语音回（推荐：对称、不打扰、被动消息不受配额限制） */
  MIRROR: "mirror",
  /** 私聊所有回复都用语音 */
  ALWAYS: "always",
};

/**
 * 群聊语音的三种策略（TTS_ALLOW_GROUP）。
 *
 * 为什么不是简单的 true/false：
 *   - false（默认）：群聊一律不发语音。群消息是公共场合，默认开口说话很打扰；
 *   - on-demand：**只有主人/群友明确要求「用语音说…」时**才发语音。
 *     这是本项目的生产设置：能力可用，但绝不对普通群消息主动开口；
 *   - true：保持旧语义（与私聊一致：mirror 收到语音回语音，always 全语音）。
 *
 * 为什么默认不选 on-demand 而仍是 off：语音合成要走 TTS→RVC→SILK（约 4s、
 * 占 GPU），群消息频率又远高于私聊；默认关着最稳，需要时在 .env 显式打开。
 */
export const VOICE_GROUP_MODES = Object.freeze({
  OFF: "off",
  ON_DEMAND: "on-demand",
  ALWAYS: "always",
});

/** 把 TTS_ALLOW_GROUP 的宽松写法归一成三种策略 */
export function resolveGroupVoiceMode(value) {
  const s = str(value).toLowerCase();
  if (["true", "always", "all", "on", "yes", "1"].includes(s)) return VOICE_GROUP_MODES.ALWAYS;
  if (["on-demand", "ondemand", "on_demand", "demand", "explicit", "ask"].includes(s)) {
    return VOICE_GROUP_MODES.ON_DEMAND;
  }
  return VOICE_GROUP_MODES.OFF;
}

export const DEFAULT_MAX_CHARS = 120;
export const DEFAULT_TIMEOUT_MS = 20000;

/**
 * QQ 语音消息时长上限（官方建议 ≤ 58 秒）。
 *
 * 放在合成层而不是只在发送层挡：合成结果会被写进缓存，若先缓存再在发送层
 * 拒收，下次同文本会命中缓存、绕过发送层检查，把超长语音发出去。
 * 所以超长音频在这里就判失败，根本不进缓存。
 */
export const MAX_QQ_VOICE_MS = 58000;

/**
 * 音色链路的生产默认值（绮萱）。
 *
 * 关键：RVC 必须用**自带 CUDA torch 的 python**，不能用 .voice-venv 的；
 * 且模型/RVC 源码要走 ASCII 路径（Windows 下 faiss / vosk / read_text 的窄字符
 * API 会按 cp936 打开含中文的路径而失败）。`rvc-qixuan\src` 与 `io` 是指向
 * 真实目录的 junction，字符串本身是纯 ASCII，Windows 会在内核层解析。
 */
export const DEFAULT_RVC_PYTHON =
  "C:\\VoiceChanger\\python\\python.exe";
export const DEFAULT_RVC_SCRIPT = "C:\\VoiceChanger\\rvc_convert.py";
export const DEFAULT_RVC_MODEL = "C:\\VoiceChanger\\models\\voice.pth";
export const DEFAULT_RVC_INDEX = "C:\\VoiceChanger\\models\\voice.index";
export const DEFAULT_RVC_ROOT = "C:\\VoiceChanger\\rvc\\src";
export const DEFAULT_RVC_IO_DIR = "C:\\VoiceChanger\\rvc\\io";
export const DEFAULT_EMOTION_MODULE =
  "C:\\VoiceChanger\\emotion.py";
export const DEFAULT_SILK_BITRATE = 48000;

/** 修 bug 时快速关掉 RVC 的开关值（默认 true）。 */
function boolTrue(v) {
  return str(v ?? "true").toLowerCase() !== "false";
}

/** 允许负数与小数的数值解析（RVC_KEY 可能是 -12，index-rate 是 0.7）。 */
function fnum(v, fallback) {
  const n = Number.parseFloat(str(v));
  return Number.isFinite(n) ? n : fallback;
}

/** 允许 0 的正数解析（protect=0 是合法参数）。 */
function numZero(v, fallback) {
  const n = Number.parseFloat(str(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}


const VALID_MODES = new Set(Object.values(VOICE_MODES));

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function num(v, fallback) {
  const n = Number.parseInt(str(v), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 助手脚本默认位置：<repo>/tools/tts_silk.py */
export function defaultScriptPath() {
  return path.join(import.meta.dirname, "..", "..", "tools", "tts_silk.py");
}

/**
 * 从环境变量解析语音配置。
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveTtsConfig(env = {}) {
  const raw = str(env.QQ_VOICE_REPLY).toLowerCase();
  const mode = VALID_MODES.has(raw) ? raw : VOICE_MODES.OFF;

  return {
    mode,
    enabled: mode !== VOICE_MODES.OFF,
    voice: str(env.TTS_VOICE) || DEFAULT_VOICE,
    rate: str(env.TTS_RATE) || "+0%",
    pitch: str(env.TTS_PITCH) || "+0Hz",
    python: str(env.TTS_PYTHON),
    script: str(env.TTS_SCRIPT) || defaultScriptPath(),
    maxChars: num(env.TTS_MAX_CHARS, DEFAULT_MAX_CHARS),
    timeoutMs: num(env.TTS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    /**
     * 群聊策略：off / on-demand / always（见 VOICE_GROUP_MODES）。
     * allowGroup 保留为旧布尔语义（true 仅当 always），避免旧调用方/测试忽然改变行为。
     */
    groupMode: resolveGroupVoiceMode(env.TTS_ALLOW_GROUP),
    allowGroup: resolveGroupVoiceMode(env.TTS_ALLOW_GROUP) === VOICE_GROUP_MODES.ALWAYS,

    /**
     * RVC 变声（edge-tts 小易 → 绮萱）。
     * 默认开启；失败/超时会回退成纯 edge-tts，而不是没声音。
     */
    rvc: {
      enabled: boolTrue(env.QQ_VOICE_RVC),
      python: str(env.RVC_PYTHON) || DEFAULT_RVC_PYTHON,
      script: str(env.RVC_SCRIPT) || DEFAULT_RVC_SCRIPT,
      model: str(env.RVC_MODEL) || DEFAULT_RVC_MODEL,
      index: str(env.RVC_INDEX) || DEFAULT_RVC_INDEX,
      key: fnum(env.RVC_KEY, 2),
      indexRate: fnum(env.RVC_INDEX_RATE, 0.7),
      protect: fnum(env.RVC_PROTECT, 0.33),
      rmsMixRate: fnum(env.RVC_RMS_MIX, 0.25),
      f0Method: str(env.RVC_F0_METHOD) || "rmvpe",
      device: str(env.RVC_DEVICE) || "cuda",
      timeoutMs: num(env.RVC_TIMEOUT_MS, 30000),
      root: str(env.RVC_ROOT) || DEFAULT_RVC_ROOT,
      ioDir: str(env.RVC_IO_DIR) || DEFAULT_RVC_IO_DIR,
      silkBitrate: num(env.SILK_BITRATE, DEFAULT_SILK_BITRATE),
      /** 常驻 worker：避免每句都重新加载模型/RMVPE/index（默认开） */
      worker: boolTrue(env.RVC_WORKER),
      startupTimeoutMs: num(env.RVC_STARTUP_TIMEOUT_MS, 60000),
    },

    /** 情绪韵律层：在 TTS 助手内部判一次，把 prosody 传给 edge-tts。 */
    emotion: {
      enabled: boolTrue(env.TTS_EMOTION),
      module: str(env.EMOTION_MODULE) || DEFAULT_EMOTION_MODULE,
      mode: str(env.EMOTION_MODE) || "rules",
    },

    /** 成品 SILK 缓存（命中时三步全跳过）。 */
    cache: resolveVoiceCacheConfig(env),
  };
}

/**
 * 装饰性字符：emoji、变体选择符、肤色修饰、零宽连接符、区域指示符（国旗）、按键帽。
 *
 * 这里用 `\p{Extended_Pictographic}` 而**不是** `\p{Emoji}`——后者把 0-9、#、*
 * 也算作 emoji，会把数字一起删掉。
 */
const EMOJI_RE =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0E\uFE0F\u200D\u20E3]/gu;

/**
 * 把文本清洗成「适合念出来」的样子。
 *
 * 背景：春禾的回复天然带大量 emoji（🌸✨💖）和 markdown（**强调**）。
 * 这些在屏幕上好看，但 TTS 会**把 emoji 的名字念出来**（实测会读出
 * "sparkles" / "cherry blossom" 之类），听起来非常怪。
 *
 * 清洗原则：
 *   - emoji / 装饰符号 → **删掉**（留下的空格正好当停顿）
 *   - 语气符号 `～` 与中文标点 → **保留**，它们本身就是语气
 *   - markdown 标记 → 去标记留文字
 *   - 【】「」等方括号 → 去括号留内容（于是【AI】会念成 "AI"，合规声明不丢）
 *
 * 清洗后**可能变成空串**（整条都是 emoji）。调用方必须据此跳过语音、退回文字。
 */
export function stripForSpeech(text) {
  let s = String(text ?? "");
  if (!s) return "";

  // 先复用 QQ 文本格式化：LaTeX→Unicode、上下标、markdown、括号动作描写。
  // 对语音尤其关键——否则 TTS 会照着念 \( \alpha \cdots 这些反斜杠。
  // formatForQQ 幂等，engine 已经调过一次也无妨。
  s = formatForQQ(s);

  // ⚠️ 2026-10-19：场景标注也不能念出来。
  //   真机：她的回复里带「〔私聊〕」「〔群聊〕」前缀（历史注入导致模型模仿）。
  //   文本侧已在 engine.#sendOne 兜底剥掉；语音侧在这里再剥一次。
  s = s.replace(/〔\s*(?:私聊|群聊)(?:\s*·\s*[^〕]*)?\s*〕/g, " ");

  // ⚠️ 2026-10-18 修：**元信息绝对不能念出来**。
  // 真机故障：语音消息的回复被念成「语音春禾收到啦～转写成：xxx」，
  // 因为媒体附注（`[用户发来语音，语音转写：…]`）被拼进了用户消息、模型又复述了一遍。
  // 这里做最后一道保险：无论上游怎么拼，念之前先清掉这些机器腔。
  s = s.replace(/（?\s*系统附注[^）)]*[）)]?/g, " ");
  s = s.replace(/\[?\s*用户发来[^\]]*\]?/g, " ");
  s = s.replace(/语音\s*春禾收到啦[～~]?\s*/g, " ");
  s = s.replace(/语音\s*转写\s*[：:]?\s*/g, " ");
  s = s.replace(/转写成\s*[：:]?\s*/g, " ");
  s = s.replace(/（?\s*春禾用语音说了\s*[：:]?\s*/g, " ");

  // 行首的标题与列表标记
  s = s.replace(/^[ \t]*[-*+>#]+[ \t]+/gm, "");
  // 残余的孤立星号（p* / 2*3 这类）
  s = s.replace(/\*/g, "");
  // emoji 与装饰符号
  s = s.replace(EMOJI_RE, "");
  // 方括号类：去括号，留内容
  s = s.replace(/[【】「」『』〔〕〖〗（）()[\]]/g, "");
  // 空白归一
  s = s.replace(/\s+/g, " ");
  // 删掉 emoji 后可能留下 " ，" 这种悬空标点
  s = s.replace(/[ \t]+([，。！？、；：])/g, "$1");
  // 重复标点收敛
  s = s.replace(/([，。！？、；：])\1+/g, "$1");
  // 首尾悬空的标点与分隔符（但句末的 。！？ 与语气符号 ～ 要留着）
  s = s.replace(/^[，。！？、；：\s]+/, "").replace(/[，、；：\s]+$/, "");

  return s.trim();
}

/**
 * 压缩成「适合念出来」的文本。
 * 换行、连续空白、代码块在语音里都很难听，所以先归一化再按上限裁剪；
 * 裁剪时尽量落在句读处，避免把一句话砍成半截。
 */
export function truncateForSpeech(text, maxChars = DEFAULT_MAX_CHARS) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";

  const limit = num(maxChars, DEFAULT_MAX_CHARS);
  if (s.length <= limit) return s;

  const head = s.slice(0, limit);
  const cut = Math.max(
    head.lastIndexOf("。"),
    head.lastIndexOf("！"),
    head.lastIndexOf("？"),
    head.lastIndexOf("，"),
    head.lastIndexOf("."),
    head.lastIndexOf("!"),
    head.lastIndexOf("?"),
  );
  // 只有切点足够靠后（不短于 60%）才用它，否则宁可硬截
  return cut >= Math.floor(limit * 0.6) ? head.slice(0, cut + 1) : head;
}

/** 情绪层参数（TTS 助手会 import emotion.py 并调用 as_edge_kwargs）。 */
function appendEmotionArgs(args, cfg) {
  const em = cfg?.emotion;
  if (!em?.enabled) return args;
  args.push("--emotion");
  if (em.module) args.push("--emotion-module", em.module);
  if (em.mode) args.push("--emotion-mode", em.mode);
  return args;
}

/** 构造助手命令行参数。 */
export function buildTtsArgs({ scriptPath, text, outPath, cfg }) {
  const args = [scriptPath, "--text", text, "--out", outPath, "--voice", cfg.voice];
  if (cfg.rate && cfg.rate !== "+0%") args.push("--rate", cfg.rate);
  if (cfg.pitch && cfg.pitch !== "+0Hz") args.push("--pitch", cfg.pitch);
  return appendEmotionArgs(args, cfg);
}

/**
 * RVC 链路第一步：只合成 WAV（不编码 SILK）。
 *
 * 中间 WAV 固定落在 ASCII 的 rvc io 目录：RVC 的 Python C 扩展按窄字符打开路径，
 * 含中文的临时路径会让它直接失败。
 */
export function buildTtsWavArgs({ scriptPath, text, wavPath, cfg }) {
  const args = [scriptPath, "--text", text, "--wav-out", wavPath, "--voice", cfg.voice];
  if (cfg.rate && cfg.rate !== "+0%") args.push("--rate", cfg.rate);
  if (cfg.pitch && cfg.pitch !== "+0Hz") args.push("--pitch", cfg.pitch);
  return appendEmotionArgs(args, cfg);
}

/** 构造 RVC 变声命令行参数。 */
export function buildRvcArgs({ scriptPath, inPath, outPath, rvc }) {
  return [
    scriptPath,
    "--in",
    inPath,
    "--out",
    outPath,
    "--model",
    rvc.model,
    "--index",
    rvc.index,
    "--key",
    String(rvc.key),
    "--index-rate",
    String(rvc.indexRate),
    "--protect",
    String(rvc.protect),
    "--rms-mix-rate",
    String(rvc.rmsMixRate),
    "--f0-method",
    rvc.f0Method,
    "--device",
    rvc.device,
  ];
}

/** 构造「已有 WAV → tencent SILK」命令行参数。 */
export function buildSilkArgs({ scriptPath, inPath, outPath, bitrate }) {
  return [scriptPath, "--in", inPath, "--out", outPath, "--bitrate", String(bitrate)];
}

/**
 * 在文字里直接点名「用语音说」的措辞。
 *
 * 为什么必须有：mirror 模式原来只认「对方发来语音」，于是主人**打字**说
 * 「你能用语音说句话吗」，她回了一长段文字（真机实测 32 字）。这不是配置问题，
 * 是「意图已经写在话里、引擎却没看」。
 *
 * 两类分开是有原因的：
 *  - STRONG 直接点名通道（用语音/用声音/发语音/语音回我），几乎不可能是别的意思；
 *  - SAY 是"说出声"的动作短语（说句话/念一下/我要听你说），单独出现也算点播。
 */
const VOICE_REQUEST_STRONG = [
  /用语音(说|讲|回|念|聊|来)/,
  /用声音(说|讲|回|念)/,
  /语音(说|讲|回我|回一句|来一?句)/,
  /发(一?条|个)?语音/,
  /说话给我听/,
  /我要听你说/,
];

const VOICE_REQUEST_SAY = [
  /说句话/,
  /说个?(话|句)/,
  /说出来/,
  /念一下/,
  /念给/,
  /讲(一?句|个?段)/,
];

/**
 * 「能力/功能询问」的措辞：在问**有没有**这个功能，不是在点播。
 *
 * 真机反例：「你会用语音吗」「语音功能怎么样」——若也触发语音，
 * 她会对一句纯提问突然开口说话，比回文字更怪。
 */
const VOICE_CAPABILITY_QUESTION = [
  /(能|会|可以|会不会|能不能|能否|可不可以)/,
  /(支持|有|有没有).{0,4}(语音|声音)/,
  /(语音|声音).{0,3}(功能|支持)/,
  /(语音|声音).{0,4}(吗|么|嘛)\s*$/,
  /(怎么样|怎么用|如何使用|如何|是什么|是怎么|怎么开|在哪|设置)/,
];

/** 「敞开心扉」的说法：把心里话说出来 ≠ 用语音说 */
const CONFIDE_IDIOM = /(心里话|真心话|实话|真话|想法|心事)/;

/**
 * 这句话是不是在要求「用语音说给我听」？
 *
 * 顺序很重要：先排除能力询问/倾诉 idiom（它们常常也含"说句""说出来"），
 * 再看有没有点播措辞。
 *
 * @param {string} text 用户原话（已去 @）
 */
export function wantsVoiceReply(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;

  const strong = VOICE_REQUEST_STRONG.some((re) => re.test(raw));
  const say = VOICE_REQUEST_SAY.some((re) => re.test(raw));

  // 只是问「有没有这个功能」、又没真的要她说点什么 → 别开口
  if (!say && VOICE_CAPABILITY_QUESTION.some((re) => re.test(raw))) return false;
  // 只是想把心里话说出来（而且是纯文字语境）→ 别开口
  if (!strong && CONFIDE_IDIOM.test(raw)) return false;

  return strong || say;
}

/**
 * 这条回复该不该用语音发？
 *
 * @param {object} p
 * @param {ReturnType<typeof resolveTtsConfig>} p.cfg
 * @param {{type?: string}|null} [p.media]
 * @param {'c2c'|'group'} p.scope
 * @param {string} [p.text] 用户这一轮的原话（用于识别显式语音请求）
 */
export function decideVoiceReply({ cfg, media, scope, text, atMention = false, isOwner = false }) {
  if (!cfg?.enabled) return false;
  if (scope === "group") {
    const mode = cfg.groupMode ?? (cfg.allowGroup ? VOICE_GROUP_MODES.ALWAYS : VOICE_GROUP_MODES.OFF);
    // 总开关关着 → 群里怎么都不会开口（保持 TTS_ALLOW_GROUP=false 的旧语义）
    if (mode === VOICE_GROUP_MODES.OFF) return false;
    if (mode === VOICE_GROUP_MODES.ON_DEMAND) {
      // ① 明确点播「用语音说…」→ 谁都可以
      if (wantsVoiceReply(text)) return true;
      // ② 主人（群主）不受 @ 限制：他在群里发语音就回语音（mirror 语义）。
      //    主人是最高优先级身份，不该因为「群里默认文字」而被降级。
      if (isOwner && media?.type === "voice") return true;
      // ③ 普通群友：**@ 她 = 叫到她了 → 用语音回**（2026-10-19 主人明确要求）。
      //    不 @ 就一律文字，避免群里每条回复都被念出来。
      if (atMention && !isOwner) return true;
      return false;
    }
  }
  if (cfg.mode === VOICE_MODES.ALWAYS) return true;
  // 文字里点名要语音：即便对方这条是纯文字，也要真的开口
  if (wantsVoiceReply(text)) return true;
  return media?.type === "voice";
}

/**
 * 这句话是不是在问「你能不能（在群里）发语音」？
 *
 * 与 wantsVoiceReply 的区别：
 *   - 「用语音说句话」是**点播** → wantsVoiceReply=true，引擎直接发语音；
 *   - 「你现在能在群里发语音吗」是**问能力** → wantsVoiceReply=false（能力询问
 *     不算点播），但模型很容易顺着「我是 AI」答成「做不到」。
 *     引擎据此用一个确定性闸门纠正（见 engine.js），所以需要单独识别。
 */
export function isVoiceCapabilityQuestion(text) {
  const s = String(text ?? "").trim();
  if (!s) return false;
  if (!/(语音|声音)/.test(s)) return false;
  // 明确的点播不是能力询问：那种情况引擎会直接做，不需要文字解释
  if (wantsVoiceReply(s)) return false;
  return (
    /(能|会|可以|支持|有没有|能不能|会不会|可不可以)/.test(s) ||
    /(功能|怎么样|怎么用|如何使用|如何|是什么|怎么开|设置)/.test(s)
  );
}

/**
 * 「群里/私聊能不能发语音」的**确定性真话**。
 *
 * 真机 bug：主人在私聊问「你现在能在群里发语音吗？」，她答「做不到」。
 * 能力其实早就有了（#uploadVoice 已按 scope 选管道），只是群语音当时被
 * TTS_ALLOW_GROUP=false 关着。这里按**当前真实配置**生成一句话，
 * 不交给模型猜；也没有笼统的「做不到」。
 *
 * @param {ReturnType<typeof resolveTtsConfig>} cfg
 * @param {{scope?: 'c2c'|'group', askGroup?: boolean}} [opts]
 * @returns {string}
 */
export function describeVoiceCapabilityAnswer(cfg, { scope = "c2c", askGroup = false } = {}) {
  if (!cfg?.enabled) {
    return "" + botName() + "的语音总开关现在是关着的，私聊和群里都还发不出语音。";
  }
  const groupMode =
    cfg.groupMode ?? (cfg.allowGroup ? VOICE_GROUP_MODES.ALWAYS : VOICE_GROUP_MODES.OFF);
  if (askGroup || scope === "group") {
    if (groupMode === VOICE_GROUP_MODES.OFF) {
      return "群里还没开通语音，所以" + botName() + "现在在群里只能打字（私聊里是能发语音的）。";
    }
    if (groupMode === VOICE_GROUP_MODES.ON_DEMAND) {
      return "可以的～在群里 @ " + botName() + "，或者明确说「用语音说」，" + botName() + "就用语音回；没 @ 的普通消息还是打字，免得刷屏。";
    }
    return "可以的，群里也会用语音回～";
  }
  return "可以呀，" + botName() + "能发语音：私聊里想听就让" + botName() + "用语音说；群里 @ " + botName() + "或明确说「用语音说」才会发语音。";
}

/** 把子进程包成 {code, stdout, stderr, error, timedOut}，永不 reject。 */
function runChild(spawnImpl, cmd, args, timeoutMs, extraEnv) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cmd, args, {
        windowsHide: true,
        env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
      });
    } catch (err) {
      resolve({ code: -1, error: err, stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let done = false;
    let timer = null;

    const finish = (payload) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, ...payload });
    };

    timer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        /* 杀不掉也无所谓，下面照样返回超时 */
      }
      finish({ code: -1, timedOut: true });
    }, num(timeoutMs, DEFAULT_TIMEOUT_MS));

    child.stdout?.on?.("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on?.("data", (d) => {
      stderr += d.toString();
    });
    child.on?.("error", (err) => finish({ code: -1, error: err }));
    child.on?.("close", (code) => finish({ code }));
  });
}

/** 助手 stdout 最后一行是 JSON；解析失败不算致命，以退出码与文件为准。 */
function parsePayload(stdout) {
  try {
    const lastLine = String(stdout).trim().split("\n").pop() ?? "";
    return lastLine ? JSON.parse(lastLine) : null;
  } catch {
    return null;
  }
}

function tail(text, limit = 300) {
  return String(text ?? "").trim().slice(0, limit);
}

/**
 * 中间 SILK 文件的落地位置。
 *
 * 刻意**不用系统 temp 目录**：在受限环境（沙箱、组策略、杀软）里 `os.tmpdir()`
 * 指向的目录未必可写，而 Node 与 Python 看到的 temp 甚至可能不是同一个地方
 * （实测踩过：Node 给 AppData\Local\Temp，Python 那边该目录 EACCES）。
 * 落在仓库自己的 data/ 下最稳，data/ 本来就在 .gitignore 里。
 */
function tmpSilkPath() {
  const dir =
    str(process.env.TTS_TMP_DIR) ||
    path.join(import.meta.dirname, "..", "..", "data", "tts-tmp");
  const name = `chunhe-tts-${Date.now()}-${Math.floor(Math.random() * 1e6)}.silk`;
  return path.join(dir, name);
}

/** RVC 链路的中间 WAV：必须落在纯 ASCII 的 io junction 下。 */
function tmpWavPath(cfg, tag) {
  const dir = str(cfg?.rvc?.ioDir) || DEFAULT_RVC_IO_DIR;
  const name = `chunhe-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`;
  return path.join(dir, name);
}

/** 默认 SILK 编码助手：<repo>/tools/audio_to_silk.py */
export function defaultSilkScriptPath() {
  return path.join(import.meta.dirname, "..", "..", "tools", "audio_to_silk.py");
}

/** 校验 tencent SILK 魔数（发出去之前最后一道自检）。 */
function isTencentSilk(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= SILK_MAGIC.length &&
    buf.subarray(0, SILK_MAGIC.length).equals(SILK_MAGIC)
  );
}

/**
 * 合成一段语音，返回 tencent SILK 字节。
 *
 * 链路（RVC 开启时）：
 *   文本 → edge-tts(WAV) → rvc_convert.py(绮萱, CUDA) → audio_to_silk(48kbps)
 *
 * 降级链（任何一步失败都不让「没声音」升级成「没回复」）：
 *   RVC 失败/超时 → 用 edge-tts 原声编 SILK
 *   TTS 失败     → {ok:false}，调用方发文字
 *
 * **永不抛出**：失败时返回 `{ok:false, reason}`，调用方直接降级发文字即可。
 *
 * @param {string} text
 * @param {ReturnType<typeof resolveTtsConfig>} cfg
 * @param {object} [deps] 仅测试用：注入 spawn / readFile / stat / removeFile 等
 * @returns {Promise<{ok: boolean, silk?: Buffer, reason: string, cache?: string,
 *   timings?: object, rvc?: object, emotion?: object, artifacts?: object}>}
 */
export async function synthesizeSilk(text, cfg, deps = {}) {
  const spawnImpl = deps.spawn ?? nodeSpawn;
  const readFileImpl = deps.readFile ?? ((p) => fsp.readFile(p));
  const statImpl = deps.stat ?? ((p) => fsp.stat(p));
  const removeFileImpl = deps.removeFile ?? ((p) => fsp.rm(p, { force: true }).catch(() => {}));
  const makeTmpPath = deps.makeTmpPath ?? tmpSilkPath;
  const makeWavPath = deps.makeWavPath ?? ((tag) => tmpWavPath(cfg, tag));
  const now = deps.now ?? (() => Date.now());
  const scriptPath = deps.scriptPath ?? cfg?.script ?? defaultScriptPath();
  const silkScript = deps.silkScript ?? defaultSilkScriptPath();
  const logger = deps.logger;

  // 先清洗（去 emoji / markdown），再截断——顺序不能反，否则可能截到一半 emoji
  const spoken = truncateForSpeech(stripForSpeech(text), cfg?.maxChars);
  if (!spoken) return { ok: false, reason: "清洗后无可朗读文本（可能整条都是 emoji），跳过语音" };

  const startedAt = now();
  const cache = deps.cache ?? createVoiceCache(cfg?.cache ?? {}, {
    dir: deps.cacheDir,
    fs: deps.cacheFs,
    now,
  });
  const cacheKey = cache.enabled ? cache.keyFor({ text: spoken, cfg }) : null;

  // ---- 缓存命中：秒回，连子进程都不启动 ----
  if (cacheKey) {
    const hit = await cache.get(cacheKey);
    if (hit) {
      return {
        ok: true,
        silk: hit,
        reason: "",
        cache: "hit",
        timings: { tts: 0, rvc: 0, silk: 0, total: now() - startedAt, rtf: 0 },
      };
    }
  }

  /** 文件是否存在（RVC/TTS 子进程退出码 0 但没产出文件也按失败处理）。 */
  async function exists(file) {
    try {
      const st = await statImpl(file);
      if (!st) return false;
      return typeof st.isFile === "function" ? st.isFile() : true;
    } catch {
      return false;
    }
  }

  async function cleanup(files) {
    for (const f of files) {
      if (!f) continue;
      try {
        await removeFileImpl(f);
      } catch {
        /* 清理失败不影响结果 */
      }
    }
  }

  let ttsMs = 0;
  let rvcMs = 0;
  let silkMs = 0;
  let durationMs = 0;
  let emotionInfo = null;
  let silk = null;
  let cacheable = true;
  let rvcInfo;
  const artifacts = {};

  if (cfg?.rvc?.enabled) {
    // ---- ① edge-tts → WAV ----
    const ttsWav = makeWavPath("tts");
    artifacts.ttsWav = ttsWav;
    const ttsStart = now();
    const ttsArgs = buildTtsWavArgs({ scriptPath, text: spoken, wavPath: ttsWav, cfg });
    const ttsRes = await runChild(spawnImpl, cfg?.python || "python", ttsArgs, cfg?.timeoutMs);
    ttsMs = now() - ttsStart;

    const ttsPayload = parsePayload(ttsRes.stdout);
    if (ttsPayload?.emotion) emotionInfo = ttsPayload.emotion;
    if (Number.isFinite(ttsPayload?.duration_ms)) durationMs = ttsPayload.duration_ms;

    if (ttsRes.error) {
      await cleanup([ttsWav]);
      return { ok: false, reason: `TTS 启动失败：${ttsRes.error?.message ?? ttsRes.error}` };
    }
    if (ttsRes.timedOut) {
      await cleanup([ttsWav]);
      return {
        ok: false,
        reason: `TTS 合成超时（>${cfg?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`,
        timings: { tts: ttsMs, rvc: 0, silk: 0, total: now() - startedAt, rtf: 0 },
      };
    }
    if (ttsPayload && ttsPayload.ok === false) {
      await cleanup([ttsWav]);
      return { ok: false, reason: `TTS 合成失败：${ttsPayload.error ?? "助手返回 ok:false"}` };
    }
    if (ttsRes.code !== 0) {
      await cleanup([ttsWav]);
      const detail = tail(ttsPayload?.error || ttsRes.stderr);
      return { ok: false, reason: `TTS 合成失败：语音助手退出码 ${ttsRes.code}${detail ? `：${detail}` : ""}` };
    }
    if (!(await exists(ttsWav))) {
      await cleanup([ttsWav]);
      return { ok: false, reason: "TTS 未产出 WAV（助手退出码 0）" };
    }

    // ---- ② RVC 变声（失败就退回 ① 的原声，不阻断整条链路）----
    let wavForSilk = ttsWav;
    const rvcOut = makeWavPath("rvc");
    artifacts.rvcWav = rvcOut;
    const rvcStart = now();
    const workerEnv = {
      RVC_ROOT: cfg.rvc.root,
      RVC_TMP_DIR: path.join(cfg.rvc.ioDir, "scratch"),
    };
    // 测试注入 spawn 时走「一次性子进程」；生产走常驻 worker。
    // deps.rvcWorker 可显式注入（测试/脚本）。
    const worker =
      deps.rvcWorker ??
      (cfg.rvc.worker !== false && !deps.spawn
        ? getRvcWorker({ rvc: cfg.rvc, env: workerEnv, logger })
        : null);

    let rvcFailure = "";
    let device = null;
    if (worker) {
      const wr = await worker.convert(ttsWav, rvcOut, cfg.rvc.timeoutMs);
      rvcMs = now() - rvcStart;
      device = wr.device ?? null;
      if (!wr.ok) {
        rvcFailure = wr.reason || (wr.timedOut ? "RVC worker 超时" : "RVC worker 失败");
      }
    } else {
      const rvcArgs = buildRvcArgs({
        scriptPath: cfg.rvc.script,
        inPath: ttsWav,
        outPath: rvcOut,
        rvc: cfg.rvc,
      });
      const rvcRes = await runChild(
        spawnImpl,
        cfg.rvc.python,
        rvcArgs,
        cfg.rvc.timeoutMs,
        workerEnv,
      );
      rvcMs = now() - rvcStart;
      device = /device=([^\s]+)/.exec(String(rvcRes.stdout))?.[1] ?? null;

      if (rvcRes.error) {
        rvcFailure = `RVC 启动失败：${rvcRes.error?.message ?? rvcRes.error}`;
      } else if (rvcRes.timedOut) {
        rvcFailure = `RVC 超时（>${cfg.rvc.timeoutMs}ms）`;
      } else if (rvcRes.code !== 0) {
        const detail = tail(rvcRes.stderr || rvcRes.stdout);
        rvcFailure = `RVC 变声失败：退出码 ${rvcRes.code}${detail ? `：${detail}` : ""}`;
      } else if (!(await exists(rvcOut))) {
        rvcFailure = "RVC 未产出音频文件（退出码 0）";
      }
    }

    if (rvcFailure) {
      rvcInfo = { ok: false, reason: rvcFailure, device, ms: rvcMs };
    } else {
      rvcInfo = { ok: true, reason: "", device, ms: rvcMs };
      wavForSilk = rvcOut;
    }

    if (!rvcInfo.ok) {
      // 用过 RVC 但失败了：这一次的成品是「小易原声」，不写缓存，
      // 否则 RVC 修好后缓存还会一直把这句原声吐出来。
      cacheable = false;
      logger?.warn?.(`[voice] RVC 失败，回退纯 edge-tts：${rvcInfo.reason}`);
      await cleanup([rvcOut]);
    }

    // ---- ③ WAV → tencent SILK 48kbps ----
    const silkOut = makeTmpPath();
    artifacts.silkPath = silkOut;
    const silkStart = now();
    const silkArgs = buildSilkArgs({
      scriptPath: silkScript,
      inPath: wavForSilk,
      outPath: silkOut,
      bitrate: cfg.rvc.silkBitrate,
    });
    const silkRes = await runChild(spawnImpl, cfg?.python || "python", silkArgs, cfg?.timeoutMs);
    silkMs = now() - silkStart;
    const silkPayload = parsePayload(silkRes.stdout);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      if (Number.isFinite(silkPayload?.duration_ms)) durationMs = silkPayload.duration_ms;
    }

    let silkError = "";
    if (silkRes.error) {
      silkError = `启动 SILK 助手失败：${silkRes.error?.message ?? silkRes.error}`;
    } else if (silkRes.timedOut) {
      silkError = `SILK 编码超时（>${cfg?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`;
    } else if (silkPayload && silkPayload.ok === false) {
      silkError = `SILK 编码失败：${silkPayload.error ?? "助手返回 ok:false"}`;
    } else if (silkRes.code !== 0) {
      const detail = tail(silkPayload?.error || silkRes.stderr);
      silkError = `SILK 编码失败：语音助手退出码 ${silkRes.code}${detail ? `：${detail}` : ""}`;
    }

    if (!silkError) {
      try {
        silk = await readFileImpl(silkOut);
      } catch (err) {
        silkError = `读不到 SILK 文件（${err?.message ?? err}）`;
      }
    }
    if (!silkError && (!silk || silk.length === 0)) silkError = "SILK 文件为空，放弃发送";
    if (!silkError && !isTencentSilk(silk)) silkError = "产出的不是 tencent SILK（头部不对）";
    // 超长语音直接判失败：QQ 富媒体语音建议 ≤58s，超了平台会拒收。
    // 必须在写缓存之前挡掉，否则下次命中缓存会绕过发送层的检查。
    if (!silkError && durationMs > MAX_QQ_VOICE_MS) {
      silkError =
        `语音时长 ${(durationMs / 1000).toFixed(1)}s 超过 QQ 的 ` +
        `${MAX_QQ_VOICE_MS / 1000}s 上限`;
    }

    const totalMs = now() - startedAt;
    const rtf = durationMs > 0 ? totalMs / durationMs : 0;

    if (silkError) {
      await cleanup([ttsWav, rvcOut, silkOut]);
      return {
        ok: false,
        reason: silkError,
        rvc: rvcInfo,
        emotion: emotionInfo ?? undefined,
        timings: { tts: ttsMs, rvc: rvcMs, silk: silkMs, total: totalMs, rtf },
      };
    }

    if (cacheable && cacheKey) await cache.set(cacheKey, silk);
    if (deps.keepTemp !== true) await cleanup([ttsWav, rvcOut, silkOut]);

    logger?.info?.(
      `[voice] tts=${ttsMs}ms rvc=${rvcMs}ms silk=${silkMs}ms total=${totalMs}ms ` +
        `rtf=${rtf.toFixed(2)} cache=miss rvc=${rvcInfo.ok ? rvcInfo.device ?? "ok" : "fallback"}`,
    );

    return {
      ok: true,
      silk,
      reason: "",
      cache: "miss",
      timings: { tts: ttsMs, rvc: rvcMs, silk: silkMs, total: totalMs, rtf },
      rvc: rvcInfo,
      emotion: emotionInfo ?? undefined,
      /** 供调用方做「QQ 语音 ≤ 58s」闸门；量不出来时是 0 */
      durationMs,
      artifacts,
    };
  }

  // ---- RVC 关闭：保持旧的单步「文字 → SILK」链路 ----
  const outPath = makeTmpPath();
  artifacts.silkPath = outPath;
  const ttsStart = now();
  const args = buildTtsArgs({ scriptPath, text: spoken, outPath, cfg });
  const res = await runChild(spawnImpl, cfg?.python || "python", args, cfg?.timeoutMs);
  ttsMs = now() - ttsStart;
  const payload = parsePayload(res.stdout);
  if (payload?.emotion) emotionInfo = payload.emotion;
  if (Number.isFinite(payload?.duration_ms)) durationMs = payload.duration_ms;

  if (res.error) {
    return { ok: false, reason: `启动语音助手失败：${res.error?.message ?? res.error}` };
  }
  if (res.timedOut) {
    return { ok: false, reason: `语音合成超时（>${cfg?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）` };
  }
  if (payload && payload.ok === false) {
    return { ok: false, reason: `语音合成失败：${payload.error ?? "助手返回 ok:false"}` };
  }
  if (res.code !== 0) {
    const detail = tail(payload?.error || res.stderr);
    return { ok: false, reason: `语音助手退出码 ${res.code}${detail ? `：${detail}` : ""}` };
  }

  try {
    silk = await readFileImpl(outPath);
  } catch (err) {
    await removeFileImpl(outPath);
    return { ok: false, reason: `读不到语音文件（${err?.message ?? err}）` };
  }
  await removeFileImpl(outPath);

  if (!silk || silk.length === 0) {
    return { ok: false, reason: "语音文件为空，放弃发送" };
  }

  // 同 RVC 分支：超 58s 不缓存、不返回成功，避免发送层/缓存绕过
  if (durationMs > MAX_QQ_VOICE_MS) {
    return {
      ok: false,
      reason:
        `语音时长 ${(durationMs / 1000).toFixed(1)}s 超过 QQ 的 ` +
        `${MAX_QQ_VOICE_MS / 1000}s 上限`,
    };
  }

  if (cacheKey) await cache.set(cacheKey, silk);
  const totalMs = now() - startedAt;
  const rtf = durationMs > 0 ? totalMs / durationMs : 0;
  logger?.info?.(`[voice] tts=${ttsMs}ms total=${totalMs}ms rtf=${rtf.toFixed(2)} cache=miss rvc=off`);
  return {
    ok: true,
    silk,
    reason: "",
    cache: "miss",
    timings: { tts: ttsMs, rvc: 0, silk: 0, total: totalMs, rtf },
    emotion: emotionInfo ?? undefined,
    durationMs,
    artifacts,
  };
}
