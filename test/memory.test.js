/**
 * 会话记忆测试：轮数上限、持久化、损坏文件容错。
 *
 * 为什么重要：记忆坏了或丢了，用户会立刻感觉「它忘了我刚才说的话」，
 * 而这类问题在真机上很难复现，必须在这里守住。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MemoryStore, DENIAL_PATTERNS } from "../src/core/memory.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");

function tmpFile(name = "memory.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-mem-"));
  return path.join(dir, name);
}

test("记忆：一问一答成对保存，可读回", () => {
  const m = new MemoryStore({ maxTurns: 8, logger });
  m.append("c2c:u1", "你好", "主人好～");
  const h = m.get("c2c:u1");
  assert.equal(h.length, 2);
  assert.deepEqual(h[0], { role: "user", content: "你好" });
  assert.deepEqual(h[1], { role: "assistant", content: "主人好～" });
});

test("记忆：超出轮数上限时淘汰最旧的", () => {
  const m = new MemoryStore({ maxTurns: 2, logger });
  for (let i = 1; i <= 5; i += 1) m.append("c2c:u1", `问题${i}`, `回答${i}`);

  const h = m.get("c2c:u1");
  assert.equal(h.length, 4, "2 轮 = 4 条消息");
  assert.equal(h[0].content, "问题4", "最旧的应被淘汰");
  assert.equal(h[3].content, "回答5");
});

test("记忆：不同会话互相隔离", () => {
  const m = new MemoryStore({ maxTurns: 8, logger });
  m.append("c2c:u1", "我是甲", "好的甲");
  m.append("c2c:u2", "我是乙", "好的乙");
  assert.equal(m.get("c2c:u1")[0].content, "我是甲");
  assert.equal(m.get("c2c:u2")[0].content, "我是乙");
  assert.equal(m.size, 2);
});

test("记忆：get 返回副本，外部改动不影响内部", () => {
  const m = new MemoryStore({ maxTurns: 8, logger });
  m.append("c2c:u1", "a", "b");
  const h = m.get("c2c:u1");
  h.push({ role: "user", content: "偷偷加一条" });
  assert.equal(m.get("c2c:u1").length, 2, "内部不应被外部数组改动污染");
});

test("记忆：写入磁盘后重新加载，内容一致（重启不忘）", () => {
  const file = tmpFile();
  const m1 = new MemoryStore({ maxTurns: 8, file, saveDebounceMs: 0, logger });
  m1.append("c2c:u1", "我的名字是春禾", "记住啦");
  m1.flush();
  assert.ok(fs.existsSync(file), "应写出记忆文件");

  const m2 = new MemoryStore({ maxTurns: 8, file, logger });
  const h = m2.get("c2c:u1");
  assert.equal(h.length, 2);
  assert.equal(h[0].content, "我的名字是春禾");
  assert.equal(h[1].content, "记住啦");
});

test("记忆：不落盘模式下也能正常读写（file 为空）", () => {
  const m = new MemoryStore({ maxTurns: 4, file: "", logger });
  m.append("c2c:u1", "x", "y");
  assert.equal(m.get("c2c:u1").length, 2);
  m.flush(); // 不应抛错
});

test("记忆：文件损坏时降级为空记忆，不阻塞启动", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ 这不是合法 JSON", "utf8");
  const m = new MemoryStore({ maxTurns: 8, file, logger });
  assert.equal(m.size, 0, "损坏文件应被忽略");

  // 之后仍可正常使用
  m.append("c2c:u1", "还能用吗", "可以");
  assert.equal(m.get("c2c:u1").length, 2);
});

test("记忆：过滤非法条目（缺字段/错误 role）", () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sessions: {
        "c2c:u1": [
          { role: "user", content: "正常" },
          { role: "system", content: "不该被接受" },
          { role: "assistant" },
          null,
          { role: "assistant", content: "也正常" },
        ],
      },
    }),
    "utf8",
  );
  const m = new MemoryStore({ maxTurns: 8, file, logger });
  const h = m.get("c2c:u1");
  assert.equal(h.length, 2, "只保留合法条目");
  assert.equal(h[0].content, "正常");
  assert.equal(h[1].content, "也正常");
});

test("记忆：clear 可清空单个会话或全部", () => {
  const m = new MemoryStore({ maxTurns: 8, logger });
  m.append("c2c:u1", "a", "b");
  m.append("c2c:u2", "c", "d");
  m.clear("c2c:u1");
  assert.equal(m.get("c2c:u1").length, 0);
  assert.equal(m.get("c2c:u2").length, 2);
  m.clear();
  assert.equal(m.size, 0);
});

test("记忆：喂给模型的历史会剔除机器人自己的错误自我否定", () => {
  const m = new MemoryStore({ maxTurns: 8, logger });
  m.append("c2c:u1", "我喜欢数字7", "好～那春禾记下啦：主人喜欢 7");
  m.append(
    "c2c:u1",
    "你现在记性怎样",
    "【AI】春禾没有跨会话保存记忆的能力，换个新对话就看不到了💦",
  );
  m.append("c2c:u1", "我喜欢数字几", "主人喜欢 7 呀～");

  const raw = m.get("c2c:u1");
  const forModel = m.getForModel("c2c:u1");

  assert.equal(raw.length, 6, "原始记忆仍完整保留（可审计）");
  assert.equal(
    forModel.length,
    5,
    "喂给模型时应剔除那一条否认（6 条里只有 1 条命中）",
  );
  assert.equal(
    raw.filter((msg) => DENIAL_PATTERNS.some((re) => re.test(msg.content))).length,
    1,
    "测试数据本身应只有一条否认，否则断言无意义",
  );
  assert.ok(
    forModel.every((msg) => !DENIAL_PATTERNS.some((re) => re.test(msg.content))),
    "送入模型的历史里不应再有否认记忆的表述",
  );
  // 关键事实不能被误删
  assert.ok(
    forModel.some((msg) => msg.content.includes("7")),
    "事实内容必须保留",
  );
  assert.ok(
    forModel.some((msg) => msg.role === "user" && msg.content === "我喜欢数字7"),
    "用户说过的话必须保留",
  );
});

test("错误自我否定的特征能覆盖真实出现过的说法", () => {
  const realCases = [
    "【AI】主人，春禾记不住哦～",
    "春禾没有跨会话保存记忆的能力，也看不到之前聊过什么。",
    "2. 但跨会话就不行啦，换个新对话，之前的内容春禾就看不到了💦",
    "每次对话对春禾来说都是全新的",
    "春禾没有跨会话记忆，看不到之前的聊天记录",
  ];
  for (const text of realCases) {
    assert.ok(
      DENIAL_PATTERNS.some((re) => re.test(text)),
      `应能识别这类表述：${text}`,
    );
  }
  // 正常回答不该被误伤
  const normalCases = [
    "主人喜欢 7 呀～春禾记得哦",
    "这道题的答案是 42",
    "春禾是 AI，没有真实的感官体验",
  ];
  for (const text of normalCases) {
    assert.ok(
      !DENIAL_PATTERNS.some((re) => re.test(text)),
      `不应误伤正常回答：${text}`,
    );
  }
});

test("喂给模型的历史会剥掉旧的 AI 标识前缀（防止模型继续模仿着加）", () => {
  // 真实现象：关掉 AI 标识后，模型仍会自己加【AI】——
  // 因为历史里自己以前的回复都带这个前缀，它照着学。
  // 光靠提示词压不住，必须确定性剥掉。
  const m = new MemoryStore({ maxTurns: 8, logger });
  m.append("c2c:u1", "你好", "【AI】主人好呀～");
  m.append("c2c:u1", "在吗", "春禾在的");

  const raw = m.get("c2c:u1");
  assert.equal(raw[1].content, "【AI】主人好呀～", "原始记忆保留（可审计）");

  const forModel = m.getForModel("c2c:u1");
  assert.equal(forModel[1].content, "主人好呀～", "送模型时应剥掉前缀");
  assert.equal(forModel[3].content, "春禾在的", "没前缀的不动");
  assert.ok(
    !forModel.some((x) => /^【AI】/.test(x.content)),
    "送入模型的历史里不应再有标识前缀",
  );
});

test("前缀剥离只动开头，不影响正文里提到 AI", () => {
  const m = new MemoryStore({ maxTurns: 8, logger });
  m.append("c2c:u1", "你是 AI 吗", "春禾是 AI，但不是【AI】那种标签哦");
  const forModel = m.getForModel("c2c:u1");
  assert.equal(
    forModel[1].content,
    "春禾是 AI，但不是【AI】那种标签哦",
    "正文里的【AI】不该被误删",
  );
});
