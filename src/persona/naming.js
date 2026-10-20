/**
 * 运行期「机器人自称」注册表。
 *
 * 为什么需要它：人格模块（src/persona/*.js）负责性格与话术，但**共享模块**
 * （core/engine.js、media/tts.js、core/pending-actions.js …）里也有大量会发给
 * 用户的文案带着名字。那些模块大多是纯函数，为了一个名字把 config 从入口层层
 * 透传到最深处，改动面比收益大得多。所以这里放一个进程级的当前自称：
 * 启动时由 main.js 调 setBotName(config.botName) 写入一次，之后各处只读。
 *
 * 默认值故意保持「春禾」：直接 import 这些模块做单元测试时，不启动 main.js，
 * 行为与改造前完全一致。
 *
 * 注意：这里是**兜底**。人格模块自己的自我介绍（提示词里的名字）优先级更高，
 * 换人格时优先改人格文件；BOT_NAME 只影响这些共享文案。
 */

const FALLBACK = "春禾";

let current = FALLBACK;

/** 设置当前自称（空值忽略，避免把名字设成空字符串） */
export function setBotName(name) {
  const n = String(name ?? "").trim();
  if (n) current = n;
}

/** 读取当前自称 */
export function botName() {
  return current;
}

/** 还原成默认值（测试用） */
export function resetBotName() {
  current = FALLBACK;
}
