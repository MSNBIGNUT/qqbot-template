/**
 * 文件识别真实链路验证：本地文件服务 → 模拟网关推送文件消息 →
 * 机器人下载并提取 → 真模型回答 → 断言回答里出现文件中的真实内容。
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..").replace(/\\/g, "/");

const { MockQQServer } = await import(`file:///${ROOT}/src/mock/server.js`);
const { QQApi } = await import(`file:///${ROOT}/src/qq/api.js`);
const { QQGateway } = await import(`file:///${ROOT}/src/qq/gateway.js`);
const { MessageEngine } = await import(`file:///${ROOT}/src/core/engine.js`);
const { createPersona } = await import(`file:///${ROOT}/src/persona/chunhe.js`);
const { loadConfig, parseDotenv } = await import(`file:///${ROOT}/src/config.js`);
const { createLogger } = await import(`file:///${ROOT}/src/util/log.js`);

const docEnv = parseDotenv(fs.readFileSync(path.join(ROOT, ".env"), "utf8"));
const config = loadConfig({
  ...docEnv,
  QQ_MULTI_MESSAGE: "false", // 单条回复，便于断言
  QQ_ADMIN_USERS: "user-openid-1",
});

// ---------- 文件服务：把 _fixtures 挂出来 ----------
const FIX = path.join(ROOT, "_fixtures");
const files = fs.readdirSync(FIX);
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.replace(/^\//, "").split("?")[0]);
  const p = path.join(FIX, name);
  if (!p.startsWith(FIX) || !fs.existsSync(p)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const buf = fs.readFileSync(p);
  const mime =
    name.endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : name.endsWith(".xlsx")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime, "Content-Length": buf.length });
  res.end(buf);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log("文件服务已启动，可用样本:", files.join(", "));

// ---------- 起机器人栈 ----------
const logger = createLogger("info");
const mock = await new MockQQServer({ heartbeatInterval: 45000 }).start();
const api = new QQApi({
  appId: mock.expectedAppId,
  clientSecret: mock.expectedSecret,
  apiBase: mock.baseUrl,
  tokenBase: mock.baseUrl,
  logger,
});
const engine = new MessageEngine({
  config: { ...config, allowUsers: [], denyUsers: [], allowGroups: [] },
  api,
  generate: createPersona({ config, logger }),
  logger,
});
const gateway = new QQGateway({
  getAccessToken: () => api.getAccessToken(),
  getGatewayUrl: () => api.getGatewayUrl(),
  intents: config.intents,
  onMessage: (m) => engine.handle(m),
  sessionFile: null,
  logger,
});
gateway.start();

const waitFor = (fn, ms = 60000) => {
  const end = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (fn()) return resolve(true);
      if (Date.now() > end) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
};

if (!(await waitFor(() => mock.connectedClients.length > 0, 6000))) {
  console.log("❌ 未连上模拟网关");
  process.exit(1);
}
console.log("机器人已上线 ✅\n");

// ---------- 逐个文件测试 ----------
const cases = [
  {
    file: "sample.docx",
    ext: "docx",
    ask: "这个文件讲了什么？",
    expect: ["季度", "23%"], // 文件里的真实内容
    desc: "Word 文档（含表格）",
  },
  {
    file: "sample.xlsx",
    ext: "xlsx",
    ask: "表格里有什么数据？",
    expect: ["月份", "销量", "150"],
    desc: "Excel 表格（含公式）",
  },
  {
    file: "sample.pptx",
    ext: "pptx",
    ask: "幻灯片讲了什么？",
    expect: ["春禾", "机器人"],
    desc: "PPT 演示",
  },
  {
    file: "sample.py",
    ext: "py",
    ask: "这段代码做什么？",
    expect: ["add", "a + b"],
    desc: "Python 代码",
  },
  {
    file: "sample.csv",
    ext: "csv",
    ask: "这个表格的内容？",
    expect: ["月份", "销量"],
    desc: "CSV 表格",
  },
];

let passed = 0;
for (const c of cases) {
  const p = path.join(FIX, c.file);
  if (!fs.existsSync(p)) {
    console.log(`跳过（缺样本）: ${c.file}`);
    continue;
  }
  mock.sentMessages.length = 0;
  console.log(`${"=".repeat(64)}`);
  console.log(`【${c.desc}】${c.file} + 「${c.ask}」`);
  console.log(`${"=".repeat(64)}`);

  mock.pushEvent("C2C_MESSAGE_CREATE", {
    id: `f-${c.file}`,
    content: c.ask,
    timestamp: new Date().toISOString(),
    author: { user_openid: "user-openid-1" },
    attachments: [
      {
        content_type: "file",
        url: `${base}/${c.file}`,
        filename: c.file,
      },
    ],
  });

  const got = await waitFor(() => mock.sentMessages.length > 0, 60000);
  if (!got) {
    console.log("  ❌ 机器人没有回复");
    continue;
  }
  const reply = mock.sentMessages.map((m) => m.body.content ?? "").join("\n");
  console.log("  回复:", reply.slice(0, 400).replace(/\n/g, "\n        "));

  const hits = c.expect.filter((k) => reply.includes(k));
  const ok = hits.length >= Math.ceil(c.expect.length / 2);
  if (ok) passed += 1;
  console.log(`  ${ok ? "✅ 读懂了" : "❌ 没体现文件内容"} — 命中关键词: ${JSON.stringify(hits)} / 期望: ${JSON.stringify(c.expect)}`);
  console.log("");
}

console.log(`${"=".repeat(64)}`);
console.log(`结果: ${passed}/${cases.length} 个文件被正确识别并回答`);

gateway.stop();
await mock.stop();
server.close();
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
