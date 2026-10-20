/**
 * 极简日志 + 密钥脱敏。
 *
 * 设计原则：日志里**永远不出现完整密钥**。任何写日志的字符串都会先过一遍
 * `redact()`，即使调用方不小心把 secret 拼进消息里也不会泄漏。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** 需要脱敏的键名（大小写不敏感匹配） */
const SECRET_KEYS = [
  "appsecret",
  "clientsecret",
  "secret",
  "access_token",
  "accesstoken",
  "token",
  "api_key",
  "apikey",
  "authorization",
  "password",
];

/** 形如 `secret=xxx` / `token: "xxx"` / `apikey='xxx'` 的明文赋值也要盖住 */
const ASSIGNMENT_RE = new RegExp(
  `\\b(${SECRET_KEYS.join("|")})\\s*[=:]\\s*("([^"]*)"|'([^']*)'|[A-Za-z0-9._\\-]{4,})`,
  "gi",
);

export function redact(input) {
  if (input === null || input === undefined) return input;
  if (typeof input !== "string") {
    if (typeof input === "object") {
      if (Array.isArray(input)) return input.map((v) => redact(v));
      const out = {};
      for (const [k, v] of Object.entries(input)) {
        if (SECRET_KEYS.includes(k.toLowerCase()) && typeof v === "string") {
          out[k] = mask(v);
        } else {
          out[k] = redact(v);
        }
      }
      return out;
    }
    return input;
  }
  return input
    .replace(/(QQBot\s+)[A-Za-z0-9._-]{6,}/g, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/g, "$1***")
    .replace(ASSIGNMENT_RE, (_m, name, _whole, dq, sq) => {
      const raw = dq ?? sq ?? _whole;
      return `${name}=${mask(raw)}`;
    });
}

/** 只留头尾各 2 位，中间打码 */
export function mask(value) {
  if (typeof value !== "string" || value.length === 0) return "***";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function createLogger(level = "info") {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const emit = (lvl, tag, args) => {
    if (LEVELS[lvl] < threshold) return;
    const stamp = new Date().toISOString().slice(11, 23);
    const safe = args.map((a) => (typeof a === "string" ? redact(a) : redact(a)));
    // eslint-disable-next-line no-console
    console[lvl === "debug" ? "log" : lvl](`[${stamp}] ${tag} ${safe.map(fmt).join(" ")}`);
  };

  return {
    debug: (...a) => emit("debug", "DBG", a),
    info: (...a) => emit("info", "INF", a),
    warn: (...a) => emit("warn", "WRN", a),
    error: (...a) => emit("error", "ERR", a),
  };
}

function fmt(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
