/**
 * 重连策略状态机测试（纯逻辑，不依赖网络，毫秒级）。
 *
 * 这些测试是为了守住一个真实事故：
 * 退避梯度因为状态推进位置不对，永远停在 1 秒，导致「能连上但反复被踢」时
 * 形成重连风暴并触发平台接口限流。当时靠猜改了三次都没对，
 * 抽成纯状态机后才一次看清。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ReconnectPolicy,
  RECONNECT_DELAYS,
  RATE_LIMIT_DELAY,
  MAX_QUICK_DISCONNECTS,
  STABLE_RESET_MS,
  QUICK_DISCONNECT_THRESHOLD_MS,
  classifyClose,
} from "../src/qq/reconnect-policy.js";

test("官方退避序列逐级递进，不在 1s 原地踏步", () => {
  const p = new ReconnectPolicy();
  const seq = [];
  for (let i = 0; i < 6; i += 1) {
    seq.push(p.nextDelayMs()); // 本次重连应等待多久
    p.recordClose({ aliveMs: 10_000 }); // 断开一次，梯度推进
  }
  assert.deepEqual(seq, [1000, 2000, 5000, 10000, 30000, 60000]);
});

test("长时间反复断开后退避停在最大值，不会回退", () => {
  const p = new ReconnectPolicy();
  for (let i = 0; i < 20; i += 1) p.recordClose({ aliveMs: 10_000 });
  assert.equal(p.nextDelayMs(), 60000);
  assert.equal(p.attempts, 20);
  assert.ok(p.isExhausted() === false, "20 次未达上限");

  for (let i = 0; i < 100; i += 1) p.recordClose({ aliveMs: 10_000 });
  assert.equal(p.isExhausted(), true, "超过 100 次应判定耗尽");
});

test("关闭码强制延迟优先，且只作用于紧接着的一次", () => {
  const p = new ReconnectPolicy();
  p.recordClose({ aliveMs: 2000, delayOverride: 5000 });
  assert.equal(p.consumeDelay(), 5000, "4902 应强制等 5s");
  assert.equal(p.consumeDelay(), 2000, "强制延迟不应残留到下下次（梯度已推进到 2s）");
});

test("强制延迟不会缩短梯度（取较大者）", () => {
  const p = new ReconnectPolicy();
  // 连续推进到梯度较大时
  for (let i = 0; i < 4; i += 1) p.recordClose({ aliveMs: 10_000 });
  assert.equal(p.nextDelayMs(), 30000);
  p.recordClose({ aliveMs: 10_000, delayOverride: 5000 });
  assert.equal(p.nextDelayMs(), 60000, "应取梯度值而非被 5s 拉低");
});

test("连续快速断开触发长冷却，遏制重连风暴", () => {
  const p = new ReconnectPolicy();
  const seq = [];
  for (let i = 0; i < 6; i += 1) {
    p.recordClose({ aliveMs: 100 }); // 每次只活 0.1 秒
    seq.push(p.nextDelayMs());
  }
  assert.ok(
    seq.every((ms) => ms >= 1000),
    `不应低于 1s：${seq}`,
  );
  assert.ok(
    seq.some((ms) => ms >= 10000),
    `连续 ${MAX_QUICK_DISCONNECTS} 次快速断开必须触发 ≥10s 冷却，实际：${seq}`,
  );
});

test("稳定在线超过阈值后复位梯度", () => {
  const p = new ReconnectPolicy();
  for (let i = 0; i < 3; i += 1) p.recordClose({ aliveMs: 10_000 });
  assert.ok(p.attempts > 0);

  p.recordClose({ aliveMs: STABLE_RESET_MS + 1 });
  assert.equal(p.attempts, 0, "稳定在线后应从头开始");
  assert.equal(p.nextDelayMs(), 1000);
});

test("恰好达到快速断开阈值的连接不算快速断开", () => {
  const p = new ReconnectPolicy();
  p.recordClose({ aliveMs: QUICK_DISCONNECT_THRESHOLD_MS });
  assert.equal(p.quickDisconnects, 0, "存活 >= 5s 不应计入快速断开");
});

test("关闭码分类覆盖关键分支", () => {
  assert.deepEqual(classifyClose(4004), { refreshToken: true, clearSession: true, refreshUrl: true });
  assert.equal(classifyClose(4006).clearSession, true);
  assert.equal(classifyClose(4007).clearSession, true);
  assert.equal(classifyClose(4008).delay, RATE_LIMIT_DELAY);
  assert.equal(classifyClose(4009).clearSession, true);
  assert.equal(classifyClose(4902).delay, 5000, "4902 应明确等 5s");
  assert.equal(classifyClose(4901).delay, 5000);
  assert.equal(classifyClose(4914).fatal, true, "intents 越权应停止重连");
  assert.equal(classifyClose(4915).fatal, true);
  assert.deepEqual(classifyClose(1000), {}, "正常关闭走默认退避");
  assert.deepEqual(classifyClose(1006), {});
});

test("退避序列与官方 [1s,2s,5s,10s,30s,60s] 一致", () => {
  assert.deepEqual(RECONNECT_DELAYS, [1000, 2000, 5000, 10000, 30000, 60000]);
});
