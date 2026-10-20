/**
 * `send_group_message` 工具 —— 让她**自己判断**"主人是不是要我把这句话发到群里"。
 *
 * 背景（2026-10-19 主人的话）：
 *   「不要这么多提示词，能不能让她理解我的语义做出判断。」
 *
 *   之前用正则匹配「群里发」「骂丙某，骂回去」这类说法，问题是：
 *   主人的说法千变万化，正则永远追不上；而且到处都是硬编码，越堆越丑。
 *
 *   正确做法是把它做成**工具**：她看到工具清单就知道自己"能往群里发话"，
 *   然后由她自己根据主人的语义决定要不要调用、发什么内容、发到哪个群。
 *
 * 调用示例（模型自己生成的参数）：
 *   { text: "丙某，嘴长自己脸上不是用来喷粪的。", group: "大群" }
 *
 * 安全约束（在引擎侧执行时校验）：
 *   · 只有**主人私聊**里才允许（群成员不能借她的手往别的群发话）；
 *   · 只能发到**她所在的群**；
 *   · 发失败要如实回报，不能假装发了。
 */

export const SEND_GROUP_TOOL_NAME = "send_group_message";

/**
 * 构造工具定义。
 *
 * @param {{groups?: Array<{openid: string, label: string}>}} [opts] 她所在的群（用于描述）
 * @returns {object|null} 工具定义；没有可用群时返回 null（不注入）
 */
export function buildSendGroupTool({ groups = [] } = {}) {
  const list = Array.isArray(groups) ? groups.filter((g) => g?.openid) : [];
  if (!list.length) return null;
  const names = list.map((g) => g.label || `${g.openid.slice(0, 6)}…`).join("、");
  return {
    type: "function",
    function: {
      name: SEND_GROUP_TOOL_NAME,
      description:
        "把一句话发到 QQ 群里。当主人在私聊里让你「去群里说…」「骂回去让群里看到」" +
        "「把刚才那句发到群里」这类要求时调用它。" +
        `可用的群：${names}。` +
        "只在你确实认为主人想让群里其他人看到这句话时才调用；" +
        "如果主人只是让你在私聊里说，就不要调用。",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "要发到群里的原话（你说的那句话本身，不要带解释或引号）",
          },
          group: {
            type: "string",
            description: "发到哪个群：可以填群名（如「大群」）或群 openid 的前几位；不填就发到最近活跃的群",
          },
        },
        required: ["text"],
      },
    },
  };
}

/** 解析工具参数（容错：模型偶尔给字符串或带引号） */
export function parseSendGroupArgs(rawArgs) {
  let obj = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      obj = JSON.parse(rawArgs);
    } catch {
      return { text: String(rawArgs ?? "").trim(), group: "" };
    }
  }
  if (!obj || typeof obj !== "object") return { text: "", group: "" };
  return {
    text: String(obj.text ?? obj.content ?? obj.message ?? "").trim(),
    group: String(obj.group ?? obj.group_name ?? obj.target ?? "").trim(),
  };
}

/**
 * 执行工具调用。
 *
 * @param {string} name 工具名（校验用）
 * @param {string|object} rawArgs 模型给的参数
 * @param {{
 *   send?: (text: string, groupHint?: string) => Promise<{ok: boolean, label?: string, error?: string}>,
 *   logger?: object,
 * }} deps
 * @returns {Promise<{ok: boolean, content: string}>}
 *   content 会作为 tool 消息回填给模型——所以必须**如实**描述结果。
 */
export async function executeSendGroupCall(name, rawArgs, deps = {}) {
  const { send, logger } = deps;
  if (name !== SEND_GROUP_TOOL_NAME) {
    return { ok: false, content: `未知工具：${name}` };
  }
  const { text, group } = parseSendGroupArgs(rawArgs);
  if (!text) {
    return { ok: false, content: "没有给我要发送的内容（text 为空），这次没发。" };
  }
  if (typeof send !== "function") {
    logger?.warn?.("send_group_message：引擎没有提供发送能力");
    return { ok: false, content: "当前场景不能往群里发消息，这次没发。" };
  }
  try {
    const res = await send(text, group);
    if (res?.ok) {
      const label = res.label || "群里";
      logger?.info?.(`工具发送群消息成功：${label} ← ${text.slice(0, 40)}`);
      return { ok: true, content: `已真的发到「${label}」：「${text.slice(0, 60)}」` };
    }
    const why = String(res?.error ?? "未知原因");
    logger?.warn?.(`工具发送群消息失败：${why}`);
    return { ok: false, content: `没发出去（${why.slice(0, 40)}）。要如实告诉主人没发成，不要假装发了。` };
  } catch (err) {
    const why = String(err?.message ?? err);
    logger?.warn?.(`工具发送群消息异常：${why}`);
    return { ok: false, content: `没发出去（${why.slice(0, 40)}）。要如实告诉主人没发成。` };
  }
}
