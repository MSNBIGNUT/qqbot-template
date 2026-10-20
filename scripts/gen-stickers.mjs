/**
 * gen-stickers.mjs — 批量生成春禾的新表情包。
 *
 * 用法：
 *   node scripts/gen-stickers.mjs                # 生成默认那批
 *   node scripts/gen-stickers.mjs 大笑 白眼      # 只生成指定的
 *
 * 流程：生图（include_self=true，带角色锚定 + 主立绘）→ 缩到 128×128 JPEG → 入库
 *
 * 为什么单独写一个脚本：表情包是**长期资产**，生成一次用很久；
 * 放进运行时反而会让她"随手画表情"，既慢又费钱。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { loadConfig, parseDotenv } from "../src/config.js";
import { generateImage } from "../src/media/imagegen.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const STICKER_DIR = path.join(ROOT, "assets", "stickers");

/** 要生成的表情：名字 → 画面描述（都基于「她」的立绘特征） */
const PRESETS = {
  大笑: "双手抱肚子笑到弯腰，眼睛弯成月牙，嘴巴张开大笑，眼角有笑出来的泪花，开心到不行",
  白眼: "翻着白眼往上看，嘴角向下撇，一副「你在说什么」的无语嫌弃表情",
  叹气: "微微垂头，闭着眼睛，轻轻叹气的样子，肩膀塌下来，有点无奈和疲惫",
  比耶: "开心地举起一只手比耶（V 字手势），歪着头笑，眼睛亮亮的",
  吃瓜: "捧着一块西瓜在吃，眼睛睁大好奇地看向镜头，一副看热闹的表情",
  摸头: "被人摸头顶时眯起眼睛，脸颊微微发红，头顶呆毛被摸得翘起来，有点享受又有点害羞",
  打哈欠: "张大嘴打哈欠，眼睛半闭，一只手捂着嘴，睡眼惺忪的样子",
  心碎: "双手捧在胸口，眼角含泪，一副委屈要哭的表情，嘴唇微微发抖",

  // ── 手势类（2026-10-19 主人要求：「表情可以增加手势的，增加表现力」）──
  挥手: "抬起一只手到脸旁，手掌张开轻轻挥动打招呼，笑着眯起眼睛，动作活泼",
  鼓掌: "双手在胸前合掌鼓掌，开心地眯着眼笑，一副为你鼓掌叫好的样子",
  点赞: "伸出一只手竖起大拇指，歪头自信地笑，眼睛亮亮的，一副「你真行」的赞许表情",
  抱抱: "张开双臂做出要抱抱的姿势，身体微微前倾，笑得眼睛弯成月牙，可爱亲切",
  叉腰: "双手叉腰，鼓起脸颊，眉毛皱起来，一副生气又有点可爱的样子",
  捂脸: "双手捂住脸颊，只露出含着害羞笑意的眼睛，耳根发红，非常害羞的样子",
  敬礼: "抬起右手到额头旁做一个俏皮的敬礼手势，站直身体，表情认真又带点得意",
  拜拜: "举起一只手左右摇摆说再见，另一只手轻轻放在身侧，笑着眨眼，动作轻快",
};

/** 表情包统一加的画面后缀：只画脸和上半身，适合做成小图 */
const STICKER_SUFFIX =
  "；构图：上半身入镜、正面朝向观众，做手势时**手部动作要完整清晰可见不要被裁掉**，" +
  "背景纯净浅色，画面元素简洁，适合做聊天表情包";

function loadEnv() {
  const env = parseDotenv(fs.readFileSync(path.join(ROOT, ".env"), "utf8"));
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
}

/** 用 PIL 缩到 128×128 并转 JPEG */
async function resizeToSticker(inputPng, outputJpg) {
  const { execFileSync } = await import("node:child_process");
  const py = process.env.PYTHON || "python";
  const code = `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
im = im.resize((128, 128), Image.LANCZOS)
im.save(sys.argv[2], "JPEG", quality=88, optimize=True)
print("ok")
`;
  const tmp = path.join(ROOT, "_resize_tmp.py");
  fs.writeFileSync(tmp, code, "utf8");
  try {
    execFileSync(py, [tmp, inputPng, outputJpg], { stdio: "pipe" });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function main() {
  loadEnv();
  const cfg = loadConfig();
  const ig = cfg.imageGen;
  if (!ig?.enabled || !ig.apiKey) {
    console.error("画图没配好（ARK_API_KEY），无法生成表情包");
    process.exit(2);
  }

  const wanted = process.argv.slice(2).filter(Boolean);
  const names = wanted.length ? wanted : Object.keys(PRESETS);
  const unknown = names.filter((n) => !PRESETS[n]);
  if (unknown.length) {
    console.error(`不认识的预设：${unknown.join("、")}\n可用：${Object.keys(PRESETS).join("、")}`);
    process.exit(2);
  }

  fs.mkdirSync(STICKER_DIR, { recursive: true });
  fs.mkdirSync(path.join(STICKER_DIR, "_raw"), { recursive: true });

  let ok = 0;
  let fail = 0;
  for (const name of names) {
    const target = path.join(STICKER_DIR, `春禾-${name}.jpg`);
    if (fs.existsSync(target)) {
      console.log(`  跳过（已存在）：春禾-${name}.jpg`);
      continue;
    }
    const prompt = PRESETS[name] + STICKER_SUFFIX;
    console.log(`  生成中：春禾-${name} …`);
    const t0 = Date.now();
    const res = await generateImage(prompt, ig, {
      includeSelf: true,
      logger: {
        info: (m) => console.log(`    · ${m}`),
        warn: (m) => console.log(`    ⚠ ${m}`),
      },
    });
    if (!res.ok || !res.images?.length) {
      fail += 1;
      console.log(`  ✗ 失败：${name} —— ${String(res.reason).slice(0, 80)}`);
      continue;
    }
    const img = res.images[0];
    const rawPath = path.join(STICKER_DIR, "_raw", `春禾-${name}.png`);
    fs.writeFileSync(rawPath, Buffer.from(img.base64, "base64"));
    try {
      await resizeToSticker(rawPath, target);
      const size = fs.statSync(target).size;
      ok += 1;
      console.log(`  ✓ 完成：春禾-${name}.jpg（${Math.round(size / 1024)}KB，用时 ${Date.now() - t0}ms）`);
    } catch (err) {
      fail += 1;
      console.log(`  ✗ 缩图失败：${name} —— ${err?.message ?? err}`);
    }
  }

  console.log(`\n  完成：成功 ${ok}，失败 ${fail}`);
  console.log(`  目录：${STICKER_DIR}`);
}

await main();
