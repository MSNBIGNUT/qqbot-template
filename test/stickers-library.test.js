/**
 * 表情包**真实素材库**的契约测试（与 stickers.test.js 的离线打桩互补）。
 *
 * stickers.test.js 证明「逻辑对」；这里证明「真素材真的能用」：
 * 新加的表情包必须被扫进 enum、文件名别名能解析、文件头能读出尺寸、
 * 扩展名与真实格式一致、大小不超上限。
 *
 * 素材目录在 .gitignore 里（assets/），换一台机器可能没有素材；
 * 这种情况下整组 skip，而不是把「没素材」误报成「代码坏了」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  DEFAULT_STICKER_MAX_BYTES,
  STICKER_EXTENSIONS,
  STICKER_SUGGESTED_PX,
  STICKER_TOOL_NAME,
  PROJECT_ROOT,
  resolveStickerConfig,
  listStickers,
  stickerNamesOf,
  buildStickerTool,
  executeStickerCall,
  readImageSize,
} from "../src/media/stickers.js";
import { makeModelGenerator } from "../src/persona/chunhe.js";

/** 本批新增的「春禾自己的」表情包（文件名去掉扩展名） */
const NEW_STICKER_FILES = [
  "春禾-开心",
  "春禾-卖萌,春禾-撒娇",
  "春禾-害羞",
  "春禾-生气",
  "春禾-委屈哭哭",
  "春禾-无语",
  "春禾-震惊",
  "春禾-得意",
  "春禾-疑问",
  "春禾-困了",
  "春禾-加油",
  "春禾-谢谢",
  "春禾-抱歉",
  "春禾-比心",
  "春禾-星星眼",
];

const DIR = path.join(PROJECT_ROOT, "assets", "stickers");

// 模板仓库只保留 assets/stickers 目录结构（.jpg 素材是私人角色资产，不随仓库分发），
// 所以「目录存在但是空的」和「目录不存在」都按没有素材处理：整组 skip。
// 放进你自己的表情包后，把 NEW_STICKER_FILES 换成你的文件名即可复用这组契约测试。
let stickerFiles = [];
try {
  stickerFiles = (await fsp.readdir(DIR)).filter((f) =>
    STICKER_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)),
  );
} catch {
  stickerFiles = [];
}

const skip = stickerFiles.length ? false : "本机没有 assets/stickers 素材（模板仓库不含素材）";

async function readSticker(file) {
  return fsp.readFile(path.join(DIR, file));
}

/** 真实文件的扩展名 → 期望的 readImageSize.format */
function expectedFormat(ext) {
  if (ext === ".png") return "png";
  if (ext === ".gif") return "gif";
  return "jpeg"; // .jpg / .jpeg
}

test("真实素材库：本批新增表情包全部被 listStickers 列出", { skip }, async () => {
  const cfg = resolveStickerConfig({});
  const stickers = await listStickers(cfg);
  const names = new Set(stickers.map((s) => s.name));
  for (const file of NEW_STICKER_FILES) {
    for (const name of stickerNamesOf(`${file}.jpg`)) {
      assert.ok(names.has(name), `listStickers 里找不到「${name}」（${file}.jpg）`);
    }
  }

  // 数量对账：带「春禾-」前缀的素材文件**至少**是本批那 15 个。
  // ⚠️ 2026-10-19：主人要求扩充表情库，用 scripts/gen-stickers.mjs 又生成了 8 张；
  //    这里改成"下限"断言 —— 校验的是"本批素材还在、都能被列出"，
  //    而不是"文件总数永远等于 15"（那会让正常扩容变成测试失败）。
  const files = new Set(stickers.filter((s) => s.file.startsWith("春禾-")).map((s) => s.file));
  assert.ok(
    files.size >= NEW_STICKER_FILES.length,
    `「春禾-」前缀素材至少应有 ${NEW_STICKER_FILES.length} 个文件，实际 ${files.size} 个`,
  );
});

test("真实素材库：文件名解析支持中文、逗号别名与「春禾-」前缀", { skip }, () => {
  assert.deepEqual(stickerNamesOf("春禾-开心.jpg"), ["春禾-开心"]);
  assert.deepEqual(stickerNamesOf("春禾-卖萌,春禾-撒娇.jpg"), ["春禾-卖萌", "春禾-撒娇"]);
  assert.deepEqual(stickerNamesOf("春禾-委屈哭哭.png"), ["春禾-委屈哭哭"]);
});

test("真实素材库：每张新图都能被 readImageSize 读出尺寸，且格式与扩展名一致", { skip }, async () => {
  for (const file of NEW_STICKER_FILES) {
    const filename = `${file}.jpg`;
    const buf = await readSticker(filename);
    assert.ok(buf.length > 0, `${filename} 是空文件`);
    const size = readImageSize(buf);
    assert.ok(size, `${filename} 读不出尺寸（文件头损坏或不是图片）`);
    assert.equal(size.format, expectedFormat(".jpg"), `${filename} 真实格式不是 JPEG`);
    assert.equal(size.width, size.height, `${filename} 不是正方形（${size.width}×${size.height}）`);
    assert.equal(
      Math.max(size.width, size.height),
      STICKER_SUGGESTED_PX,
      `${filename} 应缩到 ${STICKER_SUGGESTED_PX}px（实际 ${size.width}×${size.height}）`,
    );
    assert.ok(
      buf.length <= DEFAULT_STICKER_MAX_BYTES,
      `${filename} 超过单张上限 ${DEFAULT_STICKER_MAX_BYTES} 字节`,
    );
  }
});

test("真实素材库：整个库的扩展名受支持、格式对得上、名字不重复、大小不超限", { skip }, async () => {
  const cfg = resolveStickerConfig({});
  const stickers = await listStickers(cfg);
  assert.ok(stickers.length > 0, "素材库不该是空的");

  const names = stickers.map((s) => s.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual([...new Set(dupes)], [], `存在重名表情包：${[...new Set(dupes)].join("、")}`);

  const files = [...new Set(stickers.map((s) => s.file))];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    assert.ok(STICKER_EXTENSIONS.includes(ext), `${file} 的扩展名不受支持`);
    const buf = await readSticker(file);
    assert.ok(buf.length <= cfg.maxBytes, `${file} 超过 maxBytes`);
    const size = readImageSize(buf);
    assert.ok(size, `${file} 读不出尺寸`);
    assert.equal(size.format, expectedFormat(ext), `${file} 扩展名与真实格式不一致`);
    assert.ok(
      Math.max(size.width, size.height) <= 256,
      `${file} 超过提醒阈值 256px（${size.width}×${size.height}）`,
    );
  }
});

test("真实素材库：buildStickerTool 的 enum 里包含新表情，模型能选到", { skip }, async () => {
  const stickers = await listStickers(resolveStickerConfig({}));
  const tool = buildStickerTool(stickers.map((s) => s.name));
  assert.ok(tool, "有素材时必须注册表情包工具");
  const en = tool.function.parameters.properties.name.enum;
  assert.equal(new Set(en).size, stickers.length, "enum 应覆盖库里每个名字且不重复");
  // 本批 10 张（含别名拆出来的名字）都必须能被模型选中，不能只抽查 4 个
  const wanted = NEW_STICKER_FILES.flatMap((f) => stickerNamesOf(`${f}.jpg`));
  for (const name of wanted) {
    assert.ok(en.includes(name), `工具 enum 里缺少「${name}」`);
  }
});

test("真实素材库：executeStickerCall 能发出新表情，并带上 128×128 尺寸", { skip }, async () => {
  const cfg = resolveStickerConfig({});
  const res = await executeStickerCall("send_sticker", '{"name":"春禾-开心"}', cfg);
  assert.equal(res.ok, true, res.content);
  assert.equal(res.images.length, 1);
  assert.equal(res.images[0].name, "春禾-开心");
  assert.equal(res.images[0].mime, "image/jpeg");
  assert.equal(res.images[0].width, 128);
  assert.equal(res.images[0].height, 128);
  const disk = await readSticker("春禾-开心.jpg");
  assert.equal(res.images[0].bytes, disk.length);
  assert.equal(res.images[0].base64, disk.toString("base64"));
});

test(
  "真实素材库：假 API 注入后，模型能选中新表情并交给发送链路",
  { skip },
  async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: "好呀，给你一个星星眼～",
                    tool_calls: [
                      {
                        id: "call_sticker_1",
                        type: "function",
                        function: {
                          name: STICKER_TOOL_NAME,
                          arguments: JSON.stringify({ name: "春禾-星星眼" }),
                        },
                      },
                    ],
                  },
                },
              ],
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: "喏，星星眼！" } }] };
        },
      };
    };

    const gen = makeModelGenerator({
      config: {
        modelBaseUrl: "https://api.deepseek.com/v1",
        modelName: "deepseek-flash",
        modelApiKey: "sk-test",
        modelTimeoutMs: 30000,
        historyTurns: 4,
        modelVision: false,
        fileReading: false,
        imageGen: { enabled: false, maxRounds: 3 },
        stickers: {
          enabled: true,
          dir: DIR,
          maxBytes: DEFAULT_STICKER_MAX_BYTES,
        },
      },
      logger: null,
      fetchImpl,
    });

    const ctx = {
      text: "发个星星眼给我看看",
      history: [],
      scope: "c2c",
      attachments: [],
      senderName: "主人",
    };
    const out = await gen(ctx);

    // 1) 工具定义里带上了新表情，模型不是瞎编名字
    const tool = calls[0].body.tools.find((t) => t.function.name === STICKER_TOOL_NAME);
    assert.ok(tool, "请求体里应有 send_sticker 工具");
    assert.ok(
      tool.function.parameters.properties.name.enum.includes("春禾-星星眼"),
      "enum 里应有「春禾-星星眼」",
    );

    // 2) tool 结果回填为「已发送」
    const toolMsg = calls[1].body.messages.find((m) => m.role === "tool");
    assert.match(toolMsg.content, /已发送表情包「春禾-星星眼」/);

    // 3) 图片被挂到 ctx.generatedImages，字节与磁盘文件完全一致（引擎随后发它）
    assert.equal(ctx.generatedImages.length, 1);
    const img = ctx.generatedImages[0];
    assert.equal(img.name, "春禾-星星眼");
    const disk = await readSticker("春禾-星星眼.jpg");
    assert.equal(img.base64, disk.toString("base64"));
    assert.equal(out, "喏，星星眼！");
  },
);
