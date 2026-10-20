/**
 * 唱歌测试：**点歌必须唱点的那首**。
 *
 * 修的是一个真实 bug：曲库（`...\media\qqbot\songs\*.silk`）里明明有《樱花草》，
 * 旧引擎却完全无视它——命中触发词就用硬编码的 `scores/daoxiang_chorus.json`
 * 跑 DiffSinger，于是主人点《樱花草》听到的永远是《稻香》副歌（27863ms）。
 *
 * 这里锁死四件事：
 *   1. 歌名抽取（各种点歌说法都要认得，否定/疑问一句都不能触发）
 *   2. 曲库匹配（多段按顺序、多个单文件取最长、没有就回落合成）
 *   3. 降级（目录不存在 / 文件损坏 → 一律不抛，最差回落到合成）
 *   4. 真发出去的是曲库那一份字节，而不是合成出来的稻香
 *
 * 全部离线：目录/文件/子进程全部注入，不碰真实曲库、不联网。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_LIBRARY_DIR,
  defaultLibraryDir,
  resolveSingConfig,
  extractSongName,
  parseSongFileName,
  silkFrames,
  silkDurationMs,
  listLibrarySongs,
  planLibrarySong,
  resolveLibrarySong,
  readLibrarySilk,
  isSingRequest,
} from "../src/media/sing.js";

import { MessageEngine } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");

// ---------------------------------------------------------------- 打桩工具

/** 造一段合法的 tencent SILK_V3：header + N 个 20ms 包 + 终止包 */
function makeSilk(frames, { header = "\x02#!SILK_V3", payload = 8, terminator = 0 } = {}) {
  const chunks = [Buffer.from(header, "binary")];
  for (let i = 0; i < frames; i += 1) {
    const len = Buffer.alloc(2);
    len.writeUInt16LE(payload);
    chunks.push(len, Buffer.alloc(payload, (i * 7) & 0xff));
  }
  const end = Buffer.alloc(2);
  end.writeUInt16LE(terminator);
  chunks.push(end);
  return Buffer.concat(chunks);
}

/** 临时曲库目录；用完必须删 */
function tempLib() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chunhe-songs-"));
  return {
    dir,
    write(file, frames) {
      fs.writeFileSync(path.join(dir, file), makeSilk(frames));
      return path.join(dir, file);
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 纯函数测试用的曲目条目（时长即真实曲库的实测值） */
function entryOf(file, durationMs) {
  return {
    ...parseSongFileName(file),
    file,
    path: `C:\\lib\\${file}`,
    bytes: 1024,
    durationMs,
  };
}

/** 与真实曲库同名同长的假条目集 */
const LIB = [
  entryOf("樱花草_绮萱RVC.silk", 35000),
  entryOf("樱花草_绮萱RVC_57s.silk", 57000),
  entryOf("樱花草_绮萱RVC_full_1of5.silk", 48200),
  entryOf("樱花草_绮萱RVC_full_2of5.silk", 44000),
  entryOf("樱花草_绮萱RVC_full_3of5.silk", 51800),
  entryOf("樱花草_绮萱RVC_full_4of5.silk", 42000),
  entryOf("樱花草_绮萱RVC_full_5of5.silk", 47800),
  entryOf("送别_RVC学姐.silk", 35000),
  entryOf("送别_绮萱RVC.silk", 25600),
  entryOf("稻香副歌_DiffSinger.silk", 27900),
];

// ---------------------------------------------------------------- 歌名抽取

test("歌名抽取：各种点歌说法都把歌名抽出来", () => {
  const cases = [
    ["唱樱花草", "樱花草"],
    ["唱首樱花草", "樱花草"],
    ["唱一首樱花草", "樱花草"],
    ["来一首樱花草", "樱花草"],
    ["来首樱花草", "樱花草"],
    ["来一个樱花草", "樱花草"],
    ["点歌 樱花草", "樱花草"],
    ["点一首 樱花草", "樱花草"],
    ["点歌樱花草", "樱花草"],
    ["唱给我听 樱花草", "樱花草"],
    ["给我唱樱花草", "樱花草"],
    ["春禾唱樱花草", "樱花草"],
    ["春禾，唱首樱花草", "樱花草"],
    ["樱花草", "樱花草"],
    ["唱樱花草吧", "樱花草"],
    ["唱一下樱花草", "樱花草"],
    ["唱段樱花草", "樱花草"],
    ["来一首稻香", "稻香"],
    ["唱送别", "送别"],
    ["唱给我听", ""],
    ["唱首歌", ""],
    ["来一首", ""],
    ["点歌", ""],
    ["", ""],
    ["你会唱歌吗", ""],
    ["别唱了", ""],
  ];
  for (const [input, want] of cases) {
    assert.equal(extractSongName(input), want, `「${input}」应抽出「${want}」`);
  }
});

// ---------------------------------------------------------------- 触发闸门

test("触发闸门：带歌名的点歌要认，否定/疑问照旧不认（不许破坏原守卫）", () => {
  const names = ["樱花草", "送别", "稻香副歌"];

  // 新的：曲库里有这首歌 + 有唱歌动作
  for (const t of ["唱樱花草", "唱首送别", "来一首樱花草", "点歌 樱花草", "春禾唱稻香"]) {
    assert.equal(isSingRequest(t, { songNames: names }), true, `应触发：${t}`);
  }
  // 单独一个歌名（整句就是歌名）也算点歌
  assert.equal(isSingRequest("樱花草", { songNames: names }), true);

  // 原有守卫一条都不许松动
  for (const t of [
    "你会唱歌吗",
    "在唱歌吗",
    "唱歌真好听",
    "别唱歌了",
    "我不想听歌",
    "唱歌的时候很吵",
    "你唱过歌吗",
    "怎么样才能唱好",
  ]) {
    assert.equal(isSingRequest(t, { songNames: names }), false, `不该触发：${t}`);
  }

  // 只是提到歌名、没有点歌动作 → 不触发（避免"我昨天在KTV唱稻香"这种被当成点歌）
  for (const t of [
    "我最喜欢樱花草这首歌",
    "昨天在KTV唱了稻香副歌",
    "樱花草是什么花",
    "刚才听到送别了",
  ]) {
    assert.equal(isSingRequest(t, { songNames: names }), false, `不该触发：${t}`);
  }

  // 没给歌名表时行为与旧版一致
  assert.equal(isSingRequest("唱首歌"), true);
  assert.equal(isSingRequest("你会唱歌吗"), false);
  assert.equal(isSingRequest("唱樱花草"), false, "没给曲库时不该凭空认出歌名");
});

// ---------------------------------------------------------------- SILK 时长

test("SILK 时长：按 20ms 包数推算，坏文件返回 0 而不是抛", () => {
  assert.equal(silkFrames(makeSilk(100)), 100);
  assert.equal(silkDurationMs(makeSilk(100)), 2000);
  assert.equal(silkDurationMs(makeSilk(1393)), 27860, "稻香副歌 ≈27.9s");
  // 0xFFFF 也当终止符
  assert.equal(silkDurationMs(makeSilk(10, { terminator: 0xffff })), 200);
  // 头不对 / 太短 / 空 → 0
  assert.equal(silkDurationMs(Buffer.from("nope")), 0);
  assert.equal(silkDurationMs(makeSilk(10, { header: "XXXXXXXXXX" })), 0);
  assert.equal(silkDurationMs(Buffer.alloc(0)), 0);
  assert.equal(silkDurationMs(null), 0);
  // 长度字段越界 → 不当成有效时长
  const truncated = Buffer.concat([Buffer.from("\x02#!SILK_V3", "binary"), Buffer.from([0xff, 0x00, 0x01])]);
  assert.equal(silkDurationMs(truncated), 0);
});

// ---------------------------------------------------------------- 文件名解析

test("文件名解析：歌名/版本/分段序号都要拆对", () => {
  assert.deepEqual(parseSongFileName("樱花草_绮萱RVC_full_3of5.silk"), {
    name: "樱花草",
    singer: "绮萱RVC",
    variant: "full",
    base: "樱花草_绮萱RVC_full",
    part: 3,
    parts: 5,
  });
  assert.deepEqual(parseSongFileName("送别_RVC学姐.silk"), {
    name: "送别",
    singer: "RVC学姐",
    variant: "",
    base: "送别_RVC学姐",
    part: 0,
    parts: 1,
  });
  assert.deepEqual(parseSongFileName("稻香副歌_DiffSinger.silk"), {
    name: "稻香副歌",
    singer: "DiffSinger",
    variant: "",
    base: "稻香副歌_DiffSinger",
    part: 0,
    parts: 1,
  });
  assert.equal(parseSongFileName("樱花草.silk").name, "樱花草");
  assert.equal(parseSongFileName("樱花草.silk").parts, 1);
  assert.equal(parseSongFileName("readme.txt"), null);
  assert.equal(parseSongFileName(".silk"), null);
});

// ---------------------------------------------------------------- 曲库扫描

test("曲库扫描：跳过非 silk、跳过坏文件，目录不存在返回空数组（不抛）", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 2850);
    lib.write("送别_RVC学姐.silk", 1749);
    fs.writeFileSync(path.join(lib.dir, "坏的.silk"), Buffer.from("not a silk at all"));
    fs.writeFileSync(path.join(lib.dir, "notes.txt"), "x");

    const songs = await listLibrarySongs({ dir: lib.dir });
    const files = songs.map((s) => s.file).sort();
    assert.deepEqual(files, ["樱花草_绮萱RVC_57s.silk", "送别_RVC学姐.silk"]);
    const ying = songs.find((s) => s.name === "樱花草");
    assert.equal(ying.durationMs, 57000, "时长要从 SILK 内容里量出来");
    assert.equal(ying.bytes > 0, true);

    const missing = await listLibrarySongs({ dir: path.join(lib.dir, "nope") });
    assert.deepEqual(missing, []);
  } finally {
    lib.cleanup();
  }
});

test("曲库扫描：子目录里的文件绝不能被算进曲库（坏歌就是靠移进子目录下架的）", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 100);
    // 形如 songs\_removed-20261016\樱花草_绮萱RVC_full.silk：已下架的坏版本
    const junk = path.join(lib.dir, "_removed-20261016");
    fs.mkdirSync(junk);
    fs.writeFileSync(path.join(junk, "樱花草_绮萱RVC_full.silk"), makeSilk(90));

    const songs = await listLibrarySongs({ dir: lib.dir });
    assert.deepEqual(songs.map((s) => s.file), ["樱花草_绮萱RVC_57s.silk"]);
    assert.equal(
      planLibrarySong("唱樱花草", songs).files[0].file,
      "樱花草_绮萱RVC_57s.silk",
      "已下架的版本不能再被挑中",
    );
  } finally {
    lib.cleanup();
  }
});

// ---------------------------------------------------------------- 选曲（纯函数）

test("选曲：多段整套按顺序发；多个单文件取最长；匹配不到返回 null", () => {
  const ying = planLibrarySong("唱樱花草", LIB);
  assert.ok(ying, "应命中《樱花草》");
  assert.equal(ying.name, "樱花草");
  assert.equal(ying.multi, true, "有 1of5..5of5 整套时`应当发整套");
  assert.deepEqual(
    ying.files.map((f) => f.file),
    [
      "樱花草_绮萱RVC_full_1of5.silk",
      "樱花草_绮萱RVC_full_2of5.silk",
      "樱花草_绮萱RVC_full_3of5.silk",
      "樱花草_绮萱RVC_full_4of5.silk",
      "樱花草_绮萱RVC_full_5of5.silk",
    ],
    "必须按 1→5 顺序",
  );
  assert.equal(ying.totalMs, 48200 + 44000 + 51800 + 42000 + 47800);

  // 两个单文件 → 取时长最长的那个（送别 35s 而不是 25.6s）
  const songbie = planLibrarySong("来一首送别", LIB);
  assert.equal(songbie.multi, false);
  assert.deepEqual(songbie.files.map((f) => f.file), ["送别_RVC学姐.silk"]);

  // 名字带后缀也要能匹配（点「稻香」要认出「稻香副歌」）
  const daoxiang = planLibrarySong("唱稻香", LIB);
  assert.deepEqual(daoxiang.files.map((f) => f.file), ["稻香副歌_DiffSinger.silk"]);

  // 曲库没有 → null（交给合成兜底），不是抛
  assert.equal(planLibrarySong("唱小星星", LIB), null);
  assert.equal(planLibrarySong("唱给我听", LIB), null);
  assert.equal(planLibrarySong("唱首歌", LIB), null);
  assert.equal(planLibrarySong("唱樱花草", []), null);
  assert.equal(planLibrarySong("", LIB), null);
});

test("选曲：分段缺号时不假装是整套，退回单文件挑最长", () => {
  const broken = LIB.filter((e) => !e.file.includes("3of5"));
  const plan = planLibrarySong("唱樱花草", broken);
  assert.equal(plan.multi, false, "缺 3of5 就不算完整整套");
  assert.deepEqual(plan.files.map((f) => f.file), ["樱花草_绮萱RVC_57s.silk"], "退回最长的单文件");
});

// ---------------------------------------------------------------- 解析（含降级）

test("解析曲库点歌：先看本条消息，看不到就回看最近几轮（「唱给我听」也能接上）", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 2850);
    lib.write("送别_RVC学姐.silk", 1749);

    const direct = await resolveLibrarySong(
      { libraryDir: lib.dir },
      { text: "唱樱花草" },
    );
    assert.deepEqual(direct.files.map((f) => f.file), ["樱花草_绮萱RVC_57s.silk"]);
    assert.equal(direct.source, "text");

    // 真实 bug 现场：歌名在上一轮（"春禾会唱樱花草吗"），这一轮只说"唱给我听"
    const carried = await resolveLibrarySong(
      { libraryDir: lib.dir },
      { text: "唱给我听", recentTexts: ["春禾会唱樱花草吗", "在吗"] },
    );
    assert.ok(carried, "应从历史里接上歌名");
    assert.deepEqual(carried.files.map((f) => f.file), ["樱花草_绮萱RVC_57s.silk"]);
    assert.equal(carried.source, "recent");

    // 本轮的优先于历史（新点的歌要盖过旧的）
    const fresh = await resolveLibrarySong(
      { libraryDir: lib.dir },
      { text: "唱送别", recentTexts: ["春禾会唱樱花草吗"] },
    );
    assert.deepEqual(fresh.files.map((f) => f.file), ["送别_RVC学姐.silk"]);
    assert.equal(fresh.source, "text");

    // 谁都没点到 → null
    assert.equal(await resolveLibrarySong({ libraryDir: lib.dir }, { text: "唱首歌" }), null);

    // 目录不存在 / 目录是文件 → 一律降级为 null，绝不抛
    assert.equal(
      await resolveLibrarySong({ libraryDir: path.join(lib.dir, "nope") }, { text: "唱樱花草" }),
      null,
    );
    assert.equal(await resolveLibrarySong({ libraryDir: "" }, { text: "唱樱花草" }), null);
  } finally {
    lib.cleanup();
  }
});

test("读曲库文件：路径不存在/内容损坏都返回 ok:false，不抛异常", async () => {
  const lib = tempLib();
  try {
    const p = lib.write("樱花草_绮萱RVC_57s.silk", 100);
    const good = await readLibrarySilk(p);
    assert.equal(good.ok, true);
    assert.equal(good.silk.length, fs.statSync(p).size);

    const bad = await readLibrarySilk(path.join(lib.dir, "nope.silk"));
    assert.equal(bad.ok, false);
    assert.ok(bad.reason);

    const corruptPath = path.join(lib.dir, "坏的.silk");
    fs.writeFileSync(corruptPath, Buffer.from("not a silk"));
    const corrupt = await readLibrarySilk(corruptPath);
    assert.equal(corrupt.ok, false, "头不对就不该发出去（QQ 会拒收）");
  } finally {
    lib.cleanup();
  }
});

// ---------------------------------------------------------------- 配置

test("配置：曲库目录可配（环境变量），默认指向真实曲库", () => {
  assert.equal(resolveSingConfig({}).libraryDir, DEFAULT_LIBRARY_DIR);
  assert.equal(resolveSingConfig({ SING_LIBRARY_DIR: "D:\\songs" }).libraryDir, "D:\\songs");
  assert.equal(resolveSingConfig({ QQ_SING_LIBRARY_DIR: "E:\\s" }).libraryDir, "E:\\s");
  assert.equal(resolveSingConfig({}).libraryGapMs, 5000, "多段之间默认等 5 秒");
  assert.equal(resolveSingConfig({ SING_LIBRARY_GAP_MS: "0" }).libraryGapMs, 0);
  assert.equal(defaultLibraryDir({}), DEFAULT_LIBRARY_DIR);
});

// ---------------------------------------------------------------- 引擎端到端

/** 假 api：只记账，什么都不发 */
function fakeApi() {
  const uploads = [];
  const texts = [];
  return {
    uploads,
    texts,
    async uploadC2CFile(targetId, base64, fileType) {
      uploads.push({ targetId, buf: Buffer.from(base64, "base64"), fileType });
      return `file_info_${uploads.length}`;
    },
    async sendC2CVoice(targetId, fileInfo) {
      return { id: `voice_${fileInfo}` };
    },
    async sendMessage(scope, targetId, text) {
      texts.push(text);
      return { id: `text_${texts.length}` };
    },
  };
}

/** 造一个引擎：故意不给 SING_PYTHON，让合成**必然失败**——
 *  这样一旦真的发出歌来，就只可能是走了曲库，不可能是合成兜底。 */
function makeEngine(env = {}) {
  const config = loadConfig({
    QQ_SING_ENABLED: "true",
    QQ_MULTI_MESSAGE: "false",
    QQ_AI_LABEL_STYLE: "none",
    AI_LABEL: "",
    SING_LIBRARY_GAP_MS: "0",
    // 群注册表/主动消息配额跟记忆文件同目录，避免测试污染线上 data/
    QQ_MEMORY_FILE: path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-sing-")),
      "memory.json",
    ),
    ...env,
  });
  const api = fakeApi();
  const engine = new MessageEngine({
    config,
    api,
    generate: async () => "好呀～",
    logger,
  });
  return { engine, api, config };
}

function c2cMsg(text, id = "m1") {
  return {
    scope: "c2c",
    targetId: "user_openid_test",
    senderId: "user_openid_test",
    senderName: "主人",
    messageId: id,
    content: text,
    kind: "text",
    attachments: [],
  };
}

test("端到端：点《樱花草》发出去的就是曲库那份字节，绝不是合成的稻香", async () => {
  const lib = tempLib();
  try {
    const p1 = lib.write("樱花草_绮萱RVC_full_1of5.silk", 50);
    const p2 = lib.write("樱花草_绮萱RVC_full_2of5.silk", 60);
    lib.write("送别_RVC学姐.silk", 40);
    lib.write("稻香副歌_DiffSinger.silk", 70);

    const { engine, api } = makeEngine({ SING_LIBRARY_DIR: lib.dir });
    const res = await engine.send(c2cMsg("唱樱花草"), "好呀～");

    assert.equal(res.action, "replied");
    assert.equal(res.song, true);
    assert.equal(api.uploads.length, 2, "两段都要发");
    assert.deepEqual(api.uploads.map((u) => u.buf), [
      fs.readFileSync(p1),
      fs.readFileSync(p2),
    ], "字节必须等于曲库文件，顺序 1→2");
    assert.equal(api.texts.length, 0, "发了歌就不该再发文字");
  } finally {
    lib.cleanup();
  }
});

test("端到端：曲库有歌时不需要 python（不合成也能唱）", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 100);
    // SING_PYTHON 与 TTS_PYTHON 都不给：合成必然失败，走曲库才可能成功
    const { engine, api } = makeEngine({ SING_LIBRARY_DIR: lib.dir, SING_PYTHON: "", TTS_PYTHON: "" });
    const res = await engine.send(c2cMsg("唱樱花草"), "好呀～");
    assert.equal(res.action, "replied");
    assert.equal(api.uploads.length, 1);
  } finally {
    lib.cleanup();
  }
});

test("端到端：真实 bug 现场——先问「会唱樱花草吗」，再说「唱给我听」，要唱樱花草", async () => {
  const lib = tempLib();
  try {
    const p = lib.write("樱花草_绮萱RVC_57s.silk", 120);
    const { engine, api } = makeEngine({ SING_LIBRARY_DIR: lib.dir });

    // 第一轮：她只是被问"会不会"——不该发歌
    const first = await engine.send(c2cMsg("春禾会唱樱花草吗", "m1"), "会呀，熟得很～");
    assert.equal(first.action, "replied");
    assert.equal(api.uploads.length, 0, "只是被问会不会，不该直接唱");
    engine.memory.append("c2c:user_openid_test", "春禾会唱樱花草吗", "会呀，熟得很～");

    // 第二轮：「唱给我听」——本条消息里没有歌名，要从上一轮接上
    const textsAfterFirst = api.texts.length;
    const second = await engine.send(c2cMsg("唱给我听", "m2"), "好呀～");
    assert.equal(second.action, "replied");
    assert.equal(second.song, true, "应当唱歌而不是回文字");
    assert.equal(api.uploads.length, 1);
    assert.deepEqual(api.uploads[0].buf, fs.readFileSync(p), "唱的必须是樱花草");
    assert.equal(api.texts.length, textsAfterFirst, "唱了歌就不该再补一条文字");
  } finally {
    lib.cleanup();
  }
});

test("端到端：曲库没这首歌 → 照旧回落合成，合成不可用就退化回文字（不许静默丢消息）", async () => {
  const lib = tempLib();
  try {
    lib.write("送别_RVC学姐.silk", 40);
    const { engine, api } = makeEngine({ SING_LIBRARY_DIR: lib.dir });
    const res = await engine.send(c2cMsg("唱小星星"), "好呀～");
    assert.equal(res.action, "replied");
    assert.equal(api.uploads.length, 0, "曲库没有就不该乱发别的歌");
    assert.ok(api.texts.length >= 1, "合成不可用时必须退回文字，绝不能没回复");
  } finally {
    lib.cleanup();
  }
});

test("端到端：曲库目录不存在也不炸——降级回文字", async () => {
  const { engine, api } = makeEngine({ SING_LIBRARY_DIR: path.join(os.tmpdir(), "no-such-lib-xyz") });
  const res = await engine.send(c2cMsg("唱樱花草"), "好呀～");
  assert.equal(res.action, "replied");
  assert.equal(api.uploads.length, 0);
  assert.ok(api.texts.length >= 1);
});

test("端到端：点到了具体某首歌但发送失败 → 绝不拿合成的稻香顶替（真机实测踩到的坑）", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 2850);

    // 造一个"合成必然能成功"的假 python：它只会产出稻香副歌那段 27863ms。
    // 引擎若在曲库失败后回落合成，就会真的把稻香发出去——这正是要拦住的。
    const synthScript = path.join(lib.dir, "fake_synth.mjs");
    fs.writeFileSync(
      synthScript,
      `import fs from "node:fs";
const i = process.argv.indexOf("--out");
const out = process.argv[i + 1];
const head = Buffer.from("\\x02#!SILK_V3", "binary");
const frames = [head];
for (let n = 0; n < 1393; n += 1) { const l = Buffer.alloc(2); l.writeUInt16LE(8); frames.push(l, Buffer.alloc(8, 7)); }
const end = Buffer.alloc(2); frames.push(end);
fs.writeFileSync(out, Buffer.concat(frames));
console.log(JSON.stringify({ ok: true, duration_ms: 27863 }));`,
    );

    const { engine, api } = makeEngine({
      SING_LIBRARY_DIR: lib.dir,
      SING_TMP_DIR: lib.dir,
      SING_PYTHON: process.execPath,
      SING_SCRIPT: synthScript,
    });

    // 第一次上传（曲库那份）网络失败；后面的上传都照常成功并记账。
    const realUpload = api.uploadC2CFile;
    let calls = 0;
    api.uploadC2CFile = async (...rest) => {
      calls += 1;
      if (calls === 1) throw new Error("网络错误：fetch failed");
      return realUpload.apply(api, rest);
    };

    const res = await engine.send(c2cMsg("唱樱花草"), "好呀～");

    // 稻香副歌 = 1393 个包 × 20ms = 27860ms（真机日志里的 27863 是合成器自报的元数据，同一段音频）
    const synthesizedSent = api.uploads.some((u) => silkDurationMs(u.buf) === 27860);
    assert.equal(synthesizedSent, false, "主人点的是樱花草，绝不能用合成的稻香顶替");
    assert.equal(res.song, undefined, "没唱成就不该报成唱了");
    assert.ok(api.texts.length >= 1, "必须退回文字，不能静默丢消息");
  } finally {
    lib.cleanup();
  }
});
