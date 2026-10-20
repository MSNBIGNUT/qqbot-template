/**
 * 端到端测试：真实建立 WebSocket 连接 + 真实 HTTP 调用（打到本地模拟网关）。
 *
 * 覆盖的是「协议链路」而不是「函数返回值」：
 *   HELLO → IDENTIFY → READY → 事件下发 → 处理 → HTTP 发送 → 服务端收到
 * 以及去重、白名单、限流、群聊路由、心跳、断线会话恢复。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockQQServer } from "../src/mock/server.js";
import { QQApi } from "../src/qq/api.js";
import { QQGateway } from "../src/qq/gateway.js";
import { MessageEngine } from "../src/core/engine.js";
import { makeLocalGenerator } from "../src/persona/chunhe.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");

function waitFor(predicate, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      let ok = false;
      try {
        ok = Boolean(predicate());
      } catch {
        ok = false;
      }
      if (ok) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一套「模拟网关 + API + 网关客户端 + 引擎」 */
async function startStack({ env = {}, heartbeatInterval = 250 } = {}) {
  const mock = await new MockQQServer({ heartbeatInterval }).start();
  const config = loadConfig({
    QQ_APP_ID: mock.expectedAppId,
    QQ_APP_SECRET: mock.expectedSecret,
    // 临时记忆文件：群注册表/主动消息配额会跟着落盘到同目录，
    // 否则端到端测试会在线上 data/ 里留下假的 groups.json
    QQ_MEMORY_FILE: path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-e2e-")),
      "memory.json",
    ),
    // 显式开启 AI 标识，让这几条端到端断言验证"标识机制"本身，
    // 而不是依赖默认值（默认已改为 none，由 .env 决定）
    AI_LABEL_STYLE: "prefix",
    ...env,
  });

  const api = new QQApi({
    appId: config.appId,
    clientSecret: config.clientSecret,
    apiBase: mock.baseUrl,
    tokenBase: mock.baseUrl,
    logger,
  });

  const engine = new MessageEngine({
    config,
    api,
    generate: makeLocalGenerator({ logger }),
    logger,
  });

  const sessionFile = path.join(os.tmpdir(), `qqbot-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const gateway = new QQGateway({
    getAccessToken: () => api.getAccessToken(),
    getGatewayUrl: () => api.getGatewayUrl(),
    intents: config.intents,
    onInvalidToken: () => api.clearTokenCache(),
    onMessage: (msg) => engine.handle(msg),
    sessionFile,
    logger,
  });

  const running = gateway.start();
  const connected = await waitFor(() => mock.connectedClients.length > 0, 6000);
  assert.ok(connected, "机器人应连上模拟网关");

  return {
    mock,
    config,
    api,
    engine,
    gateway,
    sessionFile,
    async stop() {
      gateway.stop();
      await mock.stop();
      try {
        fs.rmSync(sessionFile, { force: true });
      } catch {
        /* 忽略 */
      }
      await sleep(60);
      await Promise.race([running, sleep(300)]);
    },
  };
}

test("端到端：单聊消息 → 生成回复 → 通过 HTTP 发出", async (t) => {
  const s = await startStack();
  t.after(() => s.stop());

  assert.equal(s.mock.clientPayloads.some((p) => p.op === 2), true, "应发送过 IDENTIFY");
  const identify = s.mock.clientPayloads.find((p) => p.op === 2);
  assert.match(identify.d.token, /^QQBot\s+\S+/, "IDENTIFY token 必须是 'QQBot xxx' 格式");
  assert.equal(identify.d.shard[0], 0);

  s.mock.pushC2C({ content: "你好春禾，帮我算一下 (12+8)*3 的平方", msgId: "e2e-1" });
  const ok = await waitFor(() => s.mock.sentMessages.length >= 1, 6000);
  assert.ok(ok, "应收到机器人的回复");

  const sent = s.mock.sentMessages[0];
  assert.equal(sent.scope, "c2c");
  assert.equal(sent.targetId, "user-openid-1");
  assert.equal(sent.body.msg_type, 0, "纯文本消息 msg_type 应为 0");
  assert.equal(sent.body.msg_id, "e2e-1", "被动回复必须带 msg_id");
  assert.ok(Number.isFinite(sent.body.msg_seq), "必须带 msg_seq");
  assert.match(sent.body.content, /^【AI】/, "开启 prefix 时回复应带 AI 明示标识");
  assert.match(sent.body.content, /3600/, `应算出 3600，实际：${sent.body.content}`);
  assert.equal(s.mock.requests.sendC2C, 1);
});

test("端到端：重复推送同一条消息只回复一次", async (t) => {
  const s = await startStack();
  t.after(() => s.stop());

  // 模拟网关重推：同一个 msgId 连发三次
  s.mock.pushC2C({ content: "1+1", msgId: "dup-1" });
  s.mock.pushC2C({ content: "1+1", msgId: "dup-1" });
  s.mock.pushC2C({ content: "1+1", msgId: "dup-1" });

  await waitFor(() => s.mock.sentMessages.length >= 1, 6000);
  await sleep(400); // 给后续重复留出处理时间

  assert.equal(s.mock.sentMessages.length, 1, "重复消息不应重复回复");
  assert.equal(s.engine.stats.duplicate, 2, "应记录 2 条重复");
  assert.equal(s.engine.stats.replied, 1);
});

test("端到端：白名单之外的用户被静默拒绝", async (t) => {
  const s = await startStack({ env: { QQ_ALLOW_FROM: "only-this-user" } });
  t.after(() => s.stop());

  s.mock.pushC2C({ content: "你好", openid: "stranger", msgId: "wl-1" });
  await sleep(500);

  assert.equal(s.mock.sentMessages.length, 0, "非白名单用户不应收到回复");
  assert.equal(s.engine.stats.denied, 1);
  assert.equal(s.mock.requests.sendC2C, 0, "不应发起任何发送请求");

  // 白名单内的用户可以正常使用
  s.mock.pushC2C({ content: "你好", openid: "only-this-user", msgId: "wl-2" });
  const ok = await waitFor(() => s.mock.sentMessages.length >= 1, 6000);
  assert.ok(ok, "白名单用户应收到回复");
});

test("端到端：超过每分钟上限后不再回复", async (t) => {
  const s = await startStack({ env: { QQ_RATE_LIMIT_PER_MINUTE: "2" } });
  t.after(() => s.stop());

  for (let i = 1; i <= 4; i += 1) {
    s.mock.pushC2C({ content: `${i}+${i}`, msgId: `rl-${i}` });
    await sleep(120);
  }
  await sleep(500);

  assert.equal(s.engine.stats.replied, 2, "只应回复限流额度内的 2 条");
  assert.equal(s.engine.stats.rateLimited, 2, "后 2 条应被限流");
  assert.equal(s.mock.requests.sendC2C, 2);
});

test("端到端：群聊消息走群接口，目标为 group_openid", async (t) => {
  const s = await startStack({ env: { QQ_ALLOW_GROUPS: "group-openid-1" } });
  t.after(() => s.stop());

  s.mock.pushGroupAt({ content: "<@!100> 3的平方", groupOpenid: "group-openid-1", msgId: "g-1" });
  const ok = await waitFor(() => s.mock.sentMessages.length >= 1, 6000);
  assert.ok(ok, "群消息应触发回复");

  const sent = s.mock.sentMessages[0];
  assert.equal(sent.scope, "group");
  assert.equal(sent.targetId, "group-openid-1");
  assert.match(sent.body.content, /9/, "@提及应被剥离并算出 9");
  assert.equal(s.mock.requests.sendGroup, 1);
  assert.equal(s.mock.requests.sendC2C, 0);
});

test("端到端：群不在白名单时不回复", async (t) => {
  const s = await startStack({ env: { QQ_ALLOW_GROUPS: "allowed-group" } });
  t.after(() => s.stop());

  s.mock.pushGroupAt({ content: "1+1", groupOpenid: "other-group", msgId: "g-2" });
  await sleep(500);

  assert.equal(s.mock.sentMessages.length, 0);
  assert.equal(s.engine.stats.denied, 1);
});

test("端到端：按 heartbeat_interval 周期性发送心跳", async (t) => {
  const s = await startStack({ heartbeatInterval: 150 });
  t.after(() => s.stop());

  const ok = await waitFor(
    () => s.mock.clientPayloads.filter((p) => p.op === 1).length >= 2,
    4000,
  );
  assert.ok(ok, "应至少发送 2 次心跳");
  assert.ok(s.gateway.stats.heartbeats >= 2);
});

test("端到端：断线后重连发送 RESUME 复用会话", async (t) => {
  const s = await startStack();
  t.after(() => s.stop());

  // 首次连接后会话应已落盘
  const ok = await waitFor(() => fs.existsSync(s.sessionFile), 4000);
  assert.ok(ok, "READY 后应写入会话文件");
  const saved = JSON.parse(fs.readFileSync(s.sessionFile, "utf8"));
  assert.ok(saved.sessionId, "会话文件应包含 session_id");

  const resumesBefore = s.mock.clientPayloads.filter((p) => p.op === 6).length;
  s.mock.dropConnections();

  const resumed = await waitFor(
    () => s.mock.clientPayloads.filter((p) => p.op === 6).length > resumesBefore,
    8000,
  );
  assert.ok(resumed, "断线重连后应发送 RESUME 而不是重新 IDENTIFY");

  const resume = s.mock.clientPayloads.filter((p) => p.op === 6).pop();
  assert.equal(resume.d.session_id, saved.sessionId, "RESUME 应带上已保存的 session_id");
  assert.ok(Number.isFinite(resume.d.seq), "RESUME 应带上 seq");
});

test("端到端：未知事件类型不导致崩溃", async (t) => {
  const s = await startStack();
  t.after(() => s.stop());

  s.mock.pushEvent("GUILD_CREATE", { id: "g", name: "某频道" });
  s.mock.pushEvent("FRIEND_ADD", { openid: "u" });
  await sleep(300);

  // 之后仍能正常处理消息
  s.mock.pushC2C({ content: "2+2", msgId: "after-unknown" });
  const ok = await waitFor(() => s.mock.sentMessages.length >= 1, 6000);
  assert.ok(ok, "未知事件后仍应正常工作");
  assert.match(s.mock.sentMessages[0].body.content, /4/);
});

test("端到端：收到图片消息时如实回应，不假装看得见", async (t) => {
  const s = await startStack();
  t.after(() => s.stop());

  // 构造一条「只有图片、没有文字」的单聊消息（content 为空 + attachments）
  const delivered = s.mock.pushEvent("C2C_MESSAGE_CREATE", {
    id: "img-1",
    content: "",
    timestamp: new Date().toISOString(),
    author: { user_openid: "user-openid-1" },
    attachments: [{ content_type: "image/png", url: "https://example.invalid/emoji.png" }],
    message_type: 1,
  });
  assert.ok(delivered > 0, "事件应已投递给机器人");

  const ok = await waitFor(() => s.mock.sentMessages.length >= 1, 6000);
  assert.ok(ok, "收到图片后必须有回应（不能让用户觉得被无视）");

  const content = s.mock.sentMessages[0].body.content ?? "";
  assert.match(content, /^【AI】/, "开启 prefix 时仍要带 AI 标识");
  assert.match(content, /收到/, "应确认收到");
  assert.match(content, /看不到/, "应如实说明看不到画面");
  assert.ok(!/好可爱|我看到了/.test(content), `不能编造看得见画面，实际：${content}`);
});

test("端到端：token 只请求一次（缓存生效）", async (t) => {
  const s = await startStack();
  t.after(() => s.stop());

  s.mock.pushC2C({ content: "1+1", msgId: "c-1" });
  s.mock.pushC2C({ content: "2+2", msgId: "c-2" });
  await waitFor(() => s.mock.sentMessages.length >= 2, 6000);

  assert.equal(s.mock.requests.token, 1, "多次调用应复用缓存的 access_token");
});
