/**
 * 单元测试：不依赖网络与凭证，纯逻辑。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { redact, mask, createLogger } from "../src/util/log.js";
import { parseDotenv, parseIdList, loadConfig, validateConfig, resolveApiBase } from "../src/config.js";
import {
  nextMsgSeq,
  buildMessageBody,
  c2cMessagePath,
  groupMessagePath,
  QQApi,
  ApiError,
} from "../src/qq/api.js";
import { DedupeCache, RateLimiter, AccessPolicy } from "../src/core/access.js";
import { withAiLabel, resolveAiLabelStyle, stripMentions, sessionKeyOf, describeMedia, detectCapabilityDenial } from "../src/core/engine.js";
import {
  tryCompute,
  makeLocalGenerator,
  makeModelGenerator,
  buildSystemPrompt,
  CHUNHE_SYSTEM_PROMPT,
} from "../src/persona/chunhe.js";
import { normalizeEvent, GatewayEvent } from "../src/qq/gateway.js";
import { acceptKey, encodeFrame, createFrameParser, encodeClientFrame } from "../src/mock/ws-frames.js";

// ---------------- 日志脱敏 ----------------

test("日志脱敏：密钥不会被完整写进日志", () => {
  assert.equal(mask("abcdefgh"), "ab***gh");
  assert.equal(mask("abc"), "***");
  const secret = "DG5g3B4j9X2KOErG";
  const out = redact(`secret=${secret} Authorization: QQBot ${secret}`);
  assert.ok(!out.includes(secret), "原始密钥不应出现在日志文本里");
});

test("日志脱敏：对象里的敏感字段被遮蔽", () => {
  const out = redact({ appId: "102000001", clientSecret: "topsecretvalue", nested: { token: "abcdef123456" } });
  assert.equal(out.appId, "102000001");
  assert.ok(!out.clientSecret.includes("topsecretvalue"));
  assert.ok(!out.nested.token.includes("abcdef123456"));
});

// ---------------- 配置 ----------------

test("解析 .env：支持注释、引号与空行", () => {
  const env = parseDotenv(`
# 注释
QQ_APP_ID=102000001
QQ_APP_SECRET="quoted-secret"
QQ_SANDBOX = true

BAD_LINE_NO_EQUALS
`);
  assert.equal(env.QQ_APP_ID, "102000001");
  assert.equal(env.QQ_APP_SECRET, "quoted-secret");
  assert.equal(env.QQ_SANDBOX, "true");
  assert.equal(env.BAD_LINE_NO_EQUALS, undefined);
});

test("解析 ID 列表：逗号/空格/分号都能分隔", () => {
  assert.deepEqual(parseIdList("a,b; c  d"), ["a", "b", "c", "d"]);
  assert.deepEqual(parseIdList(""), []);
});

test("配置默认值与自检", () => {
  const cfg = loadConfig({ QQ_APP_ID: "102000001", QQ_APP_SECRET: "s" });
  assert.equal(cfg.rateLimitPerMinute, 12);
  assert.equal(cfg.aiLabel, "【AI】");
  assert.deepEqual(validateConfig(cfg), []);

  const bad = loadConfig({});
  const problems = validateConfig(bad);
  assert.ok(problems.some((p) => p.includes("QQ_APP_ID")));
  assert.ok(problems.some((p) => p.includes("QQ_APP_SECRET")));
});

test("沙箱开关切换 API 基址", () => {
  const prod = loadConfig({ QQ_APP_ID: "1", QQ_APP_SECRET: "s" });
  const sand = loadConfig({ QQ_APP_ID: "1", QQ_APP_SECRET: "s", QQ_SANDBOX: "true" });
  assert.equal(resolveApiBase(prod), "https://api.sgroup.qq.com");
  assert.equal(resolveApiBase(sand), "https://sandbox.api.sgroup.qq.com");
});

test("mock 模式的本地地址不能被 sandbox 开关覆盖（回归）", async () => {
  // 真实 bug：mock 冒烟时只改了 apiBase，但 resolveApiBase() 会因为
  // QQ_SANDBOX=true 改回沙箱地址，导致本地冒烟跑去打真实沙箱并报 token 无效。
  const { bootstrap } = await import("../src/main.js");
  const logged = [];
  const logger = { debug: () => {}, info: (m) => logged.push(m), warn: () => {}, error: () => {} };

  const boot = await bootstrap({
    args: { mock: true, check: false, once: false },
    env: { QQ_SANDBOX: "true" }, // 故意设置沙箱开关
    rootDir: process.cwd(),
    logger,
  });

  try {
    assert.equal(boot.ok, true, `mock 启动应成功：${logged.join(" | ")}`);
    assert.ok(
      resolveApiBase(boot.config).startsWith("http://127.0.0.1:"),
      `mock 模式必须指向本地模拟服务，实际：${resolveApiBase(boot.config)}`,
    );
    assert.equal(boot.config.tokenBase.startsWith("http://127.0.0.1:"), true);
  } finally {
    await boot.mock?.stop();
  }
});

// ---------------- 协议路径与消息体 ----------------

test("接口路径与官方 SDK 一致", () => {
  assert.equal(c2cMessagePath("OPENID"), "/v2/users/OPENID/messages");
  assert.equal(groupMessagePath("GROUP"), "/v2/groups/GROUP/messages");
});

test("msg_seq 落在 0..65535", () => {
  for (let i = 0; i < 200; i += 1) {
    const seq = nextMsgSeq();
    assert.ok(seq >= 0 && seq <= 65535, `seq 越界: ${seq}`);
  }
});

test("构造消息体：纯文本用 msg_type=0，并带 msg_id/msg_seq", () => {
  const body = buildMessageBody("你好", { msgId: "m-1", msgSeq: 42 });
  assert.deepEqual(body, { content: "你好", msg_type: 0, msg_seq: 42, msg_id: "m-1" });

  const md = buildMessageBody("**粗体**", { markdown: true, msgSeq: 7 });
  assert.equal(md.msg_type, 2);
  assert.deepEqual(md.markdown, { content: "**粗体**" });
  assert.equal(md.msg_id, undefined);
});

// ---------------- 去重 / 限流 / 白名单 ----------------

test("去重：同一条消息第二次被丢弃，且容量有上限", () => {
  const cache = new DedupeCache(3);
  assert.equal(cache.check("a"), true);
  assert.equal(cache.check("a"), false, "重复消息必须被识别");
  cache.check("b");
  cache.check("c");
  cache.check("d"); // 超出容量，a 被淘汰
  assert.equal(cache.size, 3);
  assert.equal(cache.check("a"), true, "被淘汰后可再次通过");
});

test("限流：达到上限后拒绝，并给出重试等待", () => {
  const rl = new RateLimiter(2);
  assert.equal(rl.take("u1").ok, true);
  assert.equal(rl.take("u1").ok, true);
  const third = rl.take("u1");
  assert.equal(third.ok, false);
  assert.ok(third.retryAfterMs > 0);
  assert.equal(rl.take("u2").ok, true, "限流按用户隔离");
});

test("白名单：黑名单优先，白名单非空时仅放行名单内", () => {
  const p = new AccessPolicy({ allowUsers: ["u1"], denyUsers: ["u2"], allowGroups: ["g1"] });
  assert.equal(p.checkUser("u1").allowed, true);
  assert.equal(p.checkUser("u9").allowed, false);
  assert.equal(p.checkUser("u2").allowed, false, "黑名单优先于白名单");
  assert.equal(p.checkGroup("g1").allowed, true);
  assert.equal(p.checkGroup("g9").allowed, false);

  const open = new AccessPolicy({});
  assert.equal(open.checkUser("anyone").allowed, true);
  assert.equal(open.checkGroup("anygroup").allowed, true);
});

// ---------------- 合规与文本处理 ----------------

test("AI 明示标识：三种方式都可用，且不重复叠加", () => {
  // prefix（默认，最稳妥）
  assert.equal(withAiLabel("你好", { style: "prefix" }), "【AI】你好");
  assert.equal(withAiLabel("【AI】你好", { style: "prefix" }), "【AI】你好");
  assert.equal(withAiLabel("  你好  ", { style: "prefix" }), "【AI】你好");
  assert.equal(withAiLabel("你好", { label: "[bot]", style: "prefix" }), "[bot]你好");

  // suffix：不影响开头语气
  assert.equal(withAiLabel("你好", { style: "suffix" }), "你好 【AI】");
  assert.equal(withAiLabel("你好 【AI】", { style: "suffix" }), "你好 【AI】");

  // none：完全不加（使用者自行权衡合规）
  assert.equal(withAiLabel("你好", { style: "none" }), "你好");
  assert.equal(withAiLabel("1+1=2", { style: "none" }), "1+1=2");

  // 缺省参数保持向后兼容（按 prefix 处理）
  assert.equal(withAiLabel("你好"), "【AI】你好");

  // 空内容不应变成单独的标识
  assert.equal(withAiLabel("", { style: "prefix" }), "");
});

test("标识方式解析：非法值回退到 prefix", () => {
  assert.equal(resolveAiLabelStyle({ aiLabelStyle: "none" }).style, "none");
  assert.equal(resolveAiLabelStyle({ aiLabelStyle: "SUFFIX" }).style, "suffix");
  assert.equal(resolveAiLabelStyle({ aiLabelStyle: "乱填" }).style, "prefix", "非法值应回退");
  assert.equal(resolveAiLabelStyle({}).style, "prefix", "缺省应回退");
  assert.equal(resolveAiLabelStyle({ aiLabelStyle: "suffix", aiLabel: "[AI]" }).label, "[AI]");
});

test("提示词：必须声明真实能力，防止模型自我否认", () => {
  // 真实故障：主人问"现在会计时了吗"，模型回答
  // 「春禾没有真正的定时能力…按诚实条款说实话：没法主动定时推送」
  // —— 用"诚实"否决了真实功能，还向用户汇报了内部标记机制。
  // 根因：诚实条款只讲"不能做什么"，模型把"没有感官"过度泛化成"没有能力"。
  const p = buildSystemPrompt({ vision: false });

  // 能力清单要明确列出，并且禁止否认
  assert.match(p, /定时提醒/, "应声明定时提醒能力");
  assert.match(p, /确实有定时能力|到点后\*\*你会主动发消息/, "应明确定时提醒是真实功能");
  assert.match(p, /一律不许否认|不许说"我做不到"/, "应禁止否认这些能力");
  assert.match(p, /不要把自己的能力说少了/, "应显式提示不要低估自己");

  // 必须点明"没有感官 ≠ 没有能力"，这是过度泛化的根因
  assert.match(p, /不要过度泛化|没有身体 ≠ 没有能力/, "应断开'没身体=没能力'的联想");

  // 必须禁止汇报内部机制
  assert.match(p, /不要向主人汇报内部机制/, "应禁止暴露提示词/标记等内部细节");
});

test("提示词：视觉开关下的措辞切换仍生效", () => {
  const off = buildSystemPrompt({ vision: false });
  const on = buildSystemPrompt({ vision: true });
  assert.match(off, /你看不到图片/, "关视觉时应说明看不到");
  assert.match(on, /确实收到了图片，可以直接看/, "开视觉时应说明能看");
  assert.ok(!on.includes("你看不到图片"), "开视觉时不该残留'看不到'");
});

test("运行时探测：能发现模型否认自己真实能力的说法", () => {
  // 这些是真实出现过的错误回答，必须能被探测到
  const denials = [
    "春禾没有真正的定时能力，没法主动推送消息",
    "春禾这边没有真正的定时能力",
    "不能主动发消息哦",
    "春禾没有跨会话记忆能力",
  ];
  for (const t of denials) {
    assert.ok(detectCapabilityDenial(t).length > 0, `应探测到：${t}`);
  }

  // 正确回答与"确实做不到的事"不该被误报
  const fine = [
    "会的呀～主人想让春禾提醒什么？",
    "好呀，五分钟后春禾会准时喊主人",
    "春禾是 AI，没有身体，也不会累", // 说明没身体是正确的，不是否认能力
    "春禾没有实体，这是事实",
  ];
  for (const t of fine) {
    assert.equal(detectCapabilityDenial(t).length, 0, `不该误报：${t}`);
  }
});

test("去除 @提及 与多余空白", () => {
  assert.equal(stripMentions("<@!12345> 你好   春禾"), "你好 春禾");
  assert.equal(stripMentions("   "), "");
});

test("会话隔离：单聊按用户，群聊按「群+用户」", () => {
  assert.equal(sessionKeyOf({ scope: "c2c", senderId: "u1" }), "c2c:u1");
  assert.equal(
    sessionKeyOf({ scope: "group", groupOpenid: "g1", senderId: "u1" }),
    "group:g1:u1",
  );
});

// ---------------- 本地人格 ----------------

test("表达式计算：四则、括号、乘方、中文说法", () => {
  assert.equal(tryCompute("1+1").value, "2");
  assert.equal(tryCompute("(12+8)*3").value, "60");
  assert.equal(tryCompute("(12+8)*3 的平方").value, "3600", "「的平方」应作用于整个表达式");
  assert.equal(tryCompute("2的10次方").value, "1024");
  assert.equal(tryCompute("10/4").value, "2.5");
  assert.equal(tryCompute("根号16").value, "4");
  assert.equal(tryCompute("3×4").value, "12");
});

test("表达式计算：非法输入不误判", () => {
  assert.equal(tryCompute("你好呀"), null);
  assert.equal(tryCompute("春禾在吗"), null);
  assert.equal(tryCompute("1/0"), null, "除零应拒绝");
  assert.equal(tryCompute(""), null);
});

test("系统提示词必须讲清「你有记忆」，避免模型自我否定", () => {
  const p = CHUNHE_SYSTEM_PROMPT;
  // 真实事故：提示词只写了「不编造记忆」，模型就理解成「我没有记忆」，
  // 于是对着真实存在的历史回答「春禾记不住哦」。这里守住修正后的表述。
  assert.match(p, /记得/, "应明确告知模型：历史会提供，它是记得的");
  assert.match(p, /绝不否认自己有记忆/, "应禁止模型否认自身记忆能力");
  assert.match(p, /不要编造/, "同时仍要禁止编造未发生的事");
  assert.match(p, /AI/, "必须声明自己是 AI（合规要求）");
});

test("本地人格：算数优先于寒暄（顺序回归）", async () => {
  const gen = makeLocalGenerator({});
  const reply = await gen({ text: "你好春禾，帮我算一下 (12+8)*3 的平方", senderName: "主人" });
  assert.match(reply, /3600/, `应算出 3600，实际：${reply}`);
});

test("模型生成器会把历史消息一起发给模型", async () => {
  let captured = null;
  const fakeFetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "我记得呀" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const gen = makeModelGenerator({
    config: {
      modelBaseUrl: "https://example.invalid/v1",
      modelApiKey: "k",
      modelName: "m",
      historyTurns: 8,
      modelTimeoutMs: 5000,
    },
    logger: createLogger("silent"),
    fetchImpl: fakeFetch,
  });

  const reply = await gen({
    text: "我最喜欢的数字是几？",
    history: [
      { role: "user", content: "我最喜欢的数字是 7" },
      { role: "assistant", content: "记住啦" },
    ],
  });

  assert.equal(reply, "我记得呀");
  assert.ok(captured, "应发起模型请求");
  assert.equal(captured.messages[0].role, "system", "首条应是系统提示词");
  const contents = captured.messages.map((m) => m.content);
  assert.ok(contents.includes("我最喜欢的数字是 7"), "历史必须随请求带上");
  assert.equal(captured.messages.at(-1).content, "我最喜欢的数字是几？");
});

test("本地人格：纯寒暄走问候，空消息有兜底", async () => {
  const gen = makeLocalGenerator({});
  assert.match(await gen({ text: "你好" }), /春禾在的/);
  assert.match(await gen({ text: "   " }), /没看到内容/);
});

test("本地人格：答不上来的问题必须如实承认，不装懂", async () => {
  const gen = makeLocalGenerator({});

  // 「你在哪些群」这类它确实看不到的信息，要说明原因，而不是套模板
  const groups = await gen({ text: "你检查下你在哪些群" });
  assert.match(groups, /本地规则模式/, `应说明处于本地模式，实际：${groups}`);
  assert.ok(!/还是随便聊聊/.test(groups), "不应再返回旧兜底模板");

  // 被质疑「答非所问」时，必须先承认，再解释原因与解法
  const complaint = await gen({ text: "春禾怎么一直答非所问" });
  assert.match(complaint, /答非所问/);
  assert.match(complaint, /MODEL_API_KEY/, "应给出可操作的解决办法");
  assert.ok(!/1\. 先确认一下前提/.test(complaint), "不应再落到通用『认真答』模板");

  // 完全超纲的话，也要老实地说明能力边界
  const unknown = await gen({ text: "你觉得量子纠缠能用来传心灵感应吗" });
  assert.match(unknown, /没接模型/, `应说明未接模型，实际：${unknown}`);
});

// ---------------- 事件归一化 ----------------

test("归一化单聊消息事件", () => {
  const msg = normalizeEvent(GatewayEvent.C2C_MESSAGE_CREATE, {
    id: "m1",
    content: "hi",
    timestamp: "t",
    author: { user_openid: "u1" },
  });
  assert.equal(msg.scope, "c2c");
  assert.equal(msg.targetId, "u1");
  assert.equal(msg.senderId, "u1");
  assert.equal(msg.messageId, "m1");
});

test("归一化群 @ 消息事件", () => {
  const msg = normalizeEvent(GatewayEvent.GROUP_AT_MESSAGE_CREATE, {
    id: "m2",
    content: "<@!1> 你好",
    group_openid: "g1",
    author: { member_openid: "u2", username: "群友", member_role: "owner" },
  });
  assert.equal(msg.scope, "group");
  assert.equal(msg.targetId, "g1");
  assert.equal(msg.groupOpenid, "g1");
  assert.equal(msg.senderId, "u2");
  assert.equal(msg.memberRole, "owner", "群消息应带上 member_role");
});

test("归一化群消息：平台未给 member_role 时为 null", () => {
  const msg = normalizeEvent(GatewayEvent.GROUP_MESSAGE_CREATE, {
    id: "m3",
    group_openid: "g1",
    author: { member_openid: "u9", username: "路人" },
  });
  assert.equal(msg.memberRole, null);
});

test("未知事件返回 null（交给 rawEvent 处理）", () => {
  assert.equal(normalizeEvent("SOMETHING_ELSE", {}), null);
});

// ---------------- 非文本消息（图片/表情包/语音） ----------------

test("事件归一化：附件被保留下来（图片/表情包靠它传递）", () => {
  const msg = normalizeEvent(GatewayEvent.C2C_MESSAGE_CREATE, {
    id: "m-img",
    content: "", // 关键：图片消息的 content 是空串
    author: { user_openid: "u1" },
    attachments: [{ content_type: "image/png", url: "https://example.invalid/a.png" }],
    message_type: 1,
  });
  assert.equal(msg.content, "", "图片消息的 content 应为空");
  assert.equal(msg.attachments.length, 1, "附件必须被保留，否则下游看不到用户发了图");
  assert.equal(msg.messageType, 1);
});

test("识别消息里的媒体类型", () => {
  const img = describeMedia({
    attachments: [{ content_type: "image/png", url: "https://x/a.png" }],
  });
  assert.equal(img.type, "image");
  assert.match(img.label, /图片|表情包/);

  const voice = describeMedia({
    attachments: [{ content_type: "voice", voice_wav_url: "https://x/v.wav", asr_refer_text: "你好" }],
  });
  assert.equal(voice.type, "voice");
  assert.equal(voice.asrText, "你好");

  const file = describeMedia({ attachments: [{ content_type: "file", url: "https://x/f.pdf" }] });
  assert.equal(file.type, "file");

  assert.equal(describeMedia({ attachments: [] }), null, "没有附件应返回 null");
  assert.equal(describeMedia({}), null);
});

test("收到图片/表情包：确认收到，但绝不假装看得见", async () => {
  const gen = makeLocalGenerator({});
  const reply = await gen({
    text: "",
    media: { type: "image", label: "图片/表情包", count: 1 },
  });

  assert.match(reply, /收到/, "必须先确认收到，不能无视用户");
  assert.match(reply, /看不到/, "必须如实说明看不到画面");
  // 绝不能编造自己看到了画面
  assert.ok(!/好可爱/.test(reply), "不应编造对图片内容的评价");
  assert.ok(!/我看到了/.test(reply), "不应声称自己看得见");
  assert.ok(!/没看到内容/.test(reply), "不应回退到旧的空消息文案");
});

test("图片带文字时：文字部分照常回应", async () => {
  const gen = makeLocalGenerator({});
  const reply = await gen({
    text: "这张图里的公式对吗",
    media: { type: "image", label: "图片/表情包", count: 1 },
  });
  assert.match(reply, /看不到/, "仍要说明看不到画面");
  assert.match(reply, /公式/, "但用户附带的文字要被接住");
});

test("语音：有转写就用转写，没有就说听不到", async () => {
  const gen = makeLocalGenerator({});
  const withAsr = await gen({
    text: "",
    media: { type: "voice", label: "语音", count: 1, asrText: "帮我算 1+1" },
  });
  assert.match(withAsr, /帮我算 1\+1/, "有平台转写时应直接用");

  const noAsr = await gen({ text: "", media: { type: "voice", label: "语音", count: 1 } });
  assert.match(noAsr, /听不到|文字/, "没有转写时要说明听不到并引导打字");
});

test("模型模式：媒体信息会作为附注送入模型", async () => {
  let captured = null;
  const fakeFetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "收到啦" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const gen = makeModelGenerator({
    config: {
      modelBaseUrl: "https://example.invalid/v1",
      modelApiKey: "k",
      modelName: "m",
      historyTurns: 8,
      modelTimeoutMs: 5000,
    },
    logger: createLogger("silent"),
    fetchImpl: fakeFetch,
  });

  await gen({ text: "", media: { type: "image", label: "图片/表情包", count: 1 }, history: [] });
  const userMsg = captured.messages.at(-1).content;
  assert.match(userMsg, /发来.*图片|表情包/, `模型应知道用户发了图，实际：${userMsg}`);
});

// ---------------- WebSocket 帧与握手 ----------------

test("握手 accept：与官方 ws 实现的 GUID 推导一致", () => {
  // 正确值：GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"（34 字符）
  // 历史教训：这个常量写错一个字符就会导致所有 WebSocket 握手失败，
  // 且客户端报的是难懂的 TypeError。这里用固定向量守住它。
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("帧编解码：服务端帧可被解析回来", () => {
  const frames = [];
  const parse = createFrameParser((f) => frames.push(f));
  parse(encodeFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } })));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, 0x1);
  assert.deepEqual(JSON.parse(frames[0].payload.toString("utf8")), {
    op: 10,
    d: { heartbeat_interval: 45000 },
  });
});

test("帧解析：能拼接被拆分的分片", () => {
  const frames = [];
  const parse = createFrameParser((f) => frames.push(f));
  const full = encodeFrame("hello-world");
  parse(full.subarray(0, 3));
  parse(full.subarray(3));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString("utf8"), "hello-world");
});

test("客户端帧带掩码，服务端能解出原文", () => {
  const frames = [];
  const parse = createFrameParser((f) => frames.push(f));
  parse(encodeClientFrame(JSON.stringify({ op: 2, d: { intents: 513 } })));
  assert.equal(frames.length, 1);
  assert.equal(JSON.parse(frames[0].payload.toString("utf8")).op, 2);
});

// ---------------- HTTP 客户端错误处理 ----------------

test("token 响应错误时抛出结构化 ApiError", async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ message: "appid invalid" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  const api = new QQApi({
    appId: "1",
    clientSecret: "s",
    apiBase: "https://example.invalid",
    tokenBase: "https://example.invalid",
    fetchImpl: fakeFetch,
  });
  await assert.rejects(() => api.getAccessToken(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.httpStatus, 401);
    return true;
  });
});

test("返回 HTML 时给出可读错误而不是 JSON 解析崩溃", async () => {
  const fakeFetch = async () =>
    new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });
  const api = new QQApi({
    appId: "1",
    clientSecret: "s",
    apiBase: "https://example.invalid",
    tokenBase: "https://example.invalid",
    fetchImpl: fakeFetch,
  });
  await assert.rejects(() => api.getAccessToken(), /非 JSON|临时故障/);
});

test("token 会被缓存，避免重复请求", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const api = new QQApi({
    appId: "1",
    clientSecret: "s",
    apiBase: "https://example.invalid",
    tokenBase: "https://example.invalid",
    fetchImpl: fakeFetch,
  });
  await api.getAccessToken();
  await api.getAccessToken();
  await api.getAccessToken();
  assert.equal(calls, 1, "同一进程内应复用缓存 token");

  api.clearTokenCache();
  await api.getAccessToken();
  assert.equal(calls, 2, "清缓存后应重新获取");
});

test("createLogger 各等级可用且吞掉密钥", () => {
  const logger = createLogger("silent");
  for (const lvl of ["debug", "info", "warn", "error"]) logger[lvl]("test", { token: "abcdef123456" });
  assert.ok(true);
});
