/**
 * 提醒意图的解析。
 *
 * 两条路：
 *  1. **模型标记**（主路径）：人设里告诉模型，要安排提醒就在回复里写
 *     `[[remind:5m:该泡面了]]`。引擎解析后把标记从回复里删掉，用户看不到。
 *  2. **本地规则**（兜底 + 本地模式）：直接匹配"5分钟后提醒我"这类说法，
 *     这样不接模型也能用。
 *
 * 标记必须从回复中剥离：它是内部控制信号，不能让用户看到。
 */

import { parseDuration } from "./reminders.js";
import { botName } from "../persona/naming.js";

const MARKER_RE = /\[\[\s*remind\s*:\s*([^:\]]+?)\s*:\s*([^\]]*?)\s*\]\]/gi;

/**
 * 从回复文本里抽出提醒标记。
 * @param {string} text
 * @returns {{text:string, reminders:Array<{delayMs:number|null, delayText:string, message:string}>}}
 */
export function extractReminderMarkers(text) {
  const src = String(text ?? "");
  const reminders = [];
  const cleaned = src.replace(MARKER_RE, (_all, delayText, message) => {
    reminders.push({
      delayText: String(delayText).trim(),
      delayMs: parseDuration(delayText),
      message: String(message ?? "").trim(),
    });
    return "";
  });
  // 标记被删掉后可能留下多余空行
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trim(), reminders };
}

/**
 * 本地规则识别"提醒我"类说法（不需要模型）。
 * 只处理明确的定时表达，避免误判普通聊天。
 *
 * @param {string} text 用户的话（已去 @）
 * @returns {{delayMs:number, message:string}|null}
 */
export function parseReminderRequest(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;

  // 必须有"提醒"意味的词
  if (!/(提醒|叫我|叫醒|喊我|通知我|跟我说一声|和我说一声)/.test(s)) return null;

  // 找时间表达：「5分钟后」「半小时后」「1小时后」「30秒后」「明天早上」暂不处理
  const m = s.match(
    /(\d+(?:\.\d+)?|半|一|两|二|三|四|五|六|七|八|九|十)\s*(秒|分钟|分|小时|时|天)\s*(?:后|之后|以后|later)/i,
  );
  if (!m) return null;

  const numText = m[1];
  const unit = m[2];
  const numMap = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const num = numMap[numText] ?? Number(numText);
  if (!(num > 0)) return null;

  const delayMs = parseDuration(`${num}${unit}`);
  if (!delayMs) return null;

  // 要提醒的内容：优先取冒号后的部分，其次取"提醒我"之后的内容
  let message = "";
  const colon = s.split(/[：:]/);
  if (colon.length > 1) {
    message = colon.slice(1).join(":").trim();
  } else {
    const after = s.match(/(?:提醒我|叫我|喊我|通知我)\s*(.+)$/);
    if (after) message = after[1].trim();
  }
  // 去掉结尾的语气词与标点
  message = message.replace(/[。．.!！?？~～\s]+$/, "").trim();

  return { delayMs, message: message || "（主人让我提醒的事）" };
}

/**
 * 组装一条提醒要发送的文本。
 * 提醒是"几天后突然冒出来"的消息，所以要带上下文，别让人一头雾水。
 */
export function formatReminderMessage(reminder) {
  const text = String(reminder?.text ?? "").trim();
  if (!text) return "" + botName() + "来提醒啦～";
  return `${text}`;
}
