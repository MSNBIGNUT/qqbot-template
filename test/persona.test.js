/**
 * 人格加载器 / 通用人格 / 自称注册表 的测试。
 *
 * 这些测试锁住模板化的三个承诺：
 *  1. PERSONA 默认是 chunhe（旧行为不变）；
 *  2. PERSONA=default 真的能加载，且正文里没有春禾的专属设定；
 *  3. 找不到人格时**报错并列出可选项**，不静默降级。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_PERSONAS,
  REQUIRED_EXPORTS,
  clearPersonaCache,
  listPersonas,
  loadPersona,
  resolvePersonaFile,
} from "../src/persona/index.js";
import { botName, resetBotName, setBotName } from "../src/persona/naming.js";

// 这个文件会切换「当前生效人格」，跑完复原，避免影响同进程里后面的测试文件。
test.after(() => {
  clearPersonaCache();
  resetBotName();
});

test("人格：默认值仍是 chunhe，接口与旧文件一致", async () => {
  clearPersonaCache();
  const mod = await loadPersona();
  for (const name of REQUIRED_EXPORTS) {
    assert.notEqual(typeof mod[name], "undefined", `缺少导出 ${name}`);
  }
  assert.equal(typeof mod.createPersona, "function");
  assert.match(mod.CHUNHE_SYSTEM_PROMPT, /春禾/);
  assert.match(mod.buildSystemPrompt({ vision: false }), /春禾/);
});

test("人格：PERSONA=default 能加载，且是中性通用人格", async () => {
  clearPersonaCache();
  const mod = await loadPersona("default");
  for (const name of REQUIRED_EXPORTS) {
    assert.notEqual(typeof mod[name], "undefined", `缺少导出 ${name}`);
  }
  for (const name of REQUIRED_EXPORTS.filter((n) => !/PROMPT/.test(n))) {
    assert.equal(typeof mod[name], "function", `${name} 应该是函数`);
  }
  const prompt = mod.CHUNHE_SYSTEM_PROMPT;
  assert.match(prompt, /小助手/);
  assert.doesNotMatch(prompt, /春禾/);
  assert.doesNotMatch(prompt, /主人/);
  assert.doesNotMatch(prompt, /鳍状耳|星芒/);
  // 行为层规则必须还在（模板人格保留的是这些，而不是外形设定）
  assert.match(prompt, /说人话/);
  assert.match(prompt, /温度/);
  assert.match(prompt, /边界/);
  assert.match(prompt, /表情包/);
  assert.match(prompt, /说话人/);
  assert.match(prompt, /画图/);
  assert.match(prompt, /骚扰/);
});

test("人格：BOT_NAME 能覆盖通用人格的自我介绍", async () => {
  clearPersonaCache();
  const mod = await loadPersona("default");
  const prompt = mod.buildSystemPrompt({ vision: false, config: { botName: "团子" } });
  assert.match(prompt, /团子/);
  assert.doesNotMatch(prompt, /小助手/);
});

test("人格：文件不存在时明确报错并列出可选项", async () => {
  clearPersonaCache();
  await assert.rejects(
    () => loadPersona("./does-not-exist.js"),
    (err) => {
      assert.match(err.message, /找不到人格/);
      assert.match(err.message, /chunhe/);
      assert.match(err.message, /default/);
      return true;
    },
  );
});

test("人格：解析内置 id、相对路径与裸名字", () => {
  const root = "C:\\proj";
  assert.ok(resolvePersonaFile("chunhe", { rootDir: root }).endsWith("chunhe.js"));
  assert.ok(resolvePersonaFile("default", { rootDir: root }).endsWith("default.js"));
  assert.equal(Object.keys(BUILTIN_PERSONAS).includes("chunhe"), true);
  assert.equal(listPersonas({ rootDir: root }).some((p) => p.id === "default"), true);
});

test("人格：BOT_NAME 能覆盖本地规则兜底文案里的名字", async () => {
  clearPersonaCache();
  setBotName("团子");
  const mod = await loadPersona("default");
  const generate = mod.createPersona({ config: {}, logger: null });
  const out = await generate({ text: "你是谁", history: [], scope: "c2c" });
  assert.equal(typeof out, "string");
  assert.match(out, /团子/);
  assert.doesNotMatch(out, /小助手/);
  resetBotName();
});

test("人格：换自称后，画图的自指判定跟着 BOT_NAME 走", async () => {
  const { isSelfPortraitRequest, stripSelfMentions } = await import("../src/media/imagegen.js");
  setBotName("团子");
  assert.equal(isSelfPortraitRequest("画个团子的样子"), true, "新名字应被识别为自画像");
  assert.equal(isSelfPortraitRequest("画座雪山"), false);
  assert.equal(stripSelfMentions("画面里有一个团子，在雪山前"), "画面里有一个，在雪山前");
  resetBotName();
});

test("人格：自称注册表默认春禾，可设置与还原", () => {
  resetBotName();
  assert.equal(botName(), "春禾");
  setBotName("团子");
  assert.equal(botName(), "团子");
  setBotName("   ");
  assert.equal(botName(), "团子", "空值不应把名字清掉");
  resetBotName();
  assert.equal(botName(), "春禾");
});
