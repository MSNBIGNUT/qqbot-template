#!/usr/bin/env node
/**
 * 「春禾启动主脑」触发链路的**真机**联调（会真的切换模式！）。
 *
 * 用途：在没有真人在 QQ 上打字的情况下，把旧春禾引擎那条链路完整跑一遍 ——
 *   真实 MessageEngine → 真实回复文本 → 真实 spawnBrainSwitch → 真实 switch-brain.ps1
 * 唯一被替换掉的是 QQ 发送那一步（用 stub api），因为被动回复需要真实 msg_id。
 *
 * ⚠️ 默认是 **dry-run**（用桩脚本，不真切换）。
 *    要真切换必须显式加 --live：
 *      node scripts/check-brain-trigger.mjs          # 干跑，安全
 *      node scripts/check-brain-trigger.mjs --live   # 真切换（约 40 秒内两边都没人应答）
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { loadConfig, parseDotenv } from "../src/config.js";
import { MessageEngine } from "../src/core/engine.js";
import { resolveSwitchScript } from "../src/core/brain-switch.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("info");
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
const LIVE = process.argv.includes("--live");
const WORK = path.join(ROOT, "_brain-check-tmp");
const MARKER = path.join(WORK, "trigger-marker.txt");
const STUB = path.join(WORK, "stub-switch.ps1");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnvFile() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return {};
  try {
    return parseDotenv(fs.readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.rmSync(MARKER, { force: true });

  // 注意：只用 .env 里跟人格/记忆有关的配置；不连 QQ、不发消息。
  const config = loadConfig({ ...loadEnvFile() });
  // 记忆/话题/提醒全部落到临时目录，绝不碰 data\ 下的真实文件
  config.memoryFile = path.join(WORK, "memory.json");
  config.topicFile = path.join(WORK, "topics.json");
  config.reminderFile = path.join(WORK, "reminders.json");

  const scriptPath = LIVE ? resolveSwitchScript(config) : STUB;
  if (!LIVE) {
    const stub = [
      "param([string]$Mode, [int]$DelaySec = 0, [switch]$Force)",
      `Add-Content -LiteralPath '${MARKER}' -Value ("TRIGGER Mode=$Mode pid=$PID") -Encoding UTF8`,
      "Start-Sleep -Seconds 6",
      `Add-Content -LiteralPath '${MARKER}' -Value ("TRIGGER-SURVIVED pid=$PID") -Encoding UTF8`,
      "",
    ].join("\r\n");
    fs.writeFileSync(STUB, "\uFEFF" + stub, "utf8");
  }

  console.log(`模式：${LIVE ? "LIVE（会真的切换）" : "dry-run（桩脚本，不会切换）"}`);
  console.log(`脚本：${scriptPath}`);

  const sent = [];
  const api = {
    sendMessage: async (scope, targetId, text) => {
      sent.push({ scope, targetId, text, at: Date.now() });
      logger.info(`[stub-api] 已"发出"回复：${text}`);
      return { id: `stub-${sent.length}` };
    },
  };

  const engine = new MessageEngine({
    config,
    api,
    generate: async () => "（不该走到人格层）",
    logger,
    // ⚠️ 必须显式注入 scriptPath，否则引擎会用 resolveSwitchScript() 找到**真实脚本**，
    // dry-run 就变成真切换了（这个坑真的踩过：本想干跑，结果把主脑切过去了）。
    brainSwitch: { scriptPath },
  });

  const msg = {
    kind: "c2c",
    scope: "c2c",
    rawEventType: "C2C_MESSAGE_CREATE",
    senderId: "A8E33141EE50B07F21C79D108D9BACBD",
    senderName: "主人",
    content: "春禾启动主脑",
    messageId: "check-trigger-1",
    targetId: "A8E33141EE50B07F21C79D108D9BACBD",
    attachments: [],
  };

  console.log("\n1) 丢一条「春禾启动主脑」进真实引擎");
  const result = await engine.handle(msg);
  console.log(`   引擎返回：${JSON.stringify(result)}`);
  if (result.action !== "replied") {
    console.error("❌ 没有回复 —— 触发词没命中？");
    process.exit(1);
  }
  console.log(`   回复内容：${sent.map((s) => s.text).join(" | ")}`);
  if (!/主脑/.test(sent[0]?.text ?? "")) {
    console.error("❌ 回复里没有提到主脑");
    process.exit(1);
  }

  console.log("2) 等切换脚本被执行 + 活过父进程（本进程即将退出）");
  if (!LIVE) {
    const deadline = Date.now() + 20000;
    let text = "";
    while (Date.now() < deadline) {
      if (fs.existsSync(MARKER)) {
        text = fs.readFileSync(MARKER, "utf8");
        if (text.includes("TRIGGER-SURVIVED")) break;
      }
      await sleep(400);
    }
    console.log(`   标记：${text.trim().split(/\r?\n/).join(" / ") || "(空)"}`);
    if (!text.includes("Mode=brain")) {
      console.error("❌ 脚本没被执行，或者 -Mode 不对");
      process.exit(1);
    }
    if (!text.includes("TRIGGER-SURVIVED")) {
      console.error("❌ 脚本没活过父进程退出（Job Object / detached 问题）");
      process.exit(1);
    }
    console.log("\n✅ 触发链路通过：先回复 → 再执行脚本 → 脚本活过引擎自身退出");
  } else {
    console.log("   已切到真实脚本；脚本会停掉/替换引擎，本进程随即可退出。");
    console.log("   看 C:\\大肥鱼的小宝库\\_brain-switch.log 确认结果。");
    await sleep(2000);
  }

  // 清理失败不算失败：分离出去的 powershell 可能还短暂持有桩脚本文件句柄（EPERM）
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* 下次运行会自己重建 */
  }
  try {
    engine.flushMemory();
  } catch {
    /* 忽略 */
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
