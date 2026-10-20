/**
 * 单元测试：语音回复链路（TTS 合成 → tencent SILK → QQ 富媒体语音消息）。
 *
 * 全部离线、不依赖真实 Python / 网络：通过注入 spawn / fs 打桩，
 * 重点验证「任何一环失败都必须降级成文字，绝不抛异常」这条硬约束。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";

import {
  DEFAULT_VOICE,
  VOICE_MODES,
  resolveTtsConfig,
  buildTtsArgs,
  truncateForSpeech,
  stripForSpeech,
  decideVoiceReply,
  synthesizeSilk,
} from "../src/media/tts.js";

import {
  VOICE_FILE_TYPE,
  c2cFileUploadPath,
  buildFileUploadBody,
  buildVoiceMessageBody,
} from "../src/qq/api.js";

/**
 * 本文件验证的是「纯 edge-tts → SILK」链路，显式关掉 RVC。
 * RVC 变声、缓存、降级链由 test/tts-rvc.test.js 单独覆盖。
 */
const ttsCfg = (env = {}) => resolveTtsConfig({ QQ_VOICE_RVC: "false", ...env });

// ---------------------------------------------------------------- 打桩工具

/** 造一个假的 ChildProcess：可指定退出码、stdout/stderr，或在 close 前写文件。 */
function fakeChild({ code = 0, stdout = "", stderr = "", onSpawn, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (error) {
      child.emit("error", error);
      return;
    }
    if (onSpawn) onSpawn();
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  });
  return child;
}

/** 记录调用参数的 spawn 打桩 */
function recordingSpawn(result) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeChild(result);
  };
  fn.calls = calls;
  return fn;
}

const OK_JSON = JSON.stringify({ ok: true, bytes: 4242, duration: 2.1 });

// ---------------------------------------------------------------- 配置解析

test("tts: 默认音色是年轻活泼的 zh-CN-XiaoyiNeural", () => {
  assert.equal(DEFAULT_VOICE, "zh-CN-XiaoyiNeural");
});

test("tts: 默认关闭——不设 QQ_VOICE_REPLY 时不启用语音", () => {
  const cfg = resolveTtsConfig({});
  assert.equal(cfg.mode, VOICE_MODES.OFF);
  assert.equal(cfg.enabled, false);
});

test("tts: QQ_VOICE_REPLY=mirror 时启用镜像模式", () => {
  const cfg = ttsCfg({ QQ_VOICE_REPLY: "mirror" });
  assert.equal(cfg.mode, VOICE_MODES.MIRROR);
  assert.equal(cfg.enabled, true);
});

test("tts: QQ_VOICE_REPLY=always 时启用全语音模式", () => {
  const cfg = resolveTtsConfig({ QQ_VOICE_REPLY: "always" });
  assert.equal(cfg.mode, VOICE_MODES.ALWAYS);
  assert.equal(cfg.enabled, true);
});

test("tts: 无法识别的模式按关闭处理（不擅自打开）", () => {
  const cfg = resolveTtsConfig({ QQ_VOICE_REPLY: "yes-please" });
  assert.equal(cfg.mode, VOICE_MODES.OFF);
  assert.equal(cfg.enabled, false);
});

test("tts: 音色与限长可用环境变量覆盖", () => {
  const cfg = resolveTtsConfig({
    QQ_VOICE_REPLY: "mirror",
    TTS_VOICE: "zh-CN-XiaoxiaoNeural",
    TTS_MAX_CHARS: "40",
    TTS_RATE: "+10%",
  });
  assert.equal(cfg.voice, "zh-CN-XiaoxiaoNeural");
  assert.equal(cfg.maxChars, 40);
  assert.equal(cfg.rate, "+10%");
});

// ---------------------------------------------------------------- 文本处理

test("tts: 截断按上限裁剪并保留可读结尾", () => {
  const long = "啊".repeat(500);
  const out = truncateForSpeech(long, 100);
  assert.ok(out.length <= 100, `期望 <=100，实际 ${out.length}`);
  assert.ok(out.length > 0);
});

test("tts: 去掉换行与多余空白（语音里念换行很怪）", () => {
  const out = truncateForSpeech("第一行\n\n第二行   带空格", 200);
  assert.ok(!out.includes("\n"), "不应包含换行");
  assert.ok(!/\s{2,}/.test(out), "不应有连续空白");
});

test("tts: 空文本返回空串（调用方据此跳过合成）", () => {
  assert.equal(truncateForSpeech("   \n  ", 100), "");
  assert.equal(truncateForSpeech("", 100), "");
  assert.equal(truncateForSpeech(null, 100), "");
});

// ---------------------------------------------------------------- 参数构造

test("tts: buildTtsArgs 生成助手所需的完整命令行", () => {
  const cfg = resolveTtsConfig({ TTS_VOICE: "zh-CN-XiaoyiNeural", TTS_RATE: "+5%" });
  const args = buildTtsArgs({
    scriptPath: "C:/x/tools/tts_silk.py",
    text: "你好呀",
    outPath: "C:/tmp/a.silk",
    cfg,
  });
  assert.ok(args.includes("--text"));
  assert.ok(args.includes("你好呀"));
  assert.ok(args.includes("--out"));
  assert.ok(args.includes("C:/tmp/a.silk"));
  assert.ok(args.includes("--voice"));
  assert.ok(args.includes("zh-CN-XiaoyiNeural"));
  assert.ok(args.includes("+5%"), "应带上语速");
  assert.ok(args[0].endsWith("tts_silk.py"), `第一个参数应是脚本路径，实际 ${args[0]}`);
});

// ---------------------------------------------------------------- 合成成功

test("tts: 合成成功时返回 silk 字节，并写临时文件", async () => {
  const spawned = recordingSpawn({ code: 0, stdout: OK_JSON });
  const silkBytes = Buffer.from([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b]);

  const res = await synthesizeSilk("你好呀", ttsCfg({ QQ_VOICE_REPLY: "mirror" }), {
    spawn: spawned,
    makeTmpPath: () => "C:/tmp/tts-test.silk",
    readFile: async () => silkBytes,
    removeFile: async () => {},
  });

  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.silk, silkBytes);
  assert.equal(spawned.calls.length, 1, "应只调用一次助手");
});

// ---------------------------------------------------------------- 各种降级

test("tts: 超过 QQ 58s 上限的语音直接判失败（不进缓存、不会被下次命中绕过）", async () => {
  const res = await synthesizeSilk(
    "很长很长的一段话",
    ttsCfg({ QQ_VOICE_REPLY: "mirror", VOICE_CACHE_ENABLED: "false" }),
    {
      spawn: recordingSpawn({
        code: 0,
        stdout: JSON.stringify({ ok: true, bytes: 4242, duration_ms: 59000 }),
      }),
      makeTmpPath: () => "C:/tmp/long.silk",
      readFile: async () => Buffer.from("\x02#!SILK_V3", "latin1"),
      removeFile: async () => {},
    },
  );
  assert.equal(res.ok, false, "超过 58s 的语音不该发出去（QQ 会拒收）");
  assert.match(res.reason, /58|时长/);
});

test("tts: 空文本直接跳过合成，不启动子进程", async () => {
  const spawned = recordingSpawn({ code: 0 });
  const res = await synthesizeSilk("   ", ttsCfg({ QQ_VOICE_REPLY: "mirror" }), {
    spawn: spawned,
    readFile: async () => Buffer.alloc(0),
    removeFile: async () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(spawned.calls.length, 0, "空文本不应启动子进程");
});

test("tts: Python 不存在（ENOENT）时降级且不抛异常", async () => {
  const enoent = Object.assign(new Error("spawn python ENOENT"), { code: "ENOENT" });
  const res = await synthesizeSilk("你好", ttsCfg({ QQ_VOICE_REPLY: "mirror" }), {
    spawn: () => fakeChild({ error: enoent }),
    readFile: async () => Buffer.alloc(0),
    removeFile: async () => {},
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /python|找不到|未找到|ENOENT/i);
});

test("tts: 助手非零退出时降级，并把 stderr 带进原因", async () => {
  const res = await synthesizeSilk("你好", ttsCfg({ QQ_VOICE_REPLY: "mirror" }), {
    spawn: () => fakeChild({ code: 1, stderr: "edge-tts: connection reset" }),
    readFile: async () => Buffer.alloc(0),
    removeFile: async () => {},
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /connection reset/);
});

test("tts: 助手返回 ok:false 时降级并透传其 error", async () => {
  const res = await synthesizeSilk("你好", ttsCfg({ QQ_VOICE_REPLY: "mirror" }), {
    spawn: () => fakeChild({ code: 0, stdout: JSON.stringify({ ok: false, error: "单次文本过长" }) }),
    readFile: async () => Buffer.alloc(0),
    removeFile: async () => {},
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /单次文本过长/);
});

test("tts: 退出码 0 但没产出文件时降级（不吞掉问题）", async () => {
  const res = await synthesizeSilk("你好", ttsCfg({ QQ_VOICE_REPLY: "mirror" }), {
    spawn: () => fakeChild({ code: 0, stdout: OK_JSON }),
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    removeFile: async () => {},
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /ENOENT|未产出|读不到/);
});

test("tts: 产出文件为空时降级（防止发一条空语音）", async () => {
  const res = await synthesizeSilk("你好", ttsCfg({ QQ_VOICE_REPLY: "mirror" }), {
    spawn: () => fakeChild({ code: 0, stdout: OK_JSON }),
    readFile: async () => Buffer.alloc(0),
    removeFile: async () => {},
  });
  assert.equal(res.ok, false);
});

test("tts: spawn 本身抛异常也降级（最外层兜底）", async () => {
  const res = await synthesizeSilk("你好", ttsCfg({ QQ_VOICE_REPLY: "mirror" }), {
    spawn: () => { throw new Error("boom"); },
    readFile: async () => Buffer.alloc(0),
    removeFile: async () => {},
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /boom/);
});

test("tts: stdout 不是 JSON 也不崩（助手被打断输出）", async () => {
  const res = await synthesizeSilk("你好", ttsCfg({ QQ_VOICE_REPLY: "mirror" }), {
    spawn: () => fakeChild({ code: 0, stdout: "Traceback (most recent call last)" }),
    readFile: async () => Buffer.from("silk"),
    removeFile: async () => {},
  });
  // 只要能拿到 silk 文件就当成功；关键是不抛异常
  assert.equal(typeof res.ok, "boolean");
});

// ---------------------------------------------------------------- 语音清洗

test("tts: 去掉 emoji，避免被念出名字", () => {
  assert.equal(stripForSpeech("主人好呀～🌸✨"), "主人好呀～");
  assert.equal(stripForSpeech("春禾收到啦🌸"), "春禾收到啦");
});

test("tts: 只有 emoji 的文本清成空串（调用方据此降级为文字）", () => {
  assert.equal(stripForSpeech("🌸✨💖"), "");
  assert.equal(stripForSpeech("🌸 ✨"), "");
});

test("tts: emoji 删掉后留下的空标点被清理", () => {
  assert.equal(stripForSpeech("听不到哦💖，只能看文字✨"), "听不到哦，只能看文字");
});

test("tts: 去掉 markdown 强调标记但保留文字", () => {
  assert.equal(stripForSpeech("春禾**看不到**哦"), "春禾看不到哦");
  assert.equal(stripForSpeech("__重点__内容"), "重点内容");
});

test("tts: 去掉反引号与代码围栏（语言标记也丢掉，没人想听 js）", () => {
  assert.equal(stripForSpeech("用 `pysilk` 编码"), "用 pysilk 编码");
  assert.equal(stripForSpeech("```js\nlet a=1;\n```"), "let a=1;");
});

test("tts: 去掉行首列表/标题标记", () => {
  assert.equal(stripForSpeech("- 第一条\n- 第二条"), "第一条 第二条");
  assert.equal(stripForSpeech("## 标题"), "标题");
});

test("tts: 【AI】等方括号去括号保留内容", () => {
  assert.equal(stripForSpeech("【AI】你好"), "AI你好");
  assert.equal(stripForSpeech("「方程求根」的实践"), "方程求根的实践");
});

test("tts: 保留语气符号 ～ 与中文标点（它们承载语气，不能删）", () => {
  assert.equal(stripForSpeech("春禾都在～"), "春禾都在～");
  assert.equal(stripForSpeech("你好呀！今天想聊什么呢？"), "你好呀！今天想聊什么呢？");
});

test("tts: 孤立星号（公式如 p* 或 2*3）被去掉且不影响字母数字", () => {
  assert.equal(stripForSpeech("根 p* = 0.387"), "根 p = 0.387");
  assert.equal(stripForSpeech("计算 2*3 得 6"), "计算 23 得 6");
});

test("tts: 真实回复样本清洗后不含任何 emoji / markdown / 换行", () => {
  const sample =
    "主人好呀～这个春禾**看不到**哦🌸\n\n" +
    "春禾只能看到自己参与的那段对话历史✨\n\n" +
    "所以如果主人想让春禾知道某段内容～💖";
  const out = stripForSpeech(sample);
  assert.ok(!/\p{Extended_Pictographic}/u.test(out), `仍含 emoji：${out}`);
  assert.ok(!out.includes("**"), `仍含 markdown：${out}`);
  assert.ok(!out.includes("\n"), "仍含换行");
  assert.ok(out.includes("看不到"), "正文被误删");
  assert.ok(out.includes("～"), "语气符号被误删");
});

test("tts: 纯 emoji 文本在 synthesizeSilk 里直接跳过，不启动子进程", async () => {
  const spawned = recordingSpawn({ code: 0 });
  const res = await synthesizeSilk("🌸✨💖", ttsCfg({ QQ_VOICE_REPLY: "mirror" }), {
    spawn: spawned,
    readFile: async () => Buffer.alloc(0),
    removeFile: async () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(spawned.calls.length, 0, "纯 emoji 不该启动子进程");
});

test("tts: 真正传给助手的是清洗后的文本（不含 emoji）", async () => {
  const spawned = recordingSpawn({ code: 0, stdout: OK_JSON });
  await synthesizeSilk("你好呀🌸✨", ttsCfg({ QQ_VOICE_REPLY: "mirror" }), {
    spawn: spawned,
    readFile: async () => Buffer.from("silk"),
    removeFile: async () => {},
  });
  const { args } = spawned.calls[0];
  const textArg = args[args.indexOf("--text") + 1];
  assert.ok(!/\p{Extended_Pictographic}/u.test(textArg), `助手收到 emoji：${textArg}`);
  assert.equal(textArg, "你好呀");
});

// ---------------------------------------------------------------- 何时发语音

test("tts: mirror 模式——收到语音才用语音回", () => {
  const cfg = ttsCfg({ QQ_VOICE_REPLY: "mirror" });
  assert.equal(decideVoiceReply({ cfg, media: { type: "voice" }, scope: "c2c" }), true);
  assert.equal(decideVoiceReply({ cfg, media: { type: "image" }, scope: "c2c" }), false);
  assert.equal(decideVoiceReply({ cfg, media: null, scope: "c2c" }), false);
});

test("tts: 群聊默认不发语音（先只在私聊启用）", () => {
  const cfg = ttsCfg({ QQ_VOICE_REPLY: "mirror" });
  assert.equal(decideVoiceReply({ cfg, media: { type: "voice" }, scope: "group" }), false);
});

test("tts: off 模式任何时候都不发语音", () => {
  const cfg = resolveTtsConfig({ QQ_VOICE_REPLY: "off" });
  assert.equal(decideVoiceReply({ cfg, media: { type: "voice" }, scope: "c2c" }), false);
});

test("tts: always 模式私聊全部用语音回", () => {
  const cfg = resolveTtsConfig({ QQ_VOICE_REPLY: "always" });
  assert.equal(decideVoiceReply({ cfg, media: null, scope: "c2c" }), true);
  assert.equal(decideVoiceReply({ cfg, media: null, scope: "group" }), false);
});

// ---------------------------------------------------------------- QQ 富媒体

test("qq: 语音的 file_type 必须是 3", () => {
  assert.equal(VOICE_FILE_TYPE, 3);
});

test("qq: 单聊上传路径为 /v2/users/{openid}/files", () => {
  assert.equal(c2cFileUploadPath("OPENID123"), "/v2/users/OPENID123/files");
});

test("qq: 上传 body——base64、file_type=3、srv_send_msg=false 且带 openid", () => {
  const body = buildFileUploadBody({
    openid: "OPENID123",
    fileDataBase64: "QUJD",
    fileType: VOICE_FILE_TYPE,
  });
  assert.equal(body.file_data, "QUJD");
  assert.equal(body.file_type, 3);
  assert.equal(body.srv_send_msg, false);
  assert.equal(body.openid, "OPENID123");
});

test("qq: 语音消息 body 用 msg_type=7 + media.file_info", () => {
  const body = buildVoiceMessageBody({
    fileInfo: "FILE_INFO_ABC",
    msgId: "MSGID1",
    msgSeq: 7,
  });
  assert.equal(body.msg_type, 7);
  assert.equal(body.media.file_info, "FILE_INFO_ABC");
  assert.equal(body.content, undefined, "语音消息不应带 content");
  assert.equal(body.msg_id, "MSGID1");
  assert.equal(body.msg_seq, 7);
});

test("qq: 语音消息不带 msg_id 时是主动消息（不塞 undefined 字段）", () => {
  const body = buildVoiceMessageBody({ fileInfo: "FI", msgSeq: 1 });
  assert.equal(body.msg_type, 7);
  assert.ok(!("msg_id" in body), "不应出现 msg_id 字段");
});
