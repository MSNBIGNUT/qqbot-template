/**
 * 画图：DeepSeek 工具调用 → 火山方舟 Seedream 生图 → QQ 富媒体图片。
 *
 * 链路（用户在 QQ 里说「帮我画一只金毛」）：
 *   1. 模型看到注册的 generate_image 工具，自己判断要不要调用，并把中文画面描述组织好；
 *   2. 我们收到 tool_calls，调火山方舟 /images/generations 拿到图片 URL；
 *   3. 把图片下载成 base64（QQ 富媒体只吃 file_data，不吃直链）；
 *   4. 引擎用 file_type=1 / msg_type=7 把图发出去；
 *   5. 把「已生成」这句话作为 tool 结果回填给模型，模型再写一句文字说明。
 *
 * 设计约束（与 tts.js / sing.js 一致）：
 *   1. **零依赖**：工具调用循环用内建 fetch 手写，不引 npm 包。
 *   2. **任何失败都降级、绝不抛**：返回 {ok, reason}，让模型用文字解释，而不是整条消息发不出去。
 *   3. **没配 key 就不注册工具**——否则等于给模型装一个必然失败的工具，
 *      它会每轮都调、每次都失败，既烧 token 又永远画不出来。
 *   4. **角色锚定与主立绘只在「画她自己」时才生效**（见下）。
 *
 * 真机 bug（2026-10-17，已修）：让她画雪山，图里出现了她自己。
 *   12:52:31 主人：能生成你穿女仆装的图片吗  → 出图（这一张本来就该有她）
 *   12:53:29 主人：你能画座雪山吗           → 出图，雪山前站着春禾
 *   根因是**结构性**的，不是「模型想多了」：
 *     - `IMAGE_GEN_CHARACTER_LOCK`（她的外貌锚定）被无条件拼在**每一次** prompt 最前面；
 *     - `ARK_IMAGE_REFERENCE`（她的立绘）被无条件作为参考图塞进**每一次**请求。
 *   于是不管主人要画什么，生图模型都拿到「春禾长这样」这个强条件——
 *   这正是主人说的「她把自己的形象变成了生图的一个强相关的条件」。
 *   修法：这两样从「每次都带」改成「只有主人明确要画她时才带」，
 *   判定以**主人这一轮的原话**为准（模型自己拍板的 include_self 不能凌驾其上），
 *   非自画像请求里再把模型自作主张写进去的「春禾 / 我自己」剥掉。
 *
 * 实测备注（2026-10，火山方舟）：
 *   - 文档里常见的 `doubao-seedream-5-0-lite-260128` 在方舟侧**根本不存在**，
 *     调用会返回 "The model or endpoint ... does not exist"。
 *   - 存在的生图模型是 `doubao-seedream-5-0-flash-260915` / `doubao-seedream-5-0-pro-260628` 等。
 *   - 若账号未开通，方舟会明确回 "Your account ... has not activated the model ..."，
 *     这时**模型名是对的**，只需去方舟控制台开通模型服务。
 */

import { promises as fsp } from "node:fs";

import { fetchFileAsBuffer } from "./image.js";
import { botName } from "../persona/naming.js";

export const DEFAULT_ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";
/**
 * 实测**已开通且可用**的模型名（2026-10，本机账号实测 HTTP 200 并成功出图）。
 *
 * 改这里之前请先做两步核对：
 *   1. GET /api/v3/models 看模型是否存在；
 *   2. 实际调一次生图看是否已开通。
 * 「存在」≠「已开通」——方舟对这两种情况给的是不同报错：
 *   未开通 -> "Your account ... has not activated the model ..."
 *   不存在 -> "The model or endpoint ... does not exist"
 * 另：flash 版 doubao-seedream-5-0-flash-260915 存在，但需在控制台另行开通。
 */
export const DEFAULT_IMAGE_MODEL = "doubao-seedream-5-0-pro-260628";
export const DEFAULT_SIZE = "1024x1024";
export const DEFAULT_TIMEOUT_MS = 90000;
export const DEFAULT_MAX_ROUNDS = 3;
/** QQ 富媒体图片上限留的余量（字节） */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/**
 * 一次请求最多带几张参考图。
 *
 * 主立绘 + 用户本次发来的图会一起带上；设上限是防止用户在群里连发十几张图
 * 把请求撑到几十 MB，也超出方舟的容忍度。
 */
export const MAX_REFERENCES = 4;

export const IMAGE_TOOL_NAME = "generate_image";

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function num(v, fallback) {
  const n = Number.parseInt(str(v), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 你/春禾 被画出来的常见说法（对象是她本人）。
 *
 * 判定的对象是**主人的原话**，不是模型写的 prompt：模型被上一轮带偏时，
 * 它自己写的 prompt 恰恰是最不可信的那一份。
 *
 * 刻意不写宽泛的 `/你/`：真机里「你能画座雪山吗」含「你」，
 * 但那个「你」是「你能画」的主语，不是被画的对象——按 `/你/` 判会把
 * 这条 bug 原样复现出来。
 */
export const SELF_PORTRAIT_PATTERNS = [
  /自画像/,
  // 2026-10-19 真机：主人说「你的自肖像」——「自**肖**像」不在任何一条里，
  // 于是被判成非自画像 → 角色锚定和主立绘全都没带 → 画出来是个"像她的普通女孩"。
  // 这里把 自拍/自照/自画/自肖像 一起收，并允许「你的自X」这种说法。
  /自肖像|自拍照|自画照|自身像/,
  /(?:你|春禾)(?:的)?自(?:拍|照|画|肖像|画像)/,
  /(?:你|春禾)的(?:样子|形象|自拍|立绘|肖像|照片|模样|长相|图)/,
  /你自己/,
  /(?:把|将)(?:你|春禾)(?:也|一起)?(?:画|加|放|带上)/,
  /(?:和|跟|与|同)(?:你|春禾)(?:一起|同框|合照)/,
  // 「画我和你的合照」「你和我一起的合影」
  /(?:和|跟|与|同)(?:你|春禾)(?:的)?(?:合照|合影|同框)/,
  /(?:你|春禾)(?:和|跟|与|同)(?:我|主人)/,
  /(?:穿|戴)[^，。！？,.!?]{0,10}的(?:你|春禾)/,
  // 「你穿女仆装」「你在窗边坐着」：描述**她的状态**，说明要画她本人。
  // 「你能画…」「你会…」这类是请她干活，不含这些动词，所以不会被误判。
  /(?:你|春禾)(?:穿|戴|坐|站|躺|趴|笑|哭|抱|拿|举|靠|在)/,
  /(?:你|春禾)(?:本人|真人)/,
];

/**
 * 主人这句话是不是明确要画春禾？
 *
 * @param {string} text 主人这一轮的原话（不要传模型写的 prompt）
 * @returns {boolean}
 */
export function isSelfPortraitRequest(text) {
  const s = str(text);
  if (!s) return false;

  // 「画你」「画一张你」「画个春禾」：你/春禾 直接是宾语
  const m = /画[一下张个幅副只]?\s*(?:你|春禾)/.exec(s);
  if (m) {
    const rest = s.slice(m.index + m[0].length);
    if (!rest.startsWith("的")) return true;
    // 「画你的样子/自拍/侧脸」算；「画你的猫/你的车」不算（那是别的对象）
    return /^的(?:样子|形象|自拍|立绘|肖像|照片|模样|长相|背影|侧脸|全身|半身|脸|眼睛|头发)/.test(rest);
  }

  return SELF_PORTRAIT_PATTERNS.some((re) => re.test(s));
}

/**
 * 非自画像请求里，剥掉模型自作主张写进去的「她自己」。
 *
 * 只剥**明确指向她**的词。普通名词（少女、女孩、主人、老人）一律不动——
 * 它们可能正是主人点名要的（「画一只金毛和它的主人在公园」），
 * 误删就是另一种 bug。
 */
export const SELF_MENTION_RE = /(?:春禾|我自己的(?:形象|样子)|我的(?:形象|样子)|你自己|我自己)/g;

export function stripSelfMentions(text) {
  const s = str(text);
  if (!s) return "";
  return s
    .replace(SELF_MENTION_RE, "")
    .replace(/[（(]\s*[)）]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[，、,。.；;：:\s]+/, "")
    .replace(/([，、,。.；;\s]){2,}/g, "$1")
    .trim();
}

/**
 * 从环境变量解析画图配置。
 *
 * enabled 同时取决于「没被显式关掉」且「有 key」——没有 key 就没有工具，
 * 这是刻意的：装了也只会失败。
 */
export function resolveImageGenConfig(env = {}) {
  const apiKey = str(env.ARK_API_KEY);
  const switchedOff = str(env.IMAGE_GEN_ENABLED).toLowerCase() === "false";
  return {
    enabled: !switchedOff && Boolean(apiKey),
    apiKey,
    baseUrl: str(env.ARK_BASE_URL) || DEFAULT_ARK_BASE,
    model: str(env.ARK_IMAGE_MODEL) || DEFAULT_IMAGE_MODEL,
    size: str(env.ARK_IMAGE_SIZE) || DEFAULT_SIZE,
    /**
     * 角色参考图（本地路径 或 现成的 data URI）。
     *
     * 配上之后，每次生图都会把它作为参考图传给 Seedream，从而锁住发色、瞳色、
     * 五官——也就是「春禾长什么样」。不配则退回纯文生图（行为与以前完全一致）。
     */
    reference: str(env.ARK_IMAGE_REFERENCE) || str(env.IMAGE_GEN_REFERENCE),
    /**
     * 角色锚定提示词：**每次生图都会拼在最前面**。
     *
     * 为什么需要它：光靠参考图锁不住细节——实测跑偏过「兽耳变成鱼鳍」
     * 「短袖变无袖」「多出一条鲸尾」。把不可妥协的特征写成固定锚点，
     * 就不必每换一个场景都重打一遍，也不会被模型自由发挥带偏。
     */
    characterLock: str(env.IMAGE_GEN_CHARACTER_LOCK),
    timeoutMs: num(env.IMAGE_GEN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRounds: num(env.IMAGE_GEN_MAX_ROUNDS, DEFAULT_MAX_ROUNDS),
    maxBytes: num(env.IMAGE_GEN_MAX_BYTES, DEFAULT_MAX_BYTES),
  };
}

/** 按扩展名猜 MIME；猜不到按 jpeg（QQ/方舟对 jpeg 最宽容） */
function mimeOf(p) {
  const s = String(p).toLowerCase();
  if (s.endsWith(".png")) return "image/png";
  if (s.endsWith(".webp")) return "image/webp";
  if (s.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * 解析参考图配置为**多个**条目。
 *
 * 分隔符是分号或换行（刻意不用逗号：Windows 路径和文件名里都可能出现逗号）。
 *
 * ⚠️ 坑：data URI 自己就带分号（`data:image/png;base64,....`），
 * 直接按分号拆会把一张图拆成两半。所以只在「分号后面不是 data URI 片段」
 * 时才当作分隔符。
 */
export function parseReferences(ref) {
  const s = str(ref);
  if (!s) return [];
  // 负向先行：分号后面若跟着 ...base64, 就说明这是 data URI 的一部分，不拆
  const SEP = /;(?![^;,]*base64,)/;
  return s
    .split(/\r?\n+/)
    .flatMap((line) => line.split(SEP))
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 把所有参考图解析成可直接塞进请求体的 data URI 数组。
 *
 * **永不抛出**：某一张读不到就跳过它，其余照常使用——
 * 参考图缺失不该让整次生图失败。
 */
export async function resolveReferenceDataUris(cfg, deps = {}) {
  const list = parseReferences(cfg?.reference);
  if (list.length === 0) return [];

  const readFileImpl = deps.readFile ?? ((p) => fsp.readFile(p));
  const out = [];
  for (const item of list) {
    if (item.startsWith("data:")) {
      out.push(item);
      continue;
    }
    try {
      const buf = await readFileImpl(item);
      if (!buf || buf.length === 0) continue;
      out.push(`data:${mimeOf(item)};base64,${buf.toString("base64")}`);
    } catch (err) {
      deps.logger?.warn?.(`参考图读取失败，已跳过该张：${err?.message ?? err}`);
    }
  }
  return out;
}

/**
 * 单张参考图的便捷入口（返回第一张或 null）。
 * 保留它是为了兼容既有调用与测试。
 */
export async function resolveReferenceDataUri(cfg, deps = {}) {
  const list = await resolveReferenceDataUris(cfg, deps);
  return list[0] ?? null;
}

/** 给模型看的工具定义（OpenAI / DeepSeek function calling 格式） */
export const IMAGE_TOOL = {
  type: "function",
  function: {
    name: IMAGE_TOOL_NAME,
    description:
      "根据文字描述生成一张图片并直接发给用户。当用户明确要求画图、画一张、生成图片、帮忙配图时调用。" +
      "调用时请把画面描述写具体（主体、动作、环境、光线、风格），中文即可。\n" +
      "【硬规则·必须遵守，优先级高于对话上下文】\n" +
      "1. prompt 里**只描述主人这一次点名要的东西**。他要风景/物体/动物/场景，就只写这些：" +
      "不要擅自加人物，**不要加你自己（" + botName() + "）**，也不要加「可爱的女孩」「美少女」这类谁都没提过的默认元素。\n" +
      "2. 只有主人**明确**说「画你」「画你自己」「你的样子」「画" + botName() + "」时，才允许出现" + botName() + "的形象，" +
      "并且要把 include_self 设为 true；其余任何情况 include_self 一律为 false（默认值就是 false）。\n" +
      "3. 每次画图都是**独立请求**：不要延续上一张图的主题、人物或风格。" +
      "上一轮聊的是「画你穿女仆装」，这一轮说「画座雪山」，那就只画雪山，和" + botName() + "没有关系。\n" +
      "4. 主人**点名要了人物**时（例如「画一只金毛和它的主人在公园」「画一个海边散步的老人」），" +
      "照他说的画，不要因为第 1 条就把人物删掉——第 1 条针对的是「主人没提的东西」。\n" +
      "5. **宁可少画，不要多画**：主人说「画座雪山」，就只画雪山。\n" +
      "6. **先想再画**：动手前必须在 thought 里过一遍——「他要画什么？」「要不要画我？」「有什么不能加？」\n" +
      "   thought 写不清就别急着调工具。",
    parameters: {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description:
            "画之前的**自我确认**（一句话，不超过 60 字）。必须说清三件事：" +
            "① 主人这次点名要画什么；② 这次要不要画" + botName() + "自己（以及为什么）；③ 有哪些明确不能加的东西。" +
            "例：「他要海鸥，只画海鸥不要加人；不是自画像所以 include_self=false；别加女孩。」" +
            "这一条**你自己的检查**，不会发给用户，但写清楚能避免画错。",
        },
        prompt: {
          type: "string",
          description:
            "图片的画面描述，中文即可，越具体越好。只写主人点名要的主体/动作/环境/光线/风格，" +
            "不要写主人没提的人物，更不要默认把" + botName() + "写进去。",
        },
        include_self: {
          type: "boolean",
          description:
            "是否要把" + botName() + "本人画进图里。**默认 false**。只有主人明确说「画你」「画你自己」「你的样子」" +
            "「画" + botName() + "」时才设为 true；其他任何情况都必须是 false（风景、动物、物品、别人一律 false）。",
        },
      },
      required: ["prompt"],
    },
  },
};

/** 未启用时返回 []（请求体里就不会出现 tools 字段） */
export function buildToolList(cfg) {
  return cfg?.enabled ? [IMAGE_TOOL] : [];
}

/**
 * 调火山方舟生图，并把图片下载成 base64。**永不抛出。**
 *
 * @param {string} prompt 画面描述
 * @param {object} cfg resolveImageGenConfig 的结果
 * @param {object} [deps]
 * @param {boolean} [deps.includeSelf=false] 本次是否画春禾本人。
 *   **默认 false**：角色锚定与主立绘只有在这个值为 true 时才参与生图。
 *   默认值必须是 false——「忘了传」的后果只能是少画她，不能是多画她。
 * @returns {Promise<{ok: boolean, images?: Array<{base64: string, bytes: number}>, reason: string}>}
 */
export async function generateImage(prompt, cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const download = deps.fetchFile ?? fetchFileAsBuffer;

  if (!cfg?.enabled) {
    return { ok: false, reason: "画图功能未启用（缺少 ARK_API_KEY 或被 IMAGE_GEN_ENABLED 关闭）" };
  }
  let text = str(prompt);
  if (!text) return { ok: false, reason: "prompt 为空，无法生图" };

  const includeSelf = deps.includeSelf === true;

  // 非自画像请求：把模型硬写进去的「她自己」剥掉。
  // 这是第二道闸（第一道是不拼锚定/不带立绘），用来兜住模型不听提示词的情况。
  if (!includeSelf) {
    const cleaned = stripSelfMentions(text);
    if (cleaned !== text) {
      deps.logger?.warn?.(
        `画图 prompt 里出现了${botName()}/我自己，但主人这次没要自画像，已剥离：${cleaned.slice(0, 60)}`,
      );
      text = cleaned;
    }
    if (!text) {
      return { ok: false, reason: "prompt 里只有" + botName() + "自己的形象，但主人这次没要自画像" };
    }
  }

  // 角色锚定拼在最前：不可妥协的人设特征优先于本次场景描述。
  // ⚠️ 只在自画像时才拼——否则等于给每一次生图都挂上「春禾长这样」这个强条件。
  const lock = includeSelf ? str(cfg.characterLock) : "";
  const finalPrompt = lock ? `${lock}\n\n【本次画面】\n${text}` : text;

  const url = `${String(cfg.baseUrl).replace(/\/+$/, "")}/images/generations`;

  // 角色参考图：**只在自画像时**带上，锁住发色/瞳色/五官/画风；读不到就退回纯文生图。
  // 这是最强的一条「她在图里」的条件——真机里画雪山却出现她，主要就是它造成的。
  const configured = includeSelf
    ? await resolveReferenceDataUris(cfg, {
        readFile: deps.readFile,
        logger: deps.logger,
      })
    : [];
  if (includeSelf && configured.length > 0) {
    deps.logger?.info?.(`本次是自画像请求：已拼角色锚定并带主立绘 ${configured.length} 张`);
  }

  /**
   * 用户本次消息里发来的图（A 方案）：
   *   主立绘在前 —— 锁住「春禾长什么样」；
   *   用户的图在后 —— 补上「这次想照着什么画风/内容画」。
   * 这样既听得进主人的参考图，又不会把春禾画成别人。
   */
  const extra = (Array.isArray(deps.extraReferences) ? deps.extraReferences : [])
    .filter((u) => typeof u === "string" && u.startsWith("data:"));
  const references = [...configured, ...extra].slice(0, MAX_REFERENCES);
  if (extra.length > 0) {
    deps.logger?.info?.(
      `本次携带 ${references.length} 张参考图（主立绘 ${configured.length} 张 + 主人发来 ${extra.length} 张）`,
    );
  }

  let payload;
  try {
    const requestBody = {
      model: cfg.model,
      prompt: finalPrompt,
      size: cfg.size,
      response_format: "url",
    };
    // 一张传字符串，多张传数组（方舟两种都收，实测均 200）
    if (references.length === 1) requestBody.image = references[0];
    else if (references.length > 1) requestBody.image = references;

    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });

    const raw = await res.text();
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const detail = payload?.error?.message ?? raw.slice(0, 200);
      // 未开通时方舟的报错很明确，直接把原文带出去，省得主人猜
      return { ok: false, reason: `生图接口 HTTP ${res.status}：${detail}` };
    }
  } catch (err) {
    return { ok: false, reason: `生图请求失败：${err?.message ?? err}` };
  }

  const first = payload?.data?.[0];
  if (!first) return { ok: false, reason: "生图接口没有返回图片数据" };

  // 优先用 b64_json（省一次下载）；否则拿 url 下载
  let buf = null;
  if (first.b64_json) {
    buf = Buffer.from(String(first.b64_json), "base64");
  } else if (first.url) {
    try {
      // 注意 fetchFileAsBuffer 返回 { buf, contentType }，失败返回 null（不抛）。
      // 这里给它一个宽松的上限，尺寸判定留到下面自己做，好给出精确的报错。
      const got = await download(String(first.url), {
        fetchImpl,
        timeoutMs: cfg.timeoutMs,
        maxBytes: 20 * 1024 * 1024,
      });
      buf = got?.buf ?? null;
    } catch (err) {
      return { ok: false, reason: `图片下载失败（${err?.message ?? err}）` };
    }
    if (!buf) return { ok: false, reason: "图片下载失败（下载结果为 null 或 HTTP 错误）" };
  } else {
    return { ok: false, reason: "生图接口既没有 url 也没有 b64_json" };
  }

  if (!buf || buf.length === 0) return { ok: false, reason: "图片内容为空" };
  if (buf.length > cfg.maxBytes) {
    return {
      ok: false,
      reason: `图片过大（${buf.length} 字节 > maxBytes ${cfg.maxBytes}），QQ 富媒体可能拒收，已放弃`,
    };
  }

  return { ok: true, images: [{ base64: buf.toString("base64"), bytes: buf.length }], reason: "" };
}

/**
 * 执行一次工具调用，返回要回填给模型的 content 和要发出去的图片。
 * **永不抛出**：参数解析失败、未知工具、生图失败都变成一段可读文字。
 *
 * @param {object} [deps]
 * @param {string} [deps.userText] 主人这一轮的**原话**。
 *   自画像判定只认它：模型写的 prompt 与 include_self 都可能被上一轮带偏，
 *   只有主人原话能说明「他这次到底要不要画她」。
 * @returns {Promise<{ok: boolean, images: Array<object>, content: string}>}
 */
export async function executeToolCall(name, rawArgs, cfg, deps = {}) {
  if (name !== IMAGE_TOOL_NAME) {
    return { ok: false, images: [], content: `未知工具：${name}（本机只提供 ${IMAGE_TOOL_NAME}）` };
  }

  let args;
  try {
    args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
  } catch (err) {
    return {
      ok: false,
      images: [],
      content: `工具参数不是合法 JSON，无法解析：${err?.message ?? err}。请重新调用并给出 {\"prompt\": \"...\"}`,
    };
  }

  const prompt = str(args?.prompt);
  if (!prompt) {
    return { ok: false, images: [], content: "参数缺少 prompt（图片描述），请补上后再调用。" };
  }

  // 2026-10-19：**生图前的思考**。
  // 不强制要求（有些模型不会填），但只要填了就记日志 —— 既能排查"她怎么想的"，
  // 也能看出她有没有先确认"要不要画自己"。这一条**不会发给用户**。
  const thought = str(args?.thought);
  if (thought) {
    deps.logger?.info?.(`画图前思考：${thought.slice(0, 100)}`);
  }

  /**
   * 自画像判定：**主人原话优先**。
   *
   * 只要有主人原话，就以它为准（模型说什么都不算数）——
   * 这正是这条 bug 的要害：上一轮「画你穿女仆装」会让模型这一轮
   * 依旧把 include_self 设成 true，若听它的，画雪山还会把她画进去。
   * 拿不到原话（程序内调用）时才退回模型自己填的参数。
   */
  const askedByModel = args?.include_self === true || str(args?.include_self).toLowerCase() === "true";
  const userText = str(deps.userText);
  const includeSelf = userText ? isSelfPortraitRequest(userText) : askedByModel;
  if (askedByModel && !includeSelf) {
    deps.logger?.info?.("模型想画" + botName() + "，但主人这一轮没要自画像：已按非自画像处理");
  }

  const res = await generateImage(prompt, cfg, { ...deps, includeSelf });
  if (!res.ok) {
    return { ok: false, images: [], content: `生图失败：${res.reason}` };
  }

  return {
    ok: true,
    images: res.images,
    content: `已成功生成 ${res.images.length} 张图片，并已发送给用户。可以再补一句自然的说明。`,
  };
}
