/**
 * 自然语言 agent 模式的**真机**验证（会真的起 PowerShell）。
 *
 * 与 test/remote-agent.test.js 的分工：
 *   单测用假模型 + 假 spawn，保证逻辑与边界；
 *   这里用**假模型 + 真执行**，证明"命令真的落到这台 Windows 上"。
 * 模型仍然是脚本化的（不花 token、不依赖网络），命令是真的。
 *
 * 覆盖：
 *   1. 口令解锁的回执真的发得出去（修掉了"只记录不发送"的老 bug）
 *   2. 说人话 → 两步命令 → 目录真的建出来了 → 最终回答发回主人
 *   3. 危险命令被拦下（目录还在），要 /确认
 *   4. 回 /确认 <码> 后真的执行（目录被删）
 *   5. 跑长命令时喊 stop coding → 立刻停手（子进程被杀）
 *
 * 所有写入都落在仓库内的 data/ 下（沙箱只允许写这里）。
 *
 * 跑法：node scripts/check-remote-agent.mjs
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const { loadConfig, parseDotenv } = await import(`file:///${ROOT.split(path.sep).join("/")}/src/config.js`);
const { MessageEngine } = await import(`file:///${ROOT.split(path.sep).join("/")}/src/core/engine.js`);
const { createLogger } = await import(`file:///${ROOT.split(path.sep).join("/")}/src/util/log.js`);

const logger = createLogger("info");
const docEnv = parseDotenv(fs.readFileSync(path.join(ROOT, ".env"), "utf8"));
const ADMIN = docEnv.QQ_ADMIN_USERS.split(",")[0].trim();

const DEMO_DIR = path.join(ROOT, "data", "agent-demo");
const PS = (p) => `'${p.replace(/'/g, "''")}'`;

// ⚠️ 隔离的数据文件：QQ_MEMORY_FILE 设成空串会落回默认的 data/memory.json，
// 把验证脚本的假对话写进主人的真实记忆里（踩过一次，别再踩）。
const TMP = fs.mkdtempSync(path.join(ROOT, "data", "_check-agent-"));

const config = loadConfig({
  ...docEnv,
  QQ_MULTI_MESSAGE: "false", // 脚本里不想等"分几口气"的延迟
  QQ_RATE_LIMIT_PER_MINUTE: "100",
  QQ_MEMORY_FILE: path.join(TMP, "memory.json"),
  QQ_TOPIC_FILE: path.join(TMP, "topics.json"),
  QQ_REMINDER_FILE: path.join(TMP, "reminders.json"),
  QQ_PROACTIVE_STATE_FILE: path.join(TMP, "proactive.json"),
  REMOTE_TIMEOUT_MS: "60000",
});

/** 脚本化模型：按顺序返回预设回复（第 3 个参数之后的场景单独给脚本） */
function scriptedChat(script) {
  const calls = [];
  const fn = async (messages) => {
    const i = calls.length;
    calls.push(messages);
    const entry = script[i];
    if (entry === undefined) throw new Error(`脚本用完了（第 ${i + 1} 次调用）`);
    if (typeof entry === "function") return entry(messages);
    return entry;
  };
  fn.calls = calls;
  return fn;
}

const RUN = (cmd) => `<<<RUN>>>\n${cmd}\n<<<END>>>`;

function makeEngine(script) {
  const apiCalls = [];
  const api = {
    sendMessage: async (scope, targetId, text) => {
      apiCalls.push({ scope, targetId, text });
      return { id: `m${apiCalls.length}` };
    },
  };
  const agentChat = scriptedChat(script);
  const engine = new MessageEngine({
    config,
    api,
    generate: async (ctx) => `人格回复:${ctx.text}`,
    logger,
    agentChat,
  });
  return { engine, apiCalls, agentChat, sent: () => apiCalls.map((c) => c.text) };
}

let seq = 0;
const c2c = (content) => ({
  kind: "c2c",
  scope: "c2c",
  rawEventType: "C2C_MESSAGE_CREATE",
  senderId: ADMIN,
  senderName: "主人",
  content,
  messageId: `check-${++seq}`,
  targetId: ADMIN,
  attachments: [],
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? `  —— ${detail}` : ""}`);
}

// 清场
fs.rmSync(DEMO_DIR, { recursive: true, force: true });

// ── 场景 1：解锁回执必须真的发出去 ────────────────────────────
{
  const { engine, sent } = makeEngine([]);
  await engine.handle(c2c("vibe coding"));
  const out = sent().join("\n");
  check("解锁口令的回执真的发到了用户", /全权限模式已开启/.test(out), out.slice(0, 40));
}

// ── 场景 2：说人话 → 建目录 → 列目录确认 → 最终回答 ────────────
{
  const { engine, sent, agentChat } = makeEngine([
    RUN(`New-Item -ItemType Directory -Force -Path ${PS(DEMO_DIR)} | Out-Null; Write-Output 'created ${DEMO_DIR}'`),
    RUN(`Get-ChildItem -Path ${PS(DEMO_DIR)} | Measure-Object | Select-Object -ExpandProperty Count`),
    "主人～`agent-demo` 文件夹已经建好啦，里面现在是空的🌸",
  ]);
  await engine.handle(c2c("vibe coding"));
  const r = await engine.handle(c2c(`在 data 目录里给我建一个 agent-demo 文件夹`));

  const exists = fs.existsSync(DEMO_DIR);
  check("模型发的命令真的在这台机器上执行了（目录已建出）", exists, DEMO_DIR);
  check("模型看得到命令输出（上下文里带回了输出）", agentChat.calls.length === 3);
  check(
    "最终回答用人格语气发回主人",
    r.action === "replied" && /agent-demo/.test(sent().at(-1) ?? ""),
    (sent().at(-1) ?? "").slice(0, 60),
  );
}

// ── 场景 3：危险命令被拦下（不执行） ──────────────────────────
{
  const { engine, sent } = makeEngine([
    RUN(`Remove-Item -Path ${PS(DEMO_DIR)} -Recurse -Force`),
  ]);
  await engine.handle(c2c("vibe coding"));
  const r = await engine.handle(c2c("把 agent-demo 文件夹彻底删掉"));
  const out = sent().at(-1) ?? "";
  check("危险命令没有执行（目录还在）", fs.existsSync(DEMO_DIR));
  check("危险命令要求二次确认", /\/确认 \d{6}/.test(out), out.split("\n")[0]);
  check("危险命令那一步不继续循环", r.action === "replied");

  // ── 场景 4：用户回 /确认 <码> → 真的执行 ────────────────────
  const code = /\/确认 (\d{6})/.exec(out)?.[1];
  const confirmed = await engine.handle(c2c(`/确认 ${code}`));
  const gone = !fs.existsSync(DEMO_DIR);
  check("回 /确认 之后命令真的执行了（目录被删）", gone, `/确认 ${code}`);
  check("确认执行有回执", /执行完成|无输出/.test(sent().at(-1) ?? ""), (sent().at(-1) ?? "").slice(0, 40));
  check("确认流程返回 replied", confirmed.action === "replied");
}

// ── 场景 5：长命令跑到一半，stop coding 立刻停手 ───────────────
{
  const { engine, sent } = makeEngine([
    RUN("Start-Sleep -Seconds 45; Write-Output '睡醒了'"),
    RUN("Write-Output '不该跑到这里'"),
  ]);
  await engine.handle(c2c("vibe coding"));
  const started = Date.now();
  const pending = engine.handle(c2c("让电脑睡 45 秒再告诉我")); // 会真的起一个 45 秒的命令
  await new Promise((r) => setTimeout(r, 1200)); // 等命令真的跑起来

  await engine.handle(c2c("stop coding")); // 主人喊停
  const stopped = await Promise.race([
    pending.then(() => Date.now()),
    new Promise((r) => setTimeout(() => r(0), 20000)), // 20 秒还没停就算失败
  ]);
  const elapsed = (stopped || Date.now()) - started;

  check("stop coding 打断了正在跑的长命令", Boolean(stopped), `用时 ${elapsed}ms`);
  check("打断后没再继续下一步", !sent().some((t) => /不该跑到这里/.test(t)));
  check("主人收到了停手说明", /停/.test(sent().at(-1) ?? ""), (sent().at(-1) ?? "").slice(0, 40));
}

// ── 汇总 ────────────────────────────────────────────────────
fs.rmSync(DEMO_DIR, { recursive: true, force: true });
// MemoryStore 是去抖写盘（800ms）：等它落完再删临时目录，否则会被重新建出来
await new Promise((r) => setTimeout(r, 1200));
fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log("失败项：" + failed.map((f) => f.name).join("、"));
  process.exitCode = 1;
}
