/**
 * 重连的集成测试：真实 WebSocket 抖动 + 网关地址缓存 + 退避节奏。
 *
 * 退避的精确序列由 reconnect-policy.test.js 用纯逻辑保证；
 * 这里只验证"接线是否正确"（策略被调用、地址被缓存、状态被更新）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MockQQServer } from "../src/mock/server.js";
import { QQApi } from "../src/qq/api.js";
import { QQGateway } from "../src/qq/gateway.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(predicate, timeoutMs = 4000, intervalMs = 20) {
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

/** 起 mock 服务 + 网关；sleep 被替换成「记录但几乎不等」 */
async function makeGateway({ heartbeatInterval = 45000 } = {}) {
  const mock = await new MockQQServer({ heartbeatInterval }).start();
  const api = new QQApi({
    appId: mock.expectedAppId,
    clientSecret: mock.expectedSecret,
    apiBase: mock.baseUrl,
    tokenBase: mock.baseUrl,
    logger,
  });

  const sleeps = [];
  const gateway = new QQGateway({
    getAccessToken: () => api.getAccessToken(),
    getGatewayUrl: () => api.getGatewayUrl(),
    intents: 1 << 25,
    onMessage: () => {},
    sessionFile: null,
    logger,
    sleep: (ms) => {
      sleeps.push(ms);
      return sleepReal(15);
    },
  });

  return { mock, api, gateway, sleeps };
}

test("网关地址只请求一次，重连时复用缓存", async (t) => {
  const { mock, gateway } = await makeGateway();
  t.after(async () => {
    gateway.stop();
    await mock.stop();
  });

  gateway.start();
  assert.ok(await waitFor(() => mock.connectedClients.length > 0), "应先连上");
  assert.equal(mock.requests.gateway, 1, "首次连接应请求一次 /gateway");

  for (let i = 0; i < 3; i += 1) {
    mock.dropConnections();
    await waitFor(() => mock.connectedClients.length > 0, 4000);
  }

  assert.equal(
    mock.requests.gateway,
    1,
    `重连不应重复请求 /gateway（实际 ${mock.requests.gateway} 次，会被平台限流）`,
  );
});

test("抖动过程中退避被真正拉长（不在 1s 原地踏步）", async (t) => {
  const { mock, gateway, sleeps } = await makeGateway();
  t.after(async () => {
    gateway.stop();
    await mock.stop();
  });

  gateway.start();
  assert.ok(await waitFor(() => mock.connectedClients.length > 0), "应先连上");

  for (let i = 0; i < 5; i += 1) {
    mock.dropConnections();
    await waitFor(() => mock.connectedClients.length > 0, 5000);
  }

  assert.ok(sleeps.length >= 3, `应记录到退避等待，实际 ${sleeps.length} 次：${sleeps}`);
  // 真实事故的回归点：退避必须随断开次数增长，而不是永远 1000
  assert.ok(
    sleeps.filter((ms) => ms > 1000).length >= 2,
    `退避应真正增长过（不止一次 1s），实际：${sleeps}`,
  );
  assert.ok(
    sleeps.some((ms) => ms >= 5000),
    `连续断开必须出现长退避（≥5s），实际：${sleeps}`,
  );
  assert.ok(
    mock.requests.gateway <= 2,
    `整体不应反复请求 /gateway，实际 ${mock.requests.gateway} 次`,
  );
});

test("收到 4902 关闭码时按 5 秒退避重连", async (t) => {
  const { mock, gateway, sleeps } = await makeGateway();
  t.after(async () => {
    gateway.stop();
    await mock.stop();
  });

  gateway.start();
  assert.ok(await waitFor(() => mock.connectedClients.length > 0), "应先连上");

  // close code 4902 = 0x1326
  for (const client of [...mock.openSockets]) {
    try {
      client.socket.write(Buffer.from([0x88, 0x02, 0x13, 0x26]));
    } catch {
      /* 忽略 */
    }
  }

  await waitFor(() => sleeps.length > 0, 4000);
  assert.ok(sleeps.length > 0, "应触发重连等待");
  assert.equal(sleeps[0], 5000, `4902 应等 5s，实际 ${sleeps[0]}ms`);
});

test("鉴权失败（4004）后重新获取网关地址", async (t) => {
  const { mock, gateway } = await makeGateway();
  t.after(async () => {
    gateway.stop();
    await mock.stop();
  });

  gateway.start();
  assert.ok(await waitFor(() => mock.connectedClients.length > 0), "应先连上");
  const before = mock.requests.gateway;

  // close code 4004 = 0x0FA4
  for (const client of [...mock.openSockets]) {
    try {
      client.socket.write(Buffer.from([0x88, 0x02, 0x0f, 0xa4]));
    } catch {
      /* 忽略 */
    }
  }

  await waitFor(() => mock.requests.gateway > before, 4000);
  assert.ok(mock.requests.gateway > before, "鉴权失败后应重新请求 /gateway");
});
