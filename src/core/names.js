/**
 * 名字登记表 —— 让她分得清「谁是谁」。
 *
 * ⚠️ 2026-10-20 重要更正：
 *   这里原来写着「QQ 群消息的 author 里**没有 username**」——
 *   **那是错的**。实测（33 条群消息样本）：
 *     · `author.username` **有时确实存在**（9/33），群主那条是 `"username":"闲人"`；
 *     · `author.id` 与 `author.member_openid` **完全相同**（33/33）；
 *     · `author.union_openid` **恒为空**（0/33）→ 平台不给全局 id；
 *     · 群消息事件里**仍然没有群名**，群成员列表接口仍是 11253 无权限。
 *   所以：名字**能学到**，只是平台时给时不给 —— 学到一次就要永久记住。
 *
 * 学习来源（按可靠度从高到低）：
 *   1. `author.username` —— 平台直接给的昵称，最准
 *   2. 主人教：「这个群叫大群」「跟你说话这个叫随缘」
 *   3. 自我介绍：群里有人说「我是随缘」→ 把这句话的发送者绑上「随缘」
 *   4. 历史记忆：老版本 `members` 里的记录（加载时自动迁移）
 *
 * 存的数据结构（v2）：
 *   people[openid] = { name, groups: { [gid]: { count, lastSeen } }, aliases: [], count, lastSeen }
 *   groups[gid]    = { name?, count, lastActive }
 *
 *   为什么要 group 维度的记录：
 *     QQ 的 `member_openid` **是群内唯一的**，同一个人在不同群里可能是两个不同的
 *     openid（`union_openid` 又不给）。所以一个人可能对应多个 openid —— 我们用
 *     "同名不同 openid" 把它们记成 `aliases`，这样她被问到"随缘在哪个群"时能说清。
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
  s = s.replace(/^[@＠<]+/, "").replace(/[>\s]+$/g, "");
  s = s.replace(/[「」“”"'《》【】()（）]/g, "");
  s = s.replace(/[^\p{L}\p{N}_\-·]/gu, "");
  s = s.trim();
  if (!s) return "";
  return Array.from(s).slice(0, 16).join("");
}

/**
 * 这是不是"没名字时的占位符"？（`群友008F93`、`群友E2`、`用户1A2B` 这类）
 * 这类字符串绝不能当名字存 —— 存了就再也认不出真名了。
 */
export function isPlaceholderName(name) {
  const s = String(name ?? "").trim();
  if (!s) return true;
  return /^(?:群友|用户|成员|某人|陌生人)[0-9A-Fa-f]{2,8}$/.test(s);
}

/** 尾号：没有名字时的兜底标识 */
function tailOf(openid) {
  const id = String(openid ?? "").trim();
  return id.slice(-4) || "??";
}

export class NameRegistry {
  /**
   * @param {{file?: string, logger?: object, now?: () => number}} [opts]
   */
  constructor({ file = DEFAULT_FILE, logger = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.logger = logger;
    this.now = now;

    /** openid → { name, groups: Map<gid,{count,lastSeen}>, aliases:Set<openid>, count, lastSeen } */
    this.people = new Map();
    /** gid → { name, count, lastActive } */
    this.groups = new Map();

    this.loaded = false;
    this.#loadSync();
  }

  // ── 兼容层：老代码/测试还在用 members / 只读 sections ────────────
  /** @deprecated 用 people；保留是为了不破坏已有调用 */
  get members() {
    const m = new Map();
    for (const [id, p] of this.people) if (p.name) m.set(id, p.name);
    return m;
  }

  #loadSync() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const data = JSON.parse(raw);

      // ── v2 ──
      for (const [id, p] of Object.entries(data?.people ?? {})) {
        const key = String(id ?? "").trim();
        if (!key) continue;
        const rec = {
          name: sanitizeName(p?.name),
          groups: new Map(),
          aliases: new Set(Array.isArray(p?.aliases) ? p.aliases.map(String) : []),
          count: Number(p?.count) || 0,
          lastSeen: Number(p?.lastSeen) || 0,
        };
        for (const [gid, g] of Object.entries(p?.groups ?? {})) {
          rec.groups.set(String(gid), {
            count: Number(g?.count) || 0,
            lastSeen: Number(g?.lastSeen) || 0,
          });
        }
        this.people.set(key, rec);
      }
      for (const [gid, g] of Object.entries(data?.groups ?? {})) {
        const key = String(gid ?? "").trim();
        if (!key) continue;
        this.groups.set(key, {
          name: sanitizeName(g?.name),
          count: Number(g?.count) || 0,
          lastActive: Number(g?.lastActive) || 0,
        });
      }

      // ── v1 迁移：老文件是 { members: {openid: name}, groups: {gid: name} } ──
      if (!data?.people && data?.members) {
        for (const [k, v] of Object.entries(data.members)) {
          const n = sanitizeName(v);
          if (!k || !n) continue;
          this.people.set(String(k), {
            name: n,
            groups: new Map(),
            aliases: new Set(),
            count: 0,
            lastSeen: 0,
          });
        }
        for (const [k, v] of Object.entries(data.groups ?? {})) {
          const n = sanitizeName(v);
          if (!k || !n) continue;
          this.groups.set(String(k), { name: n, count: 0, lastActive: 0 });
        }
        this.logger?.info?.("名字表已从 v1 迁移到 v2（补上群维度和活跃度）");
        void this.flush();
      }

      this.loaded = true;
    } catch {
      /* 首次运行没有文件，正常 */
    }
  }

  async flush() {
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const people = {};
      for (const [id, p] of this.people) {
        people[id] = {
          name: p.name || "",
          aliases: [...p.aliases],
          count: p.count,
          lastSeen: p.lastSeen,
          groups: Object.fromEntries(p.groups),
        };
      }
      const groups = {};
      for (const [gid, g] of this.groups) {
        groups[gid] = { name: g.name || "", count: g.count, lastActive: g.lastActive };
      }
      const data = {
        version: 2,
        savedAt: new Date(this.now()).toISOString(),
        people,
        groups,
      };
      await fsp.writeFile(this.file, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger?.warn?.(`名字表写入失败：${err?.message ?? err}`);
    }
  }

  #ensurePerson(openid) {
    const id = String(openid ?? "").trim();
    if (!id) return null;
    let p = this.people.get(id);
    if (!p) {
      p = { name: "", groups: new Map(), aliases: new Set(), count: 0, lastSeen: 0 };
      this.people.set(id, p);
    }
    return p;
  }

  /**
   * 记一个人名。
   * @param {string} openid
   * @param {string} name
   * @param {{groupOpenid?: string}} [opts]
   * @returns {boolean} 是否新学到
   */
  learnMember(openid, name, opts = {}) {
    const id = String(openid ?? "").trim();
    const n = sanitizeName(name);
    if (!id || !n) return false;

    // ⚠️ 2026-10-20：**不许把兜底标签当真名学进去**。
    //   真机：老版本把 `群友008F93` 这种"没名字时的占位符"存进了名字表，
    //   之后 labelFor 返回的还是它 —— 等于永久固化成一个假名字。
    //   这条判断放在 learnMember 里，任何来源（username/自我介绍/提及）都过一遍。
    if (isPlaceholderName(n)) return false;

    const p = this.#ensurePerson(id);
    const gid = String(opts.groupOpenid ?? "").trim();
    if (gid) {
      const g = p.groups.get(gid) ?? { count: 0, lastSeen: 0 };
      g.lastSeen = this.now();
      p.groups.set(gid, g);
    }

    if (p.name === n) return false;

    // 跨群同人：同名的其他 openid 记成 alias，方便她回答"这个人我在哪见过"
    for (const [otherId, other] of this.people) {
      if (otherId === id) continue;
      if (other.name !== n) continue;
      p.aliases.add(otherId);
      other.aliases.add(id);
    }

    p.name = n;
    p.lastSeen = this.now();
    this.logger?.info?.(`记住名字：${n}（尾号 ${tailOf(id)}）`);
    void this.flush();
    return true;
  }

  /**
   * 记一次发言（只为活跃度统计，不学名字）。
   * 用来给"没名字的群"生成有意义的兜底标签。
   */
  touchMember(openid, opts = {}) {
    const p = this.#ensurePerson(openid);
    if (!p) return;
    p.count += 1;
    p.lastSeen = this.now();
    const gid = String(opts.groupOpenid ?? "").trim();
    if (!gid) return;
    p.groups.set(gid, { count: (p.groups.get(gid)?.count ?? 0) + 1, lastSeen: this.now() });
  }

  /** 记一个群名 */
  learnGroup(groupOpenid, name) {
    const id = String(groupOpenid ?? "").trim();
    const n = sanitizeName(name);
    if (!id || !n) return false;
    const g = this.groups.get(id) ?? { name: "", count: 0, lastActive: 0 };
    if (g.name === n) return false;
    g.name = n;
    this.groups.set(id, g);
    this.logger?.info?.(`记住群名：${n}（${id.slice(0, 6)}…）`);
    void this.flush();
    return true;
  }

  /** 记一次群活跃 */
  touchGroup(groupOpenid) {
    const id = String(groupOpenid ?? "").trim();
    if (!id) return;
    const g = this.groups.get(id) ?? { name: "", count: 0, lastActive: 0 };
    g.count += 1;
    g.lastActive = this.now();
    this.groups.set(id, g);
  }

  /** 某人的显示名：学到过就用名字，否则「群友XXXX」 */
  labelFor(openid) {
    const id = String(openid ?? "").trim();
    const n = this.people.get(id)?.name;
    if (n) return n;
    return `群友${tailOf(id)}`;
  }

  /**
   * 某群的显示名。
   *
   * 三等：
   *   ① 学到过名字 → 直接用
   *   ② 没名字，但认识里面的人 → 「含 甲、乙 的群」（比一串十六进制好认一万倍）
   *   ③ 连人都不认识 → 「群 2E3F…」+ 尾号
   */
  labelForGroup(groupOpenid) {
    const id = String(groupOpenid ?? "").trim();
    if (!id) return "某个群";
    const named = this.groups.get(id)?.name;
    if (named) return named;

    // 按群内发言次数挑 2 个最活跃的、并且**有名字**的人
    const known = [];
    for (const [, p] of this.people) {
      if (!p.name) continue;
      const g = p.groups.get(id);
      if (!g) continue;
      known.push({ name: p.name, count: g.count });
    }
    if (known.length) {
      known.sort((a, b) => b.count - a.count);
      const names = known.slice(0, 2).map((x) => x.name).join("、");
      return `${names} 在的群`;
    }
    return `群 ${id.slice(0, 4)}…`;
  }

  hasMember(openid) {
    const p = this.people.get(String(openid ?? "").trim());
    return Boolean(p?.name);
  }

  /** 反查：名字 → openid 列表（含 alias） */
  resolveByName(name) {
    const n = sanitizeName(name);
    if (!n) return [];
    const out = [];
    for (const [id, p] of this.people) if (p.name === n) out.push(id);
    return out;
  }

  /**
   * 这个人在哪些群出现过。
   *
   * ⚠️ 只用**起过名**的群名；没起名的群用短 id —— 否则会自指，
   *    出现「闲人 在的群」这种把听众自己也塞进去的怪标签。
   */
  groupsOf(openid) {
    const p = this.people.get(String(openid ?? "").trim());
    if (!p) return [];
    return [...p.groups.keys()].map((gid) => this.groups.get(gid)?.name || `群${gid.slice(0, 4)}`);
  }

  /** 给模型看的清单（只列学到的，避免噪音） */
  describe() {
    const lines = [];
    if (this.groups.size) {
      lines.push("【你认识的群】");
      for (const [gid, g] of this.groups) {
        const label = this.labelForGroup(gid);
        const named = g.name ? "" : "（还没起名，这是按里面的人推出来的）";
        lines.push(`- 「${label}」${named}`);
      }
    }
    const named = [...this.people.entries()].filter(([, p]) => p.name);
    if (named.length) {
      lines.push("【你认识的人】");
      // 同名可能对应多个 openid（QQ 的 member_openid 是群内唯一的）→ 合并成一行，
      // 免得模型看到两个「阿杰」以为是两个人。
      const byName = new Map();
      for (const [uid, p] of named) {
        if (!byName.has(p.name)) byName.set(p.name, []);
        byName.get(p.name).push(uid);
      }
      for (const [name, ids] of byName) {
        const tails = ids.map((id) => tailOf(id)).join(" / ");
        const gs = [...new Set(ids.flatMap((id) => this.groupsOf(id)))];
        const where = gs.length ? ` · 在「${gs.join("」「")}」` : "";
        const multi = ids.length > 1 ? "（同一个人，几个群里的 openid 不同）" : "";
        lines.push(`- ${name}（尾号 ${tails}）${where}${multi}`);
      }
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
 * 例：「我是随缘」「我叫随缘」「叫我随缘就行」→ "随缘"
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
  // 去掉口语尾巴：「叫我随缘就行」→ 随缘
  return n.replace(/(?:就行|就好|好了|吧|啦|呀|哦|哈)+$/, "") || n;
}

/**
 * 从主人的话里识别「给谁起名/给群起名」。
 * 例：
 *   「跟你说话这个叫随缘」→ { kind: "member-current", name: "随缘" }
 *   「这个群叫大群」      → { kind: "group-current", name: "大群" }
 *   「刚才那个叫随缘」    → { kind: "member-current", name: "随缘" }
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
