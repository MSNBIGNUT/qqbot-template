#!/usr/bin/env node
/**
 * 春禾 · QQ 机器人入口。
 *
 * 用法：
 *   node src/main.js --check            只做配置与环境自检（不连接）
 *   node src/main.js --mock --once      本地模拟网关跑一条消息后退出（冒烟）
 *   node src/main.js --mock             本地模拟网关长跑（无凭证联调）
 *   node src/main.js                    连接真实 QQ 开放平台
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { loadConfig, parseDotenv, validateConfig, resolveApiBase, describeIntents, missingKeyIntents } from "./config.js";
import { createLogger } from "./util/log.js";
import { QQApi } from "./qq/api.js";
import { QQGateway } from "./qq/gateway.js";
import { OneBotClient } from "./qq/onebot/client.js";
import { OneBotApiAdapter } from "./qq/onebot/api-adapter.js";
import { OneBotGateway } from "./qq/onebot/gateway.js";
import { MessageEngine } from "./core/engine.js";
import { ProactiveScheduler } from "./core/proactive.js";
import { MockQQServer } from "./mock/server.js";
import { botName, setBotName } from "./persona/naming.js";
import { loadPersona } from "./persona/index.js";

/** 读取项目根目录的 .env（若存在），不覆盖已有环境变量 */
function loadDotenvFile(rootDir) {
  const file = path.join(rootDir, ".env");
  if (!fs.existsSync(file)) return {};
  try {
    return parseDotenv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    mock: argv.includes("--mock"),
    once: argv.includes("--once"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

/** 把「其他事件」压缩成一行可读摘要，用于诊断 */
function summarizeRawEvent(type, data) {
  if (!data || typeof data !== "object") return "";
  const d = data;
  const bits = [];
  // ID 打完整：排查群/用户白名单时需要复制它
  if (d.group_openid) bits.push(`group_openid=${d.group_openid}`);
  if (d.author?.member_openid) bits.push(`member_openid=${d.author.member_openid}`);
  if (d.author?.username) bits.push(`name=${d.author.username}`);
  if (typeof d.content === "string" && d.content) bits.push(`content=${JSON.stringify(d.content.slice(0, 24))}`);
  if (d.channel_id) bits.push(`channel_id=${d.channel_id}`);
  if (d.guild_id) bits.push(`guild_id=${d.guild_id}`);
  return bits.join(" ");
}

function printHelp() {
  console.log(`${botName()} · QQ 机器人适配层

  node src/main.js --check          配置自检
  node src/main.js --mock --once    本地模拟网关冒烟（无需凭证）
  node src/main.js --mock           本地模拟网关联调
  node src/main.js                  连接真实 QQ 开放平台

环境变量（务必用环境变量或 .env，不要把密钥写进代码）：
  QQ_APP_ID / QQ_APP_SECRET        机器人凭证（必需）
  BOT_NAME=团子                    机器人自称（人格文件里的名字优先）
  PERSONA=default                  人格：chunhe（示例）/ default（通用）/ ./你的文件.js
  QQ_SANDBOX=true                  使用沙箱环境 API
  QQ_ALLOW_FROM=openid1,openid2    只允许这些用户（空=不限制，仅调试）
  QQ_ALLOW_GROUPS=group1,group2    只允许这些群
  QQ_RATE_LIMIT_PER_MINUTE=12      每用户每分钟回复上限
  MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME   OpenAI 兼容模型（可选）
  AI_LABEL=【AI】                   AI 明示标识（不可移除）
  LOG_LEVEL=info`);
}

/** 组装运行环境；mock 模式下替换为本地模拟服务 */
export async function bootstrap({ args, env, rootDir, logger }) {
  const overrides = loadDotenvFile(rootDir);
  const mergedEnv = { ...env, ...overrides };
  const config = loadConfig(mergedEnv);

  let mock = null;
  if (args.mock) {
    mock = await new MockQQServer().start();
    config.appId = "102000001";
    config.clientSecret = "mock-secret-value";
    // 关键：mock 模式下 apiBase 必须是本地模拟服务。
    // 只改 apiBase 还不够——resolveApiBase() 会在 sandbox=true 时改回沙箱地址，
    // 所以这里必须同时关掉 sandbox（真实踩过的 bug：mock 冒烟跑去打真沙箱）。
    config.sandbox = false;
    config.apiBase = mock.baseUrl;
    config.tokenBase = mock.baseUrl;
    config.sessionFile = path.join(rootDir, "data", "mock-session.json");
    // 冒烟测试只验证"一条进一条出"，分段会让服务提前关闭导致后续分段失败。
    // 保持链路断言简单可预期。
    if (args.once) config.multiMessage = false;
  }

  // 自检模式不连接、不强制要凭证，只把「有什么、缺什么」列清楚
  const problems = validateConfig(config, { requireCredentials: !args.mock && !args.check });
  if (problems.length && !args.check) {
    logger.error(`配置有问题：\n  - ${problems.join("\n  - ")}`);
    return { ok: false, problems, config, mock };
  }

  // 人格模块：PERSONA=chunhe（默认）/ default / ./my-bot.js。
  // 找不到会直接抛错并列出可选项——换人格失败必须当场暴露，不能静默用回示例人格。
  // rootDir 用项目根：PERSONA 里的相对路径都相对它解析。
  const persona = await loadPersona(config.persona, { rootDir, logger });
  // BOT_NAME 没显式配置时，用「人格文件里的名字」当兜底（default 人格 → 小助手）。
  if (!config.botNameExplicit && persona.PERSONA_NAME) config.botName = persona.PERSONA_NAME;
  setBotName(config.botName);

  /**
   * 2026-10-20：**协议可切换**。
   *   QQ_PROTOCOL=official（默认）→ 官方机器人 API
   *   QQ_PROTOCOL=onebot           → 用 QQ 小号登录，经 NapCat/Lagrange 走 OneBot v11
   * 两者产出的 msg / api 接口完全一致，engine 与人格层不需要知道走的是哪套。
   */
  const protocol = String(config.protocol ?? "official").toLowerCase() === "onebot" ? "onebot" : "official";
  logger.info(`协议：${protocol === "onebot" ? "OneBot v11（小号）" : "QQ 官方机器人 API"}`);

  let onebotClient = null;
  const api =
    protocol === "onebot"
      ? (() => {
          onebotClient = new OneBotClient({
            wsUrl: config.onebotWsUrl,
            httpUrl: config.onebotHttpUrl,
            token: config.onebotToken,
            selfIds: config.onebotSelfIds,
            logger,
          });
          return new OneBotApiAdapter({ client: onebotClient, logger });
        })()
      : new QQApi({
          appId: config.appId,
          clientSecret: config.clientSecret,
          apiBase: resolveApiBase(config),
          tokenBase: config.tokenBase,
          logger,
        });

  const generate = persona.createPersona({ config, logger });
  const engine = new MessageEngine({ config, api, generate, logger, persona });
  // 后台预热 RVC（模型/RMVPE/index 只加载一次）；失败不影响启动与文字聊天
  engine.warmVoice();

  // 主动消息：让春禾偶尔自己开口（默认关闭，平台有配额限制）
  const proactive = new ProactiveScheduler({
    enabled: config.proactive,
    idleMinutes: config.proactiveIdleMinutes,
    dailyLimit: config.proactiveDailyLimit,
    quietHours: config.proactiveQuietHours,
    checkIntervalMs: config.proactiveCheckIntervalMs,
    stateFile: config.proactiveStateFile,
    logger,
    compose: persona.createProactiveComposer({
      config,
      logger,
      generate,
      // 话题来源：优先挑一个还没被聊腻的
      getTopics: () => engine.topics.relevant({ includeShared: true, limit: 3 }),
    }),
    send: (scope, targetId, text) => api.sendProactiveMessage(scope, targetId, text),
  });
  engine.proactive = proactive;

  // 定时提醒：让春禾能"过一会儿主动说一句话"（用户说"5分钟后提醒我…"时用）
  engine.startReminders();

  logger.info(`订阅事件：${describeIntents(config.intents).join(" | ")}`);
  const missing = missingKeyIntents(config.intents);
  if (missing.length) {
    logger.warn(`缺少关键订阅：${missing.join("、")} —— 相关场景将收不到消息`);
  }

  const gateway =
    protocol === "onebot"
      ? new OneBotGateway({
          // 复用 api 适配器里那个 client —— 否则会开两条 WS、同一事件收两遍
          client: onebotClient,
          wsUrl: config.onebotWsUrl,
          httpUrl: config.onebotHttpUrl,
          token: config.onebotToken,
          selfIds: config.onebotSelfIds,
          onMessage: (msg) => engine.handle(msg),
          onReady: () => {},
          onError: () => {},
          logger,
        })
      : new QQGateway({
    getAccessToken: () => api.getAccessToken(),
    getGatewayUrl: () => api.getGatewayUrl(),
    intents: config.intents,
    onInvalidToken: () => api.clearTokenCache(),
    onMessage: (msg) => engine.handle(msg),
    onReady: () => {},
    onError: () => {},
    onRawEvent: (type, data) => {
      // 关键诊断：把「收到了但不是消息」的事件打出来。
      // 否则「群里 @ 了没反应」时无法区分「没送到」和「送到了但事件类型不同」。
      engine.stats.rawEvents.push(type);
      const brief = summarizeRawEvent(type, data);
      logger.info(`收到其他事件 ${type}${brief ? ` ${brief}` : ""}`);

      // 用户关闭了主动推送 → 永久停止打扰他（平台会下发 REJECT 事件）
      if (type === "C2C_MSG_REJECT" || type === "GROUP_MSG_REJECT") {
        const key = data?.group_openid ? `group:${data.group_openid}` : `c2c:${data?.openid ?? data?.user_openid ?? ""}`;
        proactive.mute(key);
      }
      // 用户重新打开主动推送
      if (type === "C2C_MSG_RECEIVE" || type === "GROUP_MSG_RECEIVE") {
        logger.info("用户重新开启了主动消息推送");
      }
    },
    debugRawEvents: config.debugRawEvents,
    sessionFile: config.sessionFile,
    logger,
  });

  return { ok: true, config, api, engine, gateway, mock, logger };
}

/**
 * 源码目录。
 * - 直接跑源码（ESM）：用 import.meta.dirname（Node 20.11+，直接给解码后的物理路径）
 * - 打包成单文件：esbuild 会把 __DSH_SRC_DIR__ 替换成构建时的绝对路径
 *
 * 注意：**不要**手工解析 import.meta.url.pathname —— 它返回的是 URL 编码路径，
 * 目录名含中文时会变成 %E5%A4%A7... 导致 .env 找不到（真实踩过的 bug，
 * 表现为静默降级为"本地规则模式"）。
 */
const SRC_DIR =
  typeof __DSH_SRC_DIR__ !== "undefined"
    ? __DSH_SRC_DIR__
    : (import.meta.dirname ?? path.dirname(decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))));

/** 项目根目录：优先用调用方注入的（打包成 exe 时是 exe 所在目录） */
function defaultRootDir() {
  // 源码运行时 SRC_DIR 是 <项目>/src，往上一级即项目根
  return path.resolve(SRC_DIR, "..");
}

export async function main({ rootDir: injectedRoot } = {}) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const rootDir = injectedRoot ?? defaultRootDir();
  const logger = createLogger(process.env.LOG_LEVEL ?? "info");
  const boot = await bootstrap({ args, env: process.env, rootDir, logger });

  if (!boot.ok) {
    if (boot.mock) await boot.mock.stop();
    return 1;
  }

  const { config, engine, gateway, mock } = boot;

  if (args.check) {
    const problems = validateConfig(config, { requireCredentials: !args.mock });
    const ok = problems.length === 0;
    console.log(ok ? "配置自检通过 ✅" : "配置自检未通过 ⚠️（下面是缺的东西）");
    console.log(`  凭证        : ${config.appId ? `AppID=${config.appId}` : "未配置 QQ_APP_ID"} / ${config.clientSecret ? "Secret 已设置" : "未配置 QQ_APP_SECRET"}`);
    console.log(`  环境        : ${config.sandbox ? "沙箱" : "正式"}（${resolveApiBase(config)}）`);
    console.log(`  intents     : ${config.intents}`);
    console.log(`              : ${describeIntents(config.intents).join(" | ")}`);
    const noGroup = missingKeyIntents(config.intents);
    if (noGroup.length) console.log(`  ⚠️ 缺少      : ${noGroup.join("、")}`);
    console.log(`  用户白名单  : ${config.allowUsers.length ? config.allowUsers.join(",") : "未限制（仅调试用，建议配置）"}`);
    console.log(`  群白名单    : ${config.allowGroups.length ? config.allowGroups.join(",") : "未限制"}`);
    console.log(`  限流        : ${config.rateLimitPerMinute}/分钟/用户`);
    console.log(`  人格层      : ${config.modelBaseUrl && config.modelApiKey ? `模型 ${config.modelName}` : "本地规则（未配置模型，可正常联调）"}`);
    console.log(`  人格模块    : ${config.persona}（自称「${config.botName}」${config.botNameExplicit ? "，来自 BOT_NAME" : "，来自人格文件"}）`);
    const labelStyle = String(config.aiLabelStyle ?? "prefix").toLowerCase();
    const labelDesc =
      labelStyle === "none"
        ? "不加标识（靠正文自报家门，简短回复无 AI 提示 → 请自行权衡合规）"
        : labelStyle === "suffix"
          ? `结尾附加 ${config.aiLabel}`
          : `开头附加 ${config.aiLabel}`;
    console.log(`  AI 标识     : ${labelDesc}`);
    if (!ok) {
      console.log("  缺失项      :");
      for (const p of problems) console.log(`    - ${p}`);
      if (!args.mock) console.log("\n提示：先用 `npm run smoke` 在无凭证下验证链路。");
    }
    if (mock) await mock.stop();
    return ok ? 0 : 2;
  }

  // 优雅退出
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`收到 ${signal}，正在停止…`);
    gateway.stop();
    engine.proactive?.stop();
    engine.proactive?.saveState();
    engine.stopReminders(); // 会顺带把待发提醒落盘
    const sessions = engine.flushMemory(); // 把对话记忆落盘，重启后还记得
    logger.info(`记忆已保存（${sessions} 个会话）`);
    if (mock) await mock.stop();
    logger.info(
      `统计：收到 ${engine.stats.received}、回复 ${engine.stats.replied}、重复 ${engine.stats.duplicate}、拒绝 ${engine.stats.denied}、限流 ${engine.stats.rateLimited}`,
    );
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // 意外崩溃也要尽量把记忆保住
  process.on("uncaughtException", (err) => {
    logger.error(`未捕获异常：${err?.stack ?? err}`);
    try {
      engine.flushMemory();
    } catch {
      /* 忽略 */
    }
    process.exit(1);
  });

  if (args.mock && args.once) {
    return await runOnce({ gateway, engine, mock, logger });
  }

  logger.info(args.mock ? "启动本地模拟网关模式…" : "启动正式连接…");
  await gateway.start();
  return 0;
}

/** 冒烟：注入一条消息，等机器人回复，打印结果后退出 */
async function runOnce({ gateway, engine, mock, logger }) {
  const started = gateway.start();

  const ready = await waitFor(() => mock.connectedClients.length > 0, 8000);
  if (!ready) {
    logger.error("模拟网关未收到机器人连接（超时）");
    gateway.stop();
    await mock.stop();
    return 1;
  }
  logger.info("机器人已连上模拟网关 ✅");

  mock.pushC2C({ content: "你好" + botName() + "，帮我算一下 (12+8)*3 的平方" });

  const replied = await waitFor(() => mock.sentMessages.length > 0, 8000);
  if (!replied) {
    logger.error("机器人没有回复（超时）");
    gateway.stop();
    await mock.stop();
    return 1;
  }

  const sent = mock.sentMessages[0];
  const body = sent.body ?? {};
  console.log("\n=== 冒烟结果 ===");
  console.log(`场景      : ${sent.scope}`);
  console.log(`目标      : ${sent.targetId}`);
  console.log(`msg_id    : ${body.msg_id ?? "(无)"}`);
  console.log(`msg_seq   : ${body.msg_seq ?? "(无)"}`);
  console.log(`msg_type  : ${body.msg_type}`);
  console.log(`回复内容  : ${body.content ?? body.markdown?.content}`);
  console.log(`统计      : ${JSON.stringify(engine.stats)}`);

  gateway.stop();
  await mock.stop();
  // 给 ws 关闭一点时间，避免进程悬挂
  await new Promise((r) => setTimeout(r, 200));
  return 0;
}

function waitFor(predicate, timeoutMs, intervalMs = 50) {
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

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((err) => {
      console.error("启动失败：", err);
      process.exitCode = 1;
    });
}
