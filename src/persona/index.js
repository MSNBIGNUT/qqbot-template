/**
 * 人格加载器：按 PERSONA 环境变量（config.persona）选择人格模块。
 *
 *   PERSONA=chunhe         → ./chunhe.js（默认，示例人格：春禾）
 *   PERSONA=default        → ./default.js（通用助手人格：小助手）
 *   PERSONA=./my-bot.js    → 你自己的文件（相对**项目根目录**）
 *   PERSONA=src/my-bot.js  → 同上（带路径的写法都按项目根解析）
 *
 * 设计约定（很重要）：
 *  1. **默认 chunhe**，所以不改任何东西时行为与以前一致（651 个测试不用动）。
 *  2. **不做静默降级**：文件不存在 / 导出不全就抛错，并把可选项列出来。
 *     降级到别的人格最难查——用户以为换成功了，其实还在说别人的话。
 *  3. 人格模块的导出接口必须与 chunhe.js 一致（见 REQUIRED_EXPORTS）。
 *     写自己的角色时，最省事的办法是复制 chunhe.js 或 default.js 再改。
 *
 * 新写一个人格至少要有：CHUNHE_SYSTEM_PROMPT（历史名字，接口兼容用）、
 * buildSystemPrompt、createPersona、makeLocalGenerator、makeModelGenerator、
 * createProactiveComposer、composeReminderText。
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 内置人格：id → 文件（相对项目根目录） */
export const BUILTIN_PERSONAS = {
  chunhe: "src/persona/chunhe.js",
  default: "src/persona/default.js",
};

/** 运行时真正会用到的方法；缺一个就报错，而不是等某条消息路径崩掉 */
export const REQUIRED_EXPORTS = [
  "CHUNHE_SYSTEM_PROMPT",
  "buildSystemPrompt",
  "makeLocalGenerator",
  "makeModelGenerator",
  "createPersona",
  "createProactiveComposer",
  "composeReminderText",
];

/** 建议有、但允许省略的导出（引擎的部分功能会退化成通用话术） */
export const OPTIONAL_EXPORTS = [
  "STAY_SILENT_TOOL_NAME",
  "tryCompute",
  "replyToMedia",
  "describeCapabilitiesForModel",
  "describeHarassmentForModel",
  "PROACTIVE_PROMPT",
  "REMINDER_PROMPT",
];

const HERE = import.meta.dirname
  ? import.meta.dirname
  : path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

/** 项目根目录：src/persona → 上两级 */
export const PROJECT_ROOT = path.resolve(HERE, "..", "..");

/** 已加载的模块缓存：同一个文件只 import 一次（ESM 本身也缓存，这里省掉重复校验） */
const cache = new Map();

/** 当前生效的人格模块（供拿不到 config 的模块读取提示词，例如 remote-agent） */
let active = null;

/** 读取当前生效的人格模块；还没加载过时返回 null */
export function getActivePersona() {
  return active;
}

/**
 * 列出可用人格。
 * @param {{rootDir?: string}} [opts]
 * @returns {{id: string, file: string, builtin: boolean}[]}
 */
export function listPersonas({ rootDir = PROJECT_ROOT } = {}) {
  const out = Object.entries(BUILTIN_PERSONAS).map(([id, rel]) => ({
    id,
    file: path.resolve(rootDir, rel),
    builtin: true,
  }));
  // src/persona/ 下自己放的模块也算（PERSONA=my-bot 时不用带路径）
  const dir = path.resolve(rootDir, "src/persona");
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".js")) continue;
      if (["index.js", "naming.js"].includes(name)) continue;
      const id = name.slice(0, -3);
      if (out.some((p) => p.id === id)) continue;
      out.push({ id, file: path.join(dir, name), builtin: false });
    }
  } catch {
    /* 目录不存在就只列内置的 */
  }
  return out;
}

function describeAvailable({ rootDir }) {
  return listPersonas({ rootDir })
    .map((p) => {
      const tag = p.builtin ? "内置" : "自定义";
      return `  - ${p.id.padEnd(12)} ${tag}  ${path.relative(rootDir, p.file).replace(/\\/g, "/")}`;
    })
    .join("\n");
}

/**
 * 把 PERSONA 的值解析成绝对文件路径。
 *  - 内置 id：chunhe / default
 *  - 带路径：相对项目根目录（也接受绝对路径）
 *  - 裸名字：src/persona/<id>.js
 */
export function resolvePersonaFile(id, { rootDir = PROJECT_ROOT } = {}) {
  const raw = String(id ?? "").trim();
  const wanted = raw || "chunhe";
  const builtin = BUILTIN_PERSONAS[wanted];
  if (builtin) return path.resolve(rootDir, builtin);

  const looksLikePath = /[\\/]/.test(wanted) || wanted.endsWith(".js") || path.isAbsolute(wanted);
  const candidates = looksLikePath
    ? [path.isAbsolute(wanted) ? wanted : path.resolve(rootDir, wanted)]
    : [path.resolve(rootDir, "src/persona", `${wanted}.js`), path.resolve(rootDir, wanted)];

  for (const file of candidates) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

/**
 * 加载人格模块。
 *
 * @param {string} [id] 人格 id 或路径（缺省 chunhe）
 * @param {{rootDir?: string, logger?: {info?: Function, warn?: Function}}} [opts]
 * @returns {Promise<object>} 人格模块（导出接口同 chunhe.js）
 * @throws {Error} 人格不存在 / 导出不全
 */
export async function loadPersona(id, { rootDir = PROJECT_ROOT, logger } = {}) {
  const wanted = String(id ?? "").trim() || "chunhe";
  const file = resolvePersonaFile(wanted, { rootDir });
  if (!file) {
    const err = new Error(
      `找不到人格「${wanted}」。\n` +
        `可用的人格：\n${describeAvailable({ rootDir })}\n` +
        `用法：PERSONA=chunhe / PERSONA=default / PERSONA=./my-bot.js（相对项目根目录）`,
    );
    err.code = "PERSONA_NOT_FOUND";
    throw err;
  }

  const key = path.resolve(file);
  if (cache.has(key)) {
    active = cache.get(key);
    return active;
  }

  let mod;
  try {
    mod = await import(pathToFileURL(key).href);
  } catch (err) {
    const e = new Error(`人格模块加载失败：${key}\n原因：${err?.message ?? err}`);
    e.code = "PERSONA_IMPORT_FAILED";
    e.cause = err;
    throw e;
  }

  const missing = REQUIRED_EXPORTS.filter((name) => typeof mod[name] === "undefined");
  if (missing.length) {
    throw new Error(
      `人格模块「${key}」导出不全，缺少：${missing.join("、")}。\n` +
        `写自己的角色时，最省事的办法是复制 src/persona/default.js 再改。`,
    );
  }
  const missingOptional = OPTIONAL_EXPORTS.filter((name) => typeof mod[name] === "undefined");
  if (missingOptional.length) {
    logger?.warn?.(
      `人格「${path.basename(key)}」缺少可选导出：${missingOptional.join("、")}（相关功能会退化成通用话术）`,
    );
  }

  cache.set(key, mod);
  active = mod;
  logger?.info?.(`人格：${wanted}（${path.relative(rootDir, key).replace(/\\/g, "/")}）`);
  return mod;
}

/** 清空缓存（测试用） */
export function clearPersonaCache() {
  cache.clear();
  active = null;
}
