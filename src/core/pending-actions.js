/**
 * 跨场景待办指令：主人在私聊交代「待会到群里做 X」，到群里再执行。
 *
 * 为什么必须独立存储，而不是塞进会话历史：
 *   真机实测（2026-10-17）：`.env` 里 `QQ_HISTORY_TURNS=8` → 主人会话只保留
 *   16 条消息。主人在私聊交代「在群里卖个萌」，随后在群里聊十几句，这条指令
 *   就被挤出窗口了；她到群里自然"不记得"，用户看到的就是「私聊指令群聊不执行」。
 *
 * 设计取舍（每条都对应一个真实风险）：
 *   - **不占 historyTurns 配额**：待办是"答应过的事"，不是聊天流水，容量按条数
 *     与 TTL 管，不随聊天被淘汰；
 *   - **默认一次性**（done 后不再执行）：用户说「待会在群里卖个萌」是**一次事件**，
 *     不是"以后每次都要"。想要反复发生 → 走 owner 长期记忆（以后/每次…），
 *     否则会变成每句话都卖萌的骚扰；
 *   - **未点名群 = 任意群**：QQ 群消息里没有群名，只有 group_openid，凭"群名"
 *     无法可靠定位。没点名就允许在主人出现的第一个群执行一次（one-shot）；
 *     点名了（`群 <id>` / 指定 target）就只在该群执行；
 *   - **过期 24 小时（可配）**：隔天再执行一句"卖个萌"会很突兀；过期条目保留为
 *     expired 便于审计，不会悄悄删掉；
 *   - **只有主人能触发/查看**：见 `match` 的 fromOwner 与 list 的 ownerId 参数。
 */

import fs from "node:fs";
import path from "node:path";

import { extractSongName } from "../media/sing.js";
import { botName } from "../persona/naming.js";

export const PENDING_TARGET_ANY_GROUP = "any_group";
/** 按群大小点名：去大群 / 去小群（具体落到哪个群由群注册表决定） */
export const PENDING_TARGET_SIZE_LARGE = "size:large";
export const PENDING_TARGET_SIZE_SMALL = "size:small";

/** 投递方式：proactive=创建后立刻主动发；deferred=等主人到群里说话时执行 */
export const PENDING_DELIVERY = Object.freeze({
  PROACTIVE: "proactive",
  DEFERRED: "deferred",
});

export const PENDING_STATUS = Object.freeze({
  PENDING: "pending",
  DONE: "done",
  EXPIRED: "expired",
});

const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const DEFAULT_MAX_ACTIONS = 50;
const MAX_ACTION_LEN = 120;
const KEEP_TERMINAL_MS = 7 * 24 * 3600 * 1000;
const DUP_WINDOW_MS = 5 * 60 * 1000;

/** 去掉 @提及、压缩空白、截断 */
export function normalizePendingText(raw) {
  const clean = String(raw ?? "")
    .replace(/<@!?[^>\s]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clean.length > MAX_ACTION_LEN ? `${clean.slice(0, MAX_ACTION_LEN)}…` : clean;
}

/**
 * 「在群里 / 到群里 / 去群里 / 进群里 / 群聊里」这类跨场景锚点。
 *
 * 也认「大群 / 小群」：QQ 群消息里没有群名，只能按群注册表的 sizeLabel 选，
 * 所以这里只记一个 size:large / size:small 的目标，具体群由引擎解析。
 *
 * 显式群 id（`群 GROUP_OPENID… 里`）也认，方便主人/测试精确指定；
 * 自然语言里的**群名**无法映射到 group_openid，所以只会落到 any_group。
 */
const SCENE_CUE_RE =
  /(?:在|到|去|进|回)?\s*(?:那个|这个|咱们|我们|你|我)?\s*(?:(大群|小群)(?:里面|里|中)?|(?:群|群聊)(?:\s*[:：]?\s*([A-Za-z0-9_-]{6,})\s*(?:里面|里|中)?|(?:里面|里|中)))/;

/** 动作必须以"可执行的事"开头（或「给大家…」这种短介词引导），避免把闲聊当指令 */
const ACTION_START_RE =
  /^(?:卖萌|卖个萌|买个萌|买萌|撒个娇|撒娇|比心|卖乖|唱|点歌|来一首|放一首|@|说|讲|发|问|夸|叫|喊|提醒|公布|宣布|表演|画|送|冒泡|打招呼|贴|给|帮|替|为|跟|对|和)/;

/** 以介词开头时，后面 12 字内必须出现真正的动作，避免「给大家介绍一下」被误判 */
const ACTION_VERB_RE =
  /(?:卖萌|卖个萌|买个萌|买萌|撒个娇|撒娇|比心|唱|点歌|说|讲|发|问|夸|叫|喊|提醒|公布|宣布|表演|画|送|冒泡|打招呼|@)/;

const LEADING_NOISE_RE =
  /^(?:顺便|另外|然后|到时候|待会|待会儿|等会|等会儿|一会|一会儿|之后|回头|下次|晚点|稍后|明天|帮我|帮忙|给我|替我|记得|别忘了|别忘记|一定要|要|就|再|去|先|都|也|还|你|春禾)+/;

const TRAILING_PARTICLE_RE = /(?:吧|呀|哦|啦|咯|哟|嘛|哈|好不好|行吗|可以吗|好吗|行不行|可不可以)+$/;

const RECURRING_RE =
  /(?:以后|今后|从今往后|往后|每次|天天|每天)[^?？]{0,16}(?:都|要|在群里|在群聊)|(?:每次|天天|每天)[^?？]{0,8}(?:都|要)/;

const QUESTION_TAIL_RE = /(?:吗|嘛|么|呢)\s*[?？]?\s*$/;
const POLITE_REQUEST_RE = /(?:好吗|行吗|可以吗|好不好|行不行|可不可以)\s*[?？]?\s*$/;
const QUESTION_HEAD_RE =
  /^(?:你|春禾|小禾)?\s*(?:能|可以|会不会|能不能|可不可以|是不是|要不要|有没有|怎么|为什么|哪|什么|多少)/;

/**
 * 「你能在大群里买个萌吗」——形式是问句，实际是**请求**。
 *
 * 真机实测（2026-10-17 21:03）主人就是这么说的：
 * 「现在你能在大群里买个萌吗」。
 * 若按普通问句丢掉，她只会回一句"能呀"，群里什么都没发生——正是用户抱怨的
 * 「私下发的指令群里不执行」。所以只要句子里有明确的场景锚点 + 能力词，
 * 就按请求继续解析；动作不成立（如"你能在群里做什么吗"）时后续仍会拒绝。
 */
const CAPABILITY_REQUEST_RE =
  /^(?:现在|目前|此刻)?\s*(?:你|春禾|小禾)?\s*(?:现在|目前)?\s*(?:能|可以|会不会|能不能|可不可以)(?:不能)?\s*(?:在|到|去|进|回)?\s*(?:那个|这个|咱们|我们)?\s*(?:大群|小群|群|群聊)/;

/** 自我陈述（"我在群里说这件事"）不是给她的指令，除非带明确的请求/未来安排 */
const SELF_STATEMENT_RE = /^我(?:会|要|在|到|去|想|准备|打算)?/;

/** 判断一条私聊消息是不是"待会到群里做 X" */
export function parsePendingInstruction(rawText, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const text = normalizePendingText(rawText);
  if (!text || text.length < 3) return null;

  // 否定/劝阻：不是待办
  if (/^(?:别|不要|不用|甭|千万别|不需要)/.test(text)) return null;
  if (/(?:别|不要|不用|甭)\s*(?:在|到|去|进)?\s*(?:群|群聊)/.test(text)) return null;

  // ⚠️ **行为/态度要求不是待办**（2026-10-19 真机，很典型）：
  //   主人说「乙某是主人比较重要的人，等下他群里说话的时候可以亲近点」——
  //   意思是"以后对他态度好点"，解析器却匹配成「群里说…」→ **她真的往群里发了一条**。
  //   判据：内容是**待人方式**（亲近/热络/客气/温柔/耐心/别理/态度…），
  //   而不是"要说某句话"→ 不建待办，交给人格层当偏好记住。
  const MANNER_RE =
    /(?:亲近|热络|亲昵|客气|温柔|耐心|友好|热情|冷一点|热一点|态度|别理|别太|顺着|哄|让着|礼貌|别跟他一般|对他好|对.{1,4}好点|多照顾)/;
  const SAY_CONTENT_RE =
    /(?:说|讲|念|喊|叫|发)(?:句|一句|一段|条|个)?(?:话|文字|消息|语音)?[「“"：:]|说[\u4e00-\u9fa5]{2,}(?:晚安|早安|生日快乐)/;
  if (MANNER_RE.test(text) && !SAY_CONTENT_RE.test(text)) return null;

  // ⚠️ 语音「能力询问」不是待办（2026-10-19 真机：主人问「嗯，你现在能在群里发语音吗？」
  // 被建成了待办，然后她去群里执行——但其实那只是问能力）。
  // 判据：提到 语音/声音，但**没有"用语音说某句话"的内容动词** → 是问能力，不是指令。
  // 反例（该建待办）：「在群里用语音说晚安」「发条语音说想你们了」。
  if (
    /(?:语音|声音)/.test(text) &&
    !/(?:用语音说|用声音说|语音说|发条语音说|发个语音说|发一段语音说|语音回我|语音念|语音喊|语音讲)/.test(text)
  ) {
    return null;
  }

  // 提问不是指令；但「…好吗/行吗/可以吗」是礼貌请求，「你能在群里…吗」也是请求，
  // 「在群里@某人…吗」同样是请求（真机原句有时不带句首的「能」）。
  const capabilityRequest = CAPABILITY_REQUEST_RE.test(text);
  const atQuestionRequest =
    !/了[吗嘛么]\s*[?？]?\s*$/.test(text) &&
    /@\s*[^\s，。！？,.!?]+/.test(text) &&
    /[吗嘛么]\s*[?？]?\s*$/.test(text);
  const requestLike = capabilityRequest || atQuestionRequest;
  if (QUESTION_TAIL_RE.test(text) && !POLITE_REQUEST_RE.test(text) && !requestLike) return null;
  if (QUESTION_HEAD_RE.test(text) && !requestLike) return null;
  if (/(?:能不能|可不可以|做得到吗|会吗|行不行)\s*[?？]?\s*$/.test(text)) return null;

  const cue = SCENE_CUE_RE.exec(text);
  // 「@李四提醒他交作业」没写场景锚点，但以 @ 开头、且带转述动作：
  // 跨场景指令默认发到任意群（和「在群里卖个萌」的 any_group 同义）。
  // 不加这条，「@李四提醒他交作业」会在第一步就被当成普通闲聊丢掉。
  const bareAt = !cue && /^@\s*\S/.test(text) && /(?:让|叫|喊|提醒|催|告诉|转告|跟|对|问|说|请|帮)/.test(text);
  if (!cue && !bareAt) return null;

  const beforeCue = cue ? text.slice(0, cue.index).trim() : "";
  const deferred = /(?:待会|待会儿|等会|等会儿|一会|一会儿|之后|回头|下次|晚点|稍后|明天|到时候)/.test(
    text,
  );
  const request = /(?:帮我|帮忙|给我|替我|记得|别忘了|麻烦|请|你|春禾)/.test(text);
  if (!deferred && !request && SELF_STATEMENT_RE.test(beforeCue)) return null;

  let action = normalizePendingText(cue ? text.slice(cue.index + cue[0].length) : text);
  action = action
    .replace(/^[\s，,。.、!！~～:：;；\-]+/, "")
    .replace(LEADING_NOISE_RE, "")
    .replace(/^[\s，,。.、!！~～:：;；\-]+/, "")
    .replace(TRAILING_PARTICLE_RE, "")
    .trim();
  // 问句请求（「你能在大群里买个萌吗」）把句尾的疑问语气词剥掉，
  // 否则待办动作会变成「买个萌吗」、回执也别扭。
  if (requestLike) {
    action = action.replace(/[吗么嘛呢]\s*[?？]?$/, "").trim();
  }
  if (!action || action.length < 2) return null;

  // 「你能在群里发语音吗」「嗯，你现在能在群里发语音？」只是问能力：
  // 没有要念的内容，绝不能建待办（否则会把「语音」当成一句话发到群里）。
  // 有内容的「你能在群里用语音说晚安吗」仍然照建（voice）。
  // 不能只看句首「你能…」：真机原话带「嗯，」前缀，句首判断会漏。
  const voiceSaid = parseVoiceSaidInstruction(action);
  const voiceOnlyAsk =
    /^(?:发|来|用|使用)?(?:一?条|一?个|一?句)?(?:语音|声音)(?:消息)?(?:吗|么|嘛|呢)?[?？]?$/.test(
      action,
    );
  if (!voiceSaid && voiceOnlyAsk) return null;
  if (!ACTION_START_RE.test(action) && !voiceSaid) return null;
  if (/^(?:给|帮|替|为|跟|对|和)/.test(action) && !ACTION_VERB_RE.test(action.slice(0, 12))) {
    return null;
  }
  // 纯提问/能力询问混在动作里（"在群里说你能做什么"）→ 不当待办
  if (/(?:能做什么|做什么|怎么办|怎么弄|行不行|可以吗)/.test(action)) return null;

  const target =
    cue?.[1] === "大群"
      ? PENDING_TARGET_SIZE_LARGE
      : cue?.[1] === "小群"
        ? PENDING_TARGET_SIZE_SMALL
        : cue?.[2]
          ? `group:${cue[2]}`
          : PENDING_TARGET_ANY_GROUP;
  const sizeLabel = cue?.[1] === "大群" ? "large" : cue?.[1] === "小群" ? "small" : "";
  const recurring = RECURRING_RE.test(text);
  const { kind, payload } = classifyPendingAction(action);

  // 贴纸类：动作名不能是「发下」这种动词残片，回执要能读
  if (payload?.sticker) {
    const bare = action.replace(/^发(?:个|一个|张)?/, "").trim();
    if (!bare || /^(?:下|表情|贴图|表情包)$/.test(bare)) action = "发个表情包";
  }

  if (capabilityRequest) {
    // 「说一句晚安吗」→「晚安」；「@张三吗」→「张三」
    if (payload?.text) payload.text = payload.text.replace(/[吗么嘛呢]\s*[?？]?$/, "").trim();
    if (payload?.mention) payload.mention = payload.mention.replace(/[吗么嘛呢]\s*[?？]?$/, "").trim();
    if (payload?.message) payload.message = payload.message.replace(/[吗么嘛呢]\s*[?？]?$/, "").trim();
    // 「你能在群里说话吗」「你能在群里唱首歌吗」是能力询问，不是具体请求
    if (kind === "say" && /^(?:话|什么|啥|什么话|一句话|声音|语音|点啥|啥话)$/.test(payload?.text ?? "")) {
      return null;
    }
    if (kind === "voice" && !payload?.text) return null;
    if (kind === "sing" && !payload?.songName) return null;
    // 「你能在群里说话吗」只是能力询问：没有具体内容，不该建待办
    if (kind === "generic" && /^(?:说话|讲话|说句话|讲话吗)$/.test(action)) return null;
  }

  // 歧义/敏感内容（如「漂唱」这种既像梗又像敏感词的转述）：不自动发。
  // 只留一条待确认草稿，先让模型问清楚——群消息发出去撤不回，宁可慢一步。
  const needsConfirmReason = pendingNeedsConfirmReason(kind, payload);

  return {
    action,
    kind,
    payload,
    target,
    sizeLabel,
    recurring,
    needsConfirm: Boolean(needsConfirmReason),
    needsConfirmReason,
    createdScene: "c2c",
    expiresAt: now + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS),
  };
}

/**
 * 待办内容里的歧义/敏感词。
 *
 * 真机第 34 条：主人说「@junh 让他去漂唱」，她先反问是不是「漂泊带土」的梗——
 * 这个谨慎是对的。区别在于：**问清楚之前不能发**。主动群消息没有撤回键，
 * 发错一次就是当众事故，所以这里返回原因，引擎据此只存草稿、不投递。
 */
const AMBIGUOUS_MESSAGE_RE =
  /(?:漂唱|嫖|嫖娼|开房|约炮|裸聊|裸照|性关系|滚床单|傻逼|去死|弄死|打死|揍他|威胁|恐吓|转账|借钱|贷款|密码|身份证|银行卡|住址|不雅|黄图)/;

/** 判断待办转述内容是否含义不明/敏感；返回人话原因，空串=没问题 */
export function pendingNeedsConfirmReason(kind, payload) {
  // 只说「发一下/发个」，不知道发什么：绝不猜，先问清楚（群消息发出去撤不回）
  if (payload?.ambiguous === "send_what") {
    return "主人只说了「发一下」，" + botName() + "不知道要发什么（表情包？一句话？），没敢往群里发";
  }
  if (kind !== "at" && kind !== "say" && kind !== "voice") return "";
  const message = String(payload?.message ?? payload?.text ?? "").trim();
  if (!message) return "";
  const hit = message.match(AMBIGUOUS_MESSAGE_RE);
  if (hit) return `「${hit[0]}」这个词${botName()}拿不准是哪个意思、分寸也拿不准`;
  if (/^(?:那个|这个|那件事|那事|这件事|那样子|随便)$/.test(message)) {
    return "转述内容只有「那个」这种指代，" + botName() + "不知道具体要说什么";
  }
  return "";
}

/**
 * 拆「@名字 + 转述内容」。
 *
 * QQ 群消息里没有群昵称，@ 只能按主人写下的名字转成文字；这里只负责把
 * 名字和要转述的话分开，**不负责把它变成平台真 @**（那需要群成员表，
 * 主动消息路径上拿不到，见报告里的 11253）。
 *
 * 支持：
 *   @junh让他去漂唱      → mention=junh, message=去漂唱
 *   @张三说该开会了       → mention=张三, message=该开会了
 *   @李四提醒他交作业     → mention=李四, message=交作业
 */
export function parseAtInstruction(text) {
  const raw = String(text ?? "").trim();
  const at = /^@\s*([^\s，。！？,!?：:@]{1,30})([\s\S]*)$/u.exec(raw);
  if (!at) return null;
  const head = at[1];
  // 名字和后面的转述动作往往粘连（「张三说…」）：在第一个转述动词处切开。
  const split = /^([^\s，。！？,!?：:]{1,20}?)(?=(?:让|叫|喊|提醒|催|催促|告诉|转告|跟|对|问|说|请|帮|麻烦))/u.exec(
    head,
  );
  const mention = (split ? split[1] : head).replace(/[吗么嘛呢]+$/u, "").trim();
  if (!mention) return null;
  let message = `${split ? head.slice(split[1].length) : ""}${at[2] ?? ""}`;
  message = message
    .replace(/^[\s，,。.、！!？?：:；;~～-]+/u, "")
    .replace(
      /^(?:让|叫|喊|提醒|催促|催|告诉|转告|跟|对|问|说|请|麻烦|帮我|帮忙)(?:他|她|它|他们|她们|一下|一声|一句)?/u,
      "",
    )
    .replace(/^[\s，,。.、！!？?：:；;~～-]+/u, "")
    .replace(/[吗么嘛呢]\s*[?？]?$/u, "")
    .trim();
  return { mention, message };
}

/**
 * 「用语音说 X」→ 只抽出要念的 X。
 *
 * 为什么要单独解析：现有分类把「说」当成 `say`（发文字），而
 * 「在群里用语音说晚安」的动作以「用/语音/发…语音」开头。若只把
 * 「用」加进 ACTION_START，它会被 `say` 分支按"说"解析成
 * 「语音说晚安」这种奇怪内容，然后当文字发出去。
 *
 * 支持（举例）：
 *   用语音说晚安 / 用声音说晚安 / 语音说句大家好 / 发条语音说想你们了
 *   发语音告诉主人早点睡 / 用语音发一句晚安 / 语音说：今天好累
 *
 * 返回 null 表示"没有可念的内容"（例如「用语音说话」只是问能力），
 * 调用方据此不建 voice 待办。
 *
 * @param {string} text 已去掉场景锚点的动作文本
 * @returns {{text: string}|null}
 */
export function parseVoiceSaidInstruction(text) {
  const s = normalizePendingText(text);
  if (!s) return null;
  const m = VOICE_SAID_PREFIX_RE.exec(s);
  if (!m) return null;

  let said = s
    .slice(m[0].length)
    .replace(/^[「"“'『]+/u, "")
    .replace(/[」"”'』]+$/u, "")
    .trim();
  // 「说句大家好」「发一句晚安」「说声谢谢」里的量词只是补语
  said = said.replace(/^(?:一?句|一?声|一?个|一?条|条|句|个|下|一下|一点)\s*/u, "").trim();
  // 问句残留（能力询问里常见）
  said = said.replace(/[吗么嘛呢]\s*[?？]?$/u, "").replace(/[。.!！~～]+$/u, "").trim();

  if (!said) return null;
  // 只剩"话/语音/消息"这类词 = 没说要念什么，绝不能当成一句话发出去
  if (/^(?:话|句话|声|声音|语音|消息|什么|啥|点啥|啥话|一点|点儿|吧|呗|啦)$/u.test(said)) {
    return null;
  }
  return { text: said };
}

/**
 * 「用语音说」的动作前缀。
 *
 * 三种引导方式：
 *   - 用/使用 + 语音/声音 + 说/讲/念/读/告诉/发…
 *   - 发/来/整/丢/甩 + [条|个|句] + 语音/声音 + [消息] + 说…
 *   - 语音/声音 + 说…
 */
const VOICE_SAID_PREFIX_RE =
  /^(?:(?:用|使用)(?:一?条|一?个)?(?:语音|声音)|(?:发|来|整|丢|甩)(?:一?条|一?个|一?条消息|条|个|句)?(?:语音|声音)|(?:语音|声音))(?:消息)?(?:来)?(?:说|讲|念|读|告诉|发给|发|回)?[：:，,。.!！~～\s]*/u;

/** 动作分类：@ / 语音 / 唱 / 卖萌 / 说 / 其他 */
export function classifyPendingAction(action) {
  const text = normalizePendingText(action);
  // @ 必须最先判：否则「@junh让他去漂唱」会被「唱」字抢先归成点歌，
  // 再因为抽不出歌名而被丢掉——真机第 36 条没建待办就是这么来的。
  const at = parseAtInstruction(text);
  if (at) return { kind: "at", payload: at };

  // 「用语音说 X」必须排在「说/发」之前：否则会按 say 抽出
  // 「语音说晚安」这种残片，然后当文字发到群里。
  const voice = parseVoiceSaidInstruction(text);
  if (voice) return { kind: "voice", payload: voice };

  if (/唱|点歌|来一首|放一首/.test(text)) {
    // extractSongName 只认开头动作，且不剥书名号后半；这里补一刀。
    const rawSong = extractSongName(text).replace(/[》」"”'）)]+$/g, "").trim();
    // extractSongName 对「唱首歌」可能只剩「首」，长度不足就当作"没点名"
    const songName = rawSong && rawSong.length >= 2 && !/[唱歌]/.test(rawSong) ? rawSong : "";
    return { kind: "sing", payload: { songName } };
  }
  if (/(?:卖萌|卖个萌|买个萌|买萌|撒个娇|撒娇|比心|卖乖)/.test(text)) {
    return { kind: "cute", payload: {} };
  }

  // 表情包/贴图不是"说一句话"：沿用 generic（发送由引擎的贴纸路径负责），
  // 但必须打上 payload.sticker——否则会把「表情包」三个字当成一句话发出去。
  if (/(?:表情包|贴图|表情)/.test(text)) {
    return { kind: "generic", payload: { sticker: true } };
  }

  // 真机 2026-10-17 22:22：主人说「群里发下」，被抽成动作「发下」，
  // 然后真的往群里发了一条叫「发下」的消息。这里的「下」只是语气补语，
  // 结合上一句（刚聊表情包）应理解为「发个表情包」。
  if (/^发下$/.test(text)) {
    return { kind: "generic", payload: { sticker: true } };
  }

  if (/^(?:说|讲|发)/.test(text)) {
    const said = text
      .replace(
        /^(?:说|讲|发)(?:(?:个|一个|一条|条|一句|句|声)(?:消息|话|讯息)?)?(?:说|讲|告诉)?[：:，,\s]*/,
        "",
      )
      .replace(/^[「"“']+/, "")
      .replace(/[」"”']+$/, "")
      .trim();
    // 「发一下 / 发个 / 说话」这种残片不是内容，不能当消息发出去
    if (
      said &&
      !/^(?:下|一下|个|点|些|啥|什么|东西|话|句话|消息|语音|声音|吧|呗|啦)$/.test(said)
    ) {
      return { kind: "say", payload: { text: said } };
    }
  }

  // 只说「发一下/发个/发个消息」「发条语音」——不知道发什么，标记成待确认，先问清楚再发
  if (
    /^(?:发|来|整|丢|甩)(?:下|一下|个|一个|一条|条|张|一张|点|点个|些)?(?:消息|话|语音|声音)?$/.test(
      text,
    )
  ) {
    return { kind: "generic", payload: { ambiguous: "send_what" } };
  }
  return { kind: "generic", payload: {} };
}

/** 人类可读的剩余时间 */
export function formatRemaining(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 60 * 1000) return "一会儿";
  if (n < 3600 * 1000) return `${Math.max(1, Math.round(n / 60000))} 分钟`;
  if (n < 24 * 3600 * 1000) return `${Math.max(1, Math.round(n / 3600000))} 小时`;
  return `${Math.max(1, Math.round(n / 86400000))} 天`;
}

/** 私聊里创建待办后的确定性回执（绝不让她自由发挥成"做不到"） */
export function describePendingConfirmation(entry, { now = Date.now() } = {}) {
  if (!entry) return "";
  if (entry.payload?.needsConfirm) {
    const why = String(entry.payload.needsConfirmReason || "这句话" + botName() + "拿不准是什么意思").trim();
    return `这句${botName()}还没敢发到群里：${why}。主人把要发的话说清楚一点，${botName()}再发——现在真的没发。`;
  }
  const where = entry.target === PENDING_TARGET_ANY_GROUP ? "在群里" : "在指定的群里";
  const left = formatRemaining((entry.expiresAt ?? now) - now);
  return `记住啦～等主人${where}说话，${botName()}就${entry.action}（${left}内有效）💖`;
}

/**
 * 主动投递结果回执（成功/失败都必须如实）。
 *
 * 为什么不让模型写这句：模型会本能地说「已经发啦」——即使平台刚刚拒发。
 * 成功/失败、发到哪个群、凭什么是大群小群，全部由确定性代码说清楚。
 *
 * @param {object} entry 待办
 * @param {object} result
 * @param {boolean} result.ok
 * @param {string} [result.reason] no_known_group / no_large_group / no_small_group / quota / send_failed
 * @param {object|null} [result.group] 群注册表视图（shortId/sizeText/memberCount/observedCount）
 * @param {object|null} [result.quota] 配额检查结果（level/dayCount/limit）
 * @param {string} [result.error] 人话失败原因
 */
export function describeProactiveDelivery(entry, result = {}) {
  if (!entry) return "";
  const action = normalizePendingText(entry.action) || "这件事";
  const group = result?.group ?? null;
  const quota = result?.quota ?? null;
  const shortId = group?.shortId ?? result?.shortId ?? "";
  const where = group
    ? `${group.sizeText ?? "群"} ${shortId}`.trim()
    : shortId
      ? `群 ${shortId}`
      : "群里";
  const evidence = group
    ? group.memberCount
      ? ` · ${group.memberCount} 人`
      : ` · 至少 ${group.observedCount ?? 0} 位发言人，成员数接口没权限，按下限估算`
    : "";

  if (result?.ok) {
    // 语音待办：必须区分「真的是语音」和「语音没成、改成文字」——
    // 说成语音就是骗人，说成没发又是假的。
    if (entry.kind === "voice") {
      const said = String(entry.payload?.text ?? "").trim();
      let note = result.voice
        ? `已经用语音发到群里啦～（${where}${evidence}）`
        : `语音这次没合成出来（${String(result.voiceFallback ?? "原因未知").trim()}），` +
          `${botName()}把这句话改成文字发到群里了：「${said}」（${where}${evidence}）`;
      if (quota?.level === "warn") {
        note += `；今天这个功能已经发了 ${quota.dayCount}/${quota.limit} 条，快到自限了`;
      }
      return note;
    }
    const subject = entry.payload?.sticker ? "表情包" : "";
    let note = `${subject}已经发到群里啦～（${where}${evidence}）`;
    // 主动消息路径拿不到群成员表（真机 11253 无权限），@ 只是「@名字」这几个字，
    // 不是平台真 @、对方不会收到 @ 提醒。回执必须说清楚，不能让她宣称"他一定看到了"。
    if (entry.kind === "at") {
      note +=
        "；不过群里发出去的只是「@名字」这几个字，做不了真 @ 提醒（群成员表接口没权限），对方不一定收得到通知";
    }
    if (quota?.level === "warn") {
      note += `；今天这个功能已经发了 ${quota.dayCount}/${quota.limit} 条，快到自限了`;
    }
    return note;
  }

  const reason = String(result?.reason ?? "");
  if (reason === "quota") {
    const limit = quota?.limit ?? 0;
    return `呜……「${action}」还没发：这个功能的群主动消息今天到自限上限了（${limit} 条/天）。主人到群里说一声，${botName()}用回复补上～`;
  }
  if (reason === "no_large_group") {
    return `${botName()}记着「${action}」，可认不出哪个是大群（成员数接口没权限，只能按见过的发言人估算）。主人到想发的大群里说一声，${botName()}就在那里做～`;
  }
  if (reason === "no_small_group") {
    return `${botName()}记着「${action}」，可认不出哪个是小群（只能按见过的发言人估算）。主人到想发的小群里说一声，${botName()}就在那里做～`;
  }
  if (reason === "sticker_unavailable") {
    return "呜……" + botName() + "想发个表情包，可素材还没准备好，这次没发到群里，没骗主人。";
  }
  if (reason === "send_failed") {
    const why = String(result?.error ?? "").trim() || "平台没有返回原因";
    return `呜……「${action}」没发出去（${why}）。这条${botName()}还记着，主人到群里说一声，${botName()}再补上，绝不假装发了。`;
  }
  // no_known_group / unknown：不知道群就绝不瞎发，给主人一个明确办法
  return `${botName()}把「${action}」记着了，但还不知道主人在哪些群——主人在群里随便说一声，${botName()}立刻做～`;
}

/** 长期规矩（"以后每次…"）的回执：它不是一次性待办 */
export function describeRecurringConfirmation(action) {
  const a = normalizePendingText(action);
  return `这条${botName()}记成长期规矩了：以后${a ? `每次在群里都会${a}` : "在群里都会照做"}～`;
}

/** 给模型看的待办附注；只在主人上下文里出现 */
export function describePendingForModel(entries, { scene = "c2c", now = Date.now() } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return "";
  const pending = list.filter((e) => e?.status === PENDING_STATUS.PENDING).slice(0, 5);
  if (!pending.length) return "";
  const lines = pending.map((e) => {
    const where = e.target === PENDING_TARGET_ANY_GROUP ? "任意群" : "指定群";
    const confirm = e.payload?.needsConfirm ? "，含义未确认，**不会自动发**" : "";
    return `- 「${e.action}」（${where}，${formatRemaining((e.expiresAt ?? now) - now)}后过期${confirm}）`;
  });
  if (scene === "group") {
    return [
      "【主人私聊交代的待办 · 现在执行】主人之前在私聊里让你在群里做这些事：",
      ...lines,
      "这一轮如果轮到它，就自然做到；不要解释这是待办，更不要说「私聊没法往群里转发」——那是错的。",
    ].join("\n");
  }
  return [
    "【你记着的跨场景待办】主人之前在私聊里交代过，到群里要做：",
    ...lines,
    "系统会优先主动发到群里；没发出去时，主人到群里说一声也会兜底执行。主人问起就如实说记着呢，**不要声称私聊指令没法在群里实现**。",
  ].join("\n");
}

/** 给模型看的"这一轮正在执行/刚执行完"的提示 */
export function describePendingActionForModel(entry, { scene = "group", now = Date.now() } = {}) {
  if (!entry?.action) return "";
  const left = formatRemaining((entry.expiresAt ?? now) - now);
  if (scene === "group") {
    return [
      "【主人私聊交代的待办 · 现在执行】主人之前让你在这个群里做：",
      `- 「${entry.action}」`,
      `这一轮就要自然地做到（${left}后过期）。` +
        "不要解释这是待办，更不要说「私聊没法往群里转发」——那是错的。",
    ].join("\n");
  }
  return [
    "【你记着的跨场景待办】主人之前在私聊交代过，到群里要做：",
    `- 「${entry.action}」`,
    "到群里时系统会自动执行；不要声称私聊指令没法在群里实现。",
  ].join("\n");
}

/** 给模型看的"这一轮正在执行/刚执行完"的提示 */
export function describePendingExecutionForModel({
  action,
  kind,
  ok = true,
  songName = "",
  text = "",
  failure = "",
} = {}) {
  if (!action && !songName) return "";
  if (kind === "voice") {
    const said = String(text ?? "").trim() || action;
    if (ok) {
      return (
        `【刚执行的待办】你应主人私聊的嘱咐，在群里用语音说了「${said}」。` +
        "不要重复说，也不要解释待办；语音已经真的发出去了。"
      );
    }
    return (
      `【待办执行失败】主人私聊交代的语音「${said}」没发出去（${failure || "未知原因"}），` +
      "已经如实告诉主人，绝不许补一句「我说了」假装发了语音。"
    );
  }
  if (kind === "sing") {
    if (ok) {
      return `【刚执行的待办】你应主人私聊的嘱咐，在群里唱了${songName ? `《${songName}》` : "一首歌"}。可以自然接一句，不要重复唱、也不要解释待办。`;
    }
    return `【待办执行失败】你想唱${songName ? `《${songName}》` : "歌"}，但没发出去（${failure || "未知原因"}）。已经如实告诉主人，绝不许补歌词冒充唱歌。`;
  }
  if (ok) {
    return `【刚执行的待办】你应主人私聊的嘱咐，已经在群里做到了「${action}」。不要重复做，也不要解释待办。`;
  }
  return `【待办执行失败】主人私聊交代的「${action}」这次没做成（${failure || "未知原因"}），如实说，不要假装做到了。`;
}

/**
 * 待办队列：独立 JSON，不占 historyTurns。
 */
export class PendingActionStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] 持久化路径；为空则纯内存
   * @param {number} [opts.ttlMs] 默认有效期（毫秒）
   * @param {number} [opts.maxActions] 最多保留多少条
   * @param {object} [opts.logger]
   */
  constructor({ file = "", ttlMs = DEFAULT_TTL_MS, maxActions = DEFAULT_MAX_ACTIONS, logger } = {}) {
    this.file = file;
    // 上限 1ms 只是为了测试能快速验证过期；生产配置走 pendingTtlHours（≥1 小时）
    this.ttlMs = Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS);
    this.maxActions = Math.max(1, Number(maxActions) || DEFAULT_MAX_ACTIONS);
    this.logger = logger;
    /** @type {Array<object>} */
    this.actions = [];
    this._dirty = false;
    this._timer = null;
    if (this.file) this.load();
  }

  get size() {
    return this.actions.length;
  }

  pendingCount(ownerId) {
    return this.list({ ownerId }).length;
  }

  /**
   * 新建一条待办。同 owner/action/target 的 pending 在 5 分钟内重复说，
   * 视为"再确认一次"：刷新有效期，不重复入队（避免刷屏式重复创建）。
   */
  create({
    ownerId,
    action,
    kind = "generic",
    target = PENDING_TARGET_ANY_GROUP,
    delivery = PENDING_DELIVERY.DEFERRED,
    createdScene = "c2c",
    createdGroup = "",
    payload = {},
    expiresAt,
    now = Date.now(),
  } = {}) {
    const owner = String(ownerId ?? "").trim();
    const text = normalizePendingText(action);
    if (!owner || !text) return null;

    this.sweep(now);
    const dup = this.actions.find(
      (a) =>
        a.ownerId === owner &&
        a.status === PENDING_STATUS.PENDING &&
        a.action === text &&
        a.target === target,
    );
    if (dup && now - (dup.createdAt ?? 0) <= DUP_WINDOW_MS) {
      dup.expiresAt = Math.max(dup.expiresAt ?? 0, Number(expiresAt) || now + this.ttlMs);
      dup.lastRepeatedAt = now;
      this._markDirty();
      return { ...dup };
    }

    const entry = {
      id: `pa_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ownerId: owner,
      action: text,
      kind: String(kind || "generic"),
      target: String(target || PENDING_TARGET_ANY_GROUP),
      delivery: delivery === PENDING_DELIVERY.PROACTIVE ? PENDING_DELIVERY.PROACTIVE : PENDING_DELIVERY.DEFERRED,
      createdScene: String(createdScene || "c2c"),
      createdGroup: String(createdGroup || ""),
      status: PENDING_STATUS.PENDING,
      createdAt: now,
      expiresAt: Number(expiresAt) || now + this.ttlMs,
      doneAt: null,
      doneGroup: null,
      result: "",
      attempts: 0,
      lastError: "",
      executedGroups: [],
      payload: payload && typeof payload === "object" ? { ...payload } : {},
    };
    this.actions.push(entry);
    this._prune(now);
    this._markDirty();
    this.logger?.info?.(`待办已记下：${entry.action.slice(0, 30)}（${entry.target}）`);
    return { ...entry };
  }

  /** 取某人的待办；不传 ownerId 一律返回空（安全默认） */
  list({ ownerId, status = PENDING_STATUS.PENDING, now = Date.now() } = {}) {
    const owner = String(ownerId ?? "").trim();
    if (!owner) return [];
    this.sweep(now);
    return this.actions
      .filter((a) => a.ownerId === owner && (status == null || a.status === status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => ({ ...a, payload: { ...(a.payload ?? {}) } }));
  }

  /** 取全部（诊断用；不含别的 ownerId 的过滤，调用方必须自己保证权限） */
  listAll(now = Date.now()) {
    this.sweep(now);
    return this.actions.map((a) => ({ ...a }));
  }

  get(id, now = Date.now()) {
    this.sweep(now);
    const hit = this.actions.find((a) => a.id === id);
    return hit ? { ...hit, payload: { ...(hit.payload ?? {}) } } : null;
  }

  /**
   * 是否该在这一轮执行：只有**主人本人**在群里说话才返回待办。
   *
   * 为什么限制 fromOwner：
   *   - 群成员说话时执行主人的私聊待办，会让群里的人觉得莫名其妙；
   *   - 也避免"任意群"的待办在主人根本没出现的群里被触发；
   *   - 安全上最干净：非主人既看不到、也触发不了。
   */
  match({ ownerId, groupOpenid, fromOwner = false, now = Date.now() } = {}) {
    if (!fromOwner) return null;
    const owner = String(ownerId ?? "").trim();
    const gid = String(groupOpenid ?? "").trim();
    if (!owner || !gid) return null;
    this.sweep(now);
    const hit = this.actions
      .filter((a) => a.ownerId === owner && a.status === PENDING_STATUS.PENDING)
      // 待确认的草稿永远不自动执行：含义没确认就发到群里，撤不回来。
      .filter((a) => !a.payload?.needsConfirm)
      .filter((a) => a.target === PENDING_TARGET_ANY_GROUP || a.target === `group:${gid}`)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    return hit ? { ...hit, payload: { ...(hit.payload ?? {}) } } : null;
  }

  markDone(id, { groupOpenid = "", result = "ok", now = Date.now() } = {}) {
    const entry = this.actions.find((a) => a.id === id);
    if (!entry) return null;
    entry.status = PENDING_STATUS.DONE;
    entry.doneAt = now;
    entry.doneGroup = String(groupOpenid || "");
    entry.result = String(result || "ok");
    if (groupOpenid && !entry.executedGroups.includes(groupOpenid)) {
      entry.executedGroups.push(String(groupOpenid));
    }
    this._markDirty();
    this.logger?.info?.(`待办已完成：${entry.action.slice(0, 30)}`);
    return { ...entry };
  }

  /** 执行失败：保留 pending，便于下次重试；连续失败太多则过期，避免无限重试 */
  markAttempt(id, { error = "", now = Date.now(), maxAttempts = 3 } = {}) {
    const entry = this.actions.find((a) => a.id === id);
    if (!entry) return null;
    entry.attempts = (entry.attempts ?? 0) + 1;
    entry.lastError = String(error || "");
    entry.lastAttemptAt = now;
    if (entry.attempts >= maxAttempts) {
      entry.status = PENDING_STATUS.EXPIRED;
      entry.expiredAt = now;
      entry.result = "failed";
      this.logger?.warn?.(`待办连续失败 ${entry.attempts} 次，已过期：${entry.action.slice(0, 30)}`);
    }
    this._markDirty();
    return { ...entry };
  }

  markExpired(id, { reason = "expired", now = Date.now() } = {}) {
    const entry = this.actions.find((a) => a.id === id);
    if (!entry) return null;
    entry.status = PENDING_STATUS.EXPIRED;
    entry.expiredAt = now;
    entry.result = String(reason);
    this._markDirty();
    return { ...entry };
  }

  /** 把到期的 pending 标成 expired；返回本次新过期的条数 */
  sweep(now = Date.now()) {
    let changed = 0;
    for (const a of this.actions) {
      if (a.status === PENDING_STATUS.PENDING && Number(a.expiresAt) <= now) {
        a.status = PENDING_STATUS.EXPIRED;
        a.expiredAt = now;
        a.result = "expired";
        changed += 1;
      }
    }
    if (changed) {
      this.logger?.info?.(`${changed} 条待办已过期`);
      this._markDirty();
    }
    this._prune(now);
    return changed;
  }

  clear(ownerId = "") {
    const owner = String(ownerId ?? "").trim();
    this.actions = owner ? this.actions.filter((a) => a.ownerId !== owner) : [];
    this._markDirty();
  }

  _prune(now = Date.now()) {
    // 终态保留 7 天供审计；pending 不按时间删（由 TTL 管）
    this.actions = this.actions.filter(
      (a) =>
        a.status === PENDING_STATUS.PENDING ||
        now - Number(a.doneAt ?? a.expiredAt ?? a.createdAt ?? now) <= KEEP_TERMINAL_MS,
    );
    if (this.actions.length <= this.maxActions) return;
    this.actions.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    while (this.actions.length > this.maxActions) {
      // 先从最旧的终态删；没有终态才动最旧的 pending
      const idx = this.actions.findIndex((a) => a.status !== PENDING_STATUS.PENDING);
      this.actions.splice(idx >= 0 ? idx : 0, 1);
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
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        actions: this.actions,
      };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      this.logger?.warn?.(`待办写盘失败：${err?.message}`);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const arr = Array.isArray(data?.actions) ? data.actions : [];
      this.actions = arr
        .filter((a) => a && typeof a.id === "string" && typeof a.ownerId === "string")
        .map((a) => ({
          id: a.id,
          ownerId: a.ownerId,
          action: normalizePendingText(a.action),
          kind: String(a.kind ?? "generic"),
          target: String(a.target ?? PENDING_TARGET_ANY_GROUP),
          delivery:
            a.delivery === PENDING_DELIVERY.PROACTIVE
              ? PENDING_DELIVERY.PROACTIVE
              : PENDING_DELIVERY.DEFERRED,
          createdScene: String(a.createdScene ?? "c2c"),
          createdGroup: String(a.createdGroup ?? ""),
          status: Object.values(PENDING_STATUS).includes(a.status)
            ? a.status
            : PENDING_STATUS.PENDING,
          createdAt: Number(a.createdAt) || Date.now(),
          expiresAt: Number(a.expiresAt) || Date.now() + this.ttlMs,
          doneAt: a.doneAt ?? null,
          doneGroup: a.doneGroup ?? null,
          result: String(a.result ?? ""),
          attempts: Number(a.attempts) || 0,
          lastError: String(a.lastError ?? ""),
          lastAttemptAt: Number(a.lastAttemptAt) || 0,
          lastRepeatedAt: Number(a.lastRepeatedAt) || 0,
          executedGroups: Array.isArray(a.executedGroups) ? a.executedGroups.map(String) : [],
          payload: a.payload && typeof a.payload === "object" ? { ...a.payload } : {},
        }))
        .slice(-this.maxActions);
      this.sweep();
      this.logger?.info?.(`已加载 ${this.actions.length} 条跨场景待办（${this.file}）`);
    } catch (err) {
      this.logger?.warn?.(`待办读取失败，按空启动：${err?.message}`);
      this.actions = [];
    }
  }
}
