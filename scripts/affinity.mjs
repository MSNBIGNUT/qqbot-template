#!/usr/bin/env node
/**
 * affinity.mjs — 查看 / 设置某个人的好感度。
 *
 * 用法：
 *   node scripts/affinity.mjs list
 *   node scripts/affinity.mjs get 随缘
 *   node scripts/affinity.mjs set 随缘 5
 *   node scripts/affinity.mjs set 4FBE3CD8937FE5E2855DEC5A80A9817A -3
 *   node scripts/affinity.mjs reset 随缘          （清零，不是删除）
 *   node scripts/affinity.mjs del 随缘            （彻底删掉这条记录）
 *
 * 名字可以写 `data/names.json` 里登记过的昵称，也可以直接写 openid。
 *
 * 说明：
 *   · **主人不参与好感度**（恒定最高），设置会被忽略并提示。
 *   · 设置是**绝对值**，不是增量 —— 说 5 就是 5 分。
 *   · 区间 [-20, +20]。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const AFF_FILE = path.join(ROOT, "data", "affinity.json");
const NAMES_FILE = path.join(ROOT, "data", "names.json");
const ENV_FILE = path.join(ROOT, ".env");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readEnvOwnerIds() {
  try {
    const text = fs.readFileSync(ENV_FILE, "utf8");
    const ids = new Set();
    for (const line of text.split(/\r?\n/)) {
      const m = /^(?:QQ_ADMIN_USERS|QQ_OWNER_USERS)\s*=\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      for (const id of m[1].split(/[,，\s]+/)) if (id) ids.add(id.trim());
    }
    return ids;
  } catch {
    return new Set();
  }
}

function loadState() {
  const data = readJson(AFF_FILE, { version: 1, people: {} });
  if (!data.people || typeof data.people !== "object") data.people = {};
  return data;
}

function saveState(data) {
  fs.mkdirSync(path.dirname(AFF_FILE), { recursive: true });
  data.savedAt = new Date().toISOString();
  fs.writeFileSync(AFF_FILE, JSON.stringify(data, null, 2));
}

function members() {
  const n = readJson(NAMES_FILE, { members: {} });
  return n?.members && typeof n.members === "object" ? n.members : {};
}

/** 名字或 openid → openid */
function resolveId(input) {
  const q = String(input ?? "").trim();
  if (!q) return { id: "", hit: false };
  const map = members();
  if (map[q]) return { id: q, hit: true, name: map[q] }; // 直接给的是 openid
  for (const [id, name] of Object.entries(map)) {
    if (name === q) return { id, hit: true, name };
  }
  for (const [id, name] of Object.entries(map)) {
    if (String(name).includes(q)) return { id, hit: true, name };
  }
  return { id: q, hit: false }; // 当作 openid 处理
}

function tierLabel(score) {
  if (score >= 6) return "亲近";
  if (score >= 2) return "友好";
  if (score >= -2) return "中性";
  if (score >= -6) return "冷淡";
  return "敌意";
}

function cmdList() {
  const data = loadState();
  const map = members();
  const rows = Object.entries(data.people ?? {});
  if (!rows.length) {
    console.log("（还没有任何好感度记录 —— 大家都是从 0 分开始）");
    return;
  }
  rows.sort((a, b) => (b[1]?.score ?? 0) - (a[1]?.score ?? 0));
  console.log("openid 尾号  名字        分数  档位    最近原因");
  console.log("─".repeat(72));
  for (const [id, v] of rows) {
    const name = map[id] || "（未登记）";
    const score = Number(v?.score) || 0;
    const last = (v?.reasons ?? []).at(-1) ?? "";
    console.log(
      `${id.slice(-8).padEnd(11)} ${String(name).padEnd(11)} ${String(score).padStart(4)}  ${tierLabel(score).padEnd(6)} ${last}`,
    );
  }
}

function cmdGet(input) {
  const { id, name } = resolveId(input);
  const data = loadState();
  const v = data.people?.[id];
  const score = Number(v?.score) || 0;
  console.log(`  ${name || "（未登记）"}  ${id}`);
  console.log(`  好感度: ${score} 分（${tierLabel(score)}）`);
  if (v?.reasons?.length) {
    console.log("  最近原因:");
    for (const r of v.reasons) console.log(`    · ${r}`);
  }
}

function cmdSet(input, value) {
  const { id, name } = resolveId(input);
  if (!id) {
    console.error("用法: node scripts/affinity.mjs set <名字或openid> <分数>");
    process.exit(2);
  }
  const score = Number(value);
  if (!Number.isFinite(score)) {
    console.error(`分数必须是数字，收到：${value}`);
    process.exit(2);
  }
  const owners = readEnvOwnerIds();
  if (owners.has(id)) {
    console.log(`「${name || id}」是主人 —— 主人恒定最高，不参与好感度设置。`);
    return;
  }
  const clamped = Math.max(-20, Math.min(20, Math.round(score)));
  const data = loadState();
  const cur = data.people[id] ?? { reasons: [], updatedAt: 0 };
  data.people[id] = {
    score: clamped,
    reasons: [...(cur.reasons ?? []), `=${clamped} 手动设置`].slice(-5),
    updatedAt: Date.now(),
  };
  saveState(data);
  console.log(`✅ 「${name || id}」的好感度设为 ${clamped} 分（${tierLabel(clamped)}）`);
  if (clamped !== Math.round(score)) console.log(`   （原值 ${score} 超出 [-20,+20]，已截断）`);
}

function cmdReset(input) {
  cmdSet(input, 0);
}

function cmdDel(input) {
  const { id, name } = resolveId(input);
  const data = loadState();
  if (!data.people?.[id]) {
    console.log("（没有这条记录）");
    return;
  }
  delete data.people[id];
  saveState(data);
  console.log(`✅ 已删除「${name || id}」的好感度记录（下次从默认值开始）`);
}

const [, , cmd, a1, a2] = process.argv;
switch (cmd) {
  case "list":
  case undefined:
    cmdList();
    break;
  case "get":
    if (!a1) {
      console.error("用法: node scripts/affinity.mjs get <名字或openid>");
      process.exit(2);
    }
    cmdGet(a1);
    break;
  case "set":
    cmdSet(a1, a2);
    break;
  case "reset":
    cmdReset(a1);
    break;
  case "del":
    cmdDel(a1);
    break;
  default:
    console.log(`未知命令：${cmd}

用法:
  node scripts/affinity.mjs list
  node scripts/affinity.mjs get <名字或openid>
  node scripts/affinity.mjs set <名字或openid> <分数>
  node scripts/affinity.mjs reset <名字或openid>
  node scripts/affinity.mjs del <名字或openid>`);
    process.exit(2);
}
