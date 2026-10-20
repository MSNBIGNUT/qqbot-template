#!/usr/bin/env node
/**
 * 双引擎切换的真机联调（**不会真的切模式**）。
 *
 * 为什么需要它：`spawnBrainSwitch` 用的是真实 child_process.spawn + 真实 cmd/powershell，
 * 单元测试注入的是假 spawn，证明不了"这条链路真的能把脚本跑起来、而且跑得下去"。
 *
 * 这里守住两件事（都是实测真机踩出来的，不测就会再犯）：
 *
 *   1. **脚本真的被执行了**
 *      坑：`spawn(powershell, args, {detached:true})` 在 Windows 上走 DETACHED_PROCESS，
 *      powershell.exe 没有控制台 → **静默退出、一个字节都不执行**，还不报错。
 *      现象：机器人回了「主脑启动中」，然后什么都没发生。
 *
 *   2. **父进程（旧春禾）死掉后脚本还能继续跑**
 *      坑：不加 detached 时，libuv 会建一个 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
 *      的 Job Object 把子进程放进去。旧春禾一被杀 → job 关闭 → 脚本被连带杀掉。
 *      现象：日志停在「已停止旧春禾」，然后两边都不在线。
 *
 * 用法：node scripts/check-brain-switch.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { resolveSwitchScript } from "../src/core/brain-switch.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("info");
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
const WORK = path.join(ROOT, "_brain-check-tmp");
const MARKER = path.join(WORK, "marker.txt");
const STUB = path.join(WORK, "stub-switch.ps1");
const LAUNCHER = path.join(WORK, "launcher.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function readMarker() {
  try {
    return fs.readFileSync(MARKER, "utf8");
  } catch {
    return "";
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(300);
  }
  return false;
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  console.log("1) 默认脚本路径解析");
  const realScript = resolveSwitchScript({});
  console.log(`   ${realScript}`);
  if (path.basename(realScript) !== "switch-brain.ps1") fail("默认路径解析不对");
  if (!fs.existsSync(realScript)) fail(`默认路径不存在：${realScript}`);

  // 桩脚本：先写 START，睡一会儿，再写 SURVIVED。
  // 带 BOM 写：PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解码，中文路径会变乱码。
  const stub = [
    "param([string]$Mode, [int]$DelaySec = 0, [switch]$Force)",
    `$M = '${MARKER}'`,
    `Add-Content -LiteralPath $M -Value ("START Mode=$Mode DelaySec=$DelaySec pid=$PID at " + (Get-Date).ToString('HH:mm:ss')) -Encoding UTF8`,
    "Start-Sleep -Seconds 6",
    `Add-Content -LiteralPath $M -Value ("SURVIVED after-parent-exit pid=$PID at " + (Get-Date).ToString('HH:mm:ss')) -Encoding UTF8`,
    "",
  ].join("\r\n");
  fs.writeFileSync(STUB, "\uFEFF" + stub, "utf8");

  // 启动器：模拟"旧春禾"——用真实 spawnBrainSwitch 拉起脚本，然后**立刻退出**。
  // 父进程退出会让 libuv 的 job 句柄关闭；如果脚本在 job 里，它就会被一起杀掉。
  const moduleUrl = pathToFileURL(path.join(ROOT, "src", "core", "brain-switch.js")).href;
  fs.writeFileSync(
    LAUNCHER,
    [
      `import { spawnBrainSwitch } from ${JSON.stringify(moduleUrl)};`,
      `const r = spawnBrainSwitch({ target: "brain", scriptPath: process.argv[2] });`,
      `console.log(JSON.stringify(r));`,
      "",
    ].join("\n"),
    "utf8",
  );

  console.log("2) 模拟旧春禾：真实 spawn 拉起脚本，父进程随即退出");
  const launched = spawnSync(process.execPath, [LAUNCHER, STUB], { encoding: "utf8", timeout: 30000 });
  const launchedLine = (launched.stdout || "").trim();
  console.log(`   启动器输出：${launchedLine}`);
  if (launched.status !== 0) fail(`启动器异常退出：status=${launched.status} ${launched.stderr}`);
  if (!launchedLine.includes('"ok":true')) fail(`spawn 失败：${launchedLine}`);

  console.log("3) 等脚本开始执行（父进程已经没了）");
  if (!(await waitFor(() => readMarker().includes("START"), 20000))) {
    fail(
      "20 秒内脚本没有执行 —— 参数组合在这台机器上跑不起来 powershell。\n" +
        "   最可能的原因：直接 spawn powershell 时用了 detached:true（DETACHED_PROCESS 下会静默退出）。",
    );
  }
  console.log(`   ${readMarker().split(/\r?\n/)[0]}`);

  console.log("4) 等 SURVIVED（证明没有被 kill-on-close 的 Job Object 带走）");
  if (!(await waitFor(() => readMarker().includes("SURVIVED"), 25000))) {
    fail(
      "脚本起了个头就没了 —— 它被放进了一个 kill-on-close 的 Job Object。\n" +
        "   最可能的原因：spawn 时没有 detached:true（或没有用 cmd /c start 包一层）。\n" +
        "   真机后果：切到主脑时脚本会停在「已停止旧春禾」，然后两边都不在线。",
    );
  }
  console.log(`   ${readMarker().split(/\r?\n/).filter(Boolean).pop()}`);

  const text = readMarker();
  if (!text.includes("Mode=brain")) fail(`-Mode 没传对：${text}`);

  console.log("\n✅ 真机链路通过：脚本能跑起来、参数正确、且父进程死掉后仍继续执行");
  // 清理失败不算失败：刚分离出去的 powershell 可能还短暂持有桩脚本的文件句柄（Windows 上 rm 会 EPERM）
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* 下次运行会自己重建 */
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    console.error("联调脚本自身出错：", err);
    process.exitCode = 1;
  });
