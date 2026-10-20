/**
 * 名字登记表 —— 让她分得清「谁是谁」。
 *
 * 背景（2026-10-19 主人要求）：
 *   「建议她能看到具体群成员具体名称，和具体群名称，不然容易认错人。」
 *
 * 平台现实（已实测）：
 *   · QQ 群消息的 author 里**没有 username**（`senderName` 恒为 undefined）；
 *   · 群成员列表接口返回 11253「应用无接口访问权限」；
 *   · 群消息事件里**没有群名**。
 *   所以**平台不会告诉我们名字**，只能靠"学"。
 *
 * 学习来源：
 *   1. 主人教：「这个群叫大群」「跟你说话这个叫丙某」
 *   2. 自我介绍：群里有人说「我是丙某」→ 把这句话的发送者绑上「丙某」
 *   3. @ 提及：mention 列表里的 名字↔openid 映射
 *
 * 用途：
 *   · 群聊上下文缓冲里的说话人标签（`#watchGroup`）
 *   · 注入给模型的「你认识的人/群」清单
 *
 * 存盘：`data/names.json`（很小，直接同步写）。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_FILE = "data/names.json";

/** 名字清洗：去掉 @ 前缀、表情、过长内容 */
export function sanitizeName(raw) {
  let s = String(raw ?? "").trim();
  s = s.replace(/^[@＠<]+/, "").replace(/[>\s]+$/, "");
  s = s.replace(/[「」“”"'《》【】()（）]/g, "");
  s = s.replace(/[^\p{L}\p{N}_\-·]/gu, "");
  s = s.trim();
  if (!s) return "";
  return Array.from(s).slice(0, 16).join("");
}

export class NameRegistry {
  /**
   * @param {{file?: string, logger?: object, now?: () => number}} [opts]
   */
  constructor({ file = DEFAULT_FILE, logger = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.logger = logger;
    this.now = now;
    /** openid → 名字 */
    this.members = new Map();
    /** groupOpenid → 群名 */
    this.groups = new Map();
    this.loaded = false;
    this.#loadSync();
  }

  #loadSync() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const data = JSON.parse(raw);
      for (const [k, v] of Object.entries(data?.members ?? {})) {
        const n = sanitizeName(v);
        if (k && n) this.members.set(String(k), n);
      }
      for (const [k, v] of Object.entries(data?.groups ?? {})) {
        const n = sanitizeName(v);
        if (k && n) this.groups.set(String(k), n);
      }
      this.loaded = true;
    } catch {
      /* 首次运行没有文件，正常 */
    }
  }

  async flush() {
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const data = {
        version: 1,
        savedAt: new Date(this.now()).toISOString(),
        members: Object.fromEntries(this.members),
        groups: Object.fromEntries(this.groups),
      };
      await fsp.writeFile(this.file, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger?.warn?.(`名字表写入失败：${err?.message ?? err}`);
    }
  }

  /** 记一个人名；返回是否是新学到的 */
  learnMember(openid, name) {
    const id = String(openid ?? "").trim();
    const n = sanitizeName(name);
    if (!id || !n) return false;
    if (this.members.get(id) === n) return false;
    this.members.set(id, n);
    this.logger?.info?.(`记住名字：${n}（尾号 ${id.slice(-4)}）`);
    void this.flush();
    return true;
  }

  /** 记一个群名 */
  learnGroup(groupOpenid, name) {
    const id = String(groupOpenid ?? "").trim();
    const n = sanitizeName(name);
    if (!id || !n) return false;
    if (this.groups.get(id) === n) return false;
    this.groups.set(id, n);
    this.logger?.info?.(`记住群名：${n}（${id.slice(0, 6)}…）`);
    void this.flush();
    return true;
  }

  /** 某人的显示名：学到过就用名字，否则「群友XXXX」 */
  labelFor(openid) {
    const id = String(openid ?? "").trim();
    const n = this.members.get(id);
    if (n) return n;
    return `群友${id.slice(-4) || "??"}`;
  }

  /** 某群的显示名 */
  labelForGroup(groupOpenid) {
    const id = String(groupOpenid ?? "").trim();
    return this.groups.get(id) || `${id.slice(0, 6)}…`;
  }

  hasMember(openid) {
    return this.members.has(String(openid ?? "").trim());
  }

  /** 给模型看的清单（只列学到的，避免噪音） */
  describe() {
    const lines = [];
    if (this.groups.size) {
      lines.push("【你认识的群】");
      for (const [gid, name] of this.groups) lines.push(`- 「${name}」（${gid.slice(0, 6)}…）`);
    }
    if (this.members.size) {
      lines.push("【你认识的人】");
      for (const [uid, name] of this.members) lines.push(`- ${name}（尾号 ${uid.slice(-4)}）`);
    }
    if (!lines.length) return "";
    return [
      ...lines,
      "（名字是系统记住的；**没学到名字的人会显示成「群友XXXX」**，那种情况不要瞎猜是谁。）",
    ].join("\n");
  }
}

/**
 * 从一句话里识别「自我介绍」。
 * 例：「我是丙某」「我叫丙某」「叫我丙某就行」→ "丙某"
 */
export function detectSelfIntro(text) {
  const s = String(text ?? "").trim();
  if (!s || s.length > 30) return "";
  const m =
    /(?:^|[，,。！!？?\s])(?:我(?:就)?是|我叫|叫我|我的名字(?:是|叫))\s*([^\s，,。！!？?]{1,12})/.exec(s);
  if (!m) return "";
  const n = sanitizeName(m[1]);
  // 过滤明显不是名字的（「我是说」「我是你」这类）
  if (!n || /^(?:说|问|你|他|她|它|谁|什么|怎么|个|的)/.test(n)) return "";
  // 去掉口语尾巴：「叫我丙某就行」→ 丙某
  return n.replace(/(?:就行|就好|好了|吧|啦|呀|哦|哈)+$/, "") || n;
}

/**
 * 从主人的话里识别「给谁起名/给群起名」。
 * 例：
 *   「跟你说话这个叫丙某」→ { kind: "member-current", name: "丙某" }
 *   「这个群叫大群」      → { kind: "group-current", name: "大群" }
 *   「刚才那个叫丙某」    → { kind: "member-current", name: "丙某" }
 */
export function detectNamingIntent(text) {
  const s = String(text ?? "").trim();
  if (!s || s.length > 60) return null;
  const groupM =
    /(?:这个|这|本|当前)(?:个)?群(?:聊)?\s*(?:就)?(?:叫|名字叫|名称是|改名叫)\s*([^\s，,。！!？?]{1,16})/.exec(s);
  if (groupM) {
    const name = sanitizeName(groupM[1]);
    if (name) return { kind: "group-current", name };
  }
  const memberM =
    /(?:(?:跟|和|对)你?说话(?:的)?(?:这|那)(?:个|位|人)|刚才(?:那个|那位|说话那个)|这(?:个|位))?\s*(?:就)?(?:叫|名字叫|名叫)\s*([^\s，,。！!？?]{1,16})/.exec(
      s,
    );
  if (memberM && /说话|这个|这位|刚才/.test(s)) {
    const name = sanitizeName(memberM[1]);
    if (name) return { kind: "member-current", name };
  }
  return null;
}
