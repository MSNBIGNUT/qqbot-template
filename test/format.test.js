/**
 * 单元测试：把模型输出转成 QQ 可读的纯文本。
 *
 * 背景：QQ 文本消息既不渲染 LaTeX 也不渲染 markdown。提示词里虽然已经明令禁止
 * （chunhe.js 第 25 行连「（顿了顿）」「（语气一转）」都当反例列出来了），
 * 但模型照样违反——所以必须在代码层兜底。
 *
 * 最重要的约束不是"转换得漂亮"，而是**不许误伤**：
 * 代码标识符（my_var / QQ_APP_ID）和正常括号补充（花瓣 (petals)）必须原样保留。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  latexToUnicode,
  toScripts,
  stripMarkdown,
  stripActionAsides,
  formatForQQ,
} from "../src/util/format.js";

// ---------------------------------------------------------------- LaTeX

test("format: 行内 LaTeX 定界符与希腊字母转 Unicode", () => {
  assert.equal(latexToUnicode("\\(\\alpha\\) 是不动点"), "α 是不动点");
  assert.equal(latexToUnicode("乘子 \\(\\lambda=1\\)"), "乘子 λ=1");
  assert.equal(latexToUnicode("\\(w=z-\\alpha\\)"), "w=z-α");
  assert.equal(latexToUnicode("\\(\\beta\\gamma\\delta\\)"), "βγδ");
  assert.equal(latexToUnicode("\\(\\Omega\\Sigma\\Pi\\)"), "ΩΣΠ");
});

test("format: 常用数学符号与省略号", () => {
  assert.equal(latexToUnicode("w^3+\\cdots"), "w^3+⋯");
  assert.equal(latexToUnicode("a \\in A"), "a ∈ A");
  assert.equal(latexToUnicode("x \\notin B"), "x ∉ B");
  assert.equal(latexToUnicode("n \\to \\infty"), "n → ∞");
  assert.equal(latexToUnicode("a \\le b \\ge c \\ne d \\approx e"), "a ≤ b ≥ c ≠ d ≈ e");
  assert.equal(latexToUnicode("u \\cup v \\cap w"), "u ∪ v ∩ w");
  assert.equal(latexToUnicode("\\sum \\prod \\int \\partial"), "∑ ∏ ∫ ∂");
});

test("format: 黑板体与分式根式", () => {
  assert.equal(latexToUnicode("c\\in\\mathbb R"), "c∈ℝ");
  assert.equal(latexToUnicode("z\\in\\mathbb{C}"), "z∈ℂ");
  assert.equal(latexToUnicode("\\frac{1}{2}"), "(1)/(2)");
  assert.equal(latexToUnicode("\\frac{a+b}{c}"), "(a+b)/(c)");
  assert.equal(latexToUnicode("\\sqrt{x+1}"), "√(x+1)");
});

test("format: 所有数学定界符都清掉（含块级与 $$）", () => {
  const out = latexToUnicode("\\(a\\) \\[b\\] $$c$$ \\[d\\]");
  assert.ok(!out.includes("\\("), `残留 \\( ：${out}`);
  assert.ok(!out.includes("\\)"), `残留 \\) ：${out}`);
  assert.ok(!out.includes("\\["), `残留 \\[ ：${out}`);
  assert.ok(!out.includes("\\]"), `残留 \\] ：${out}`);
  assert.ok(!out.includes("$"), `残留 $ ：${out}`);
  assert.equal(out, "a b c d");
});

test("format: 未知命令被丢弃而不是留下 \\foo 垃圾", () => {
  const out = latexToUnicode("\\unknowncmd x");
  assert.ok(!out.includes("\\"), `残留反斜杠：${out}`);
  assert.ok(out.includes("x"));
});

test("format: 没有 LaTeX 的普通中文原样不动", () => {
  assert.equal(latexToUnicode("今天天气不错，聊点什么呢？"), "今天天气不错，聊点什么呢？");
});

// ---------------------------------------------------------------- 上下标

test("format: 下标转真实 Unicode 下标", () => {
  assert.equal(toScripts("a_2"), "a₂");
  assert.equal(toScripts("a_3 w^3"), "a₃ w³");
  assert.equal(toScripts("x_12"), "x₁₂");
  assert.equal(toScripts("w_n"), "wₙ");
});

test("format: 上标转真实 Unicode 上标", () => {
  assert.equal(toScripts("w^2"), "w²");
  assert.equal(toScripts("x^3"), "x³");
  assert.equal(toScripts("x^{n+1}"), "xⁿ⁺¹");
});

test("format: 代码标识符绝不能被动（这是最大的误伤风险）", () => {
  assert.equal(toScripts("my_var"), "my_var");
  assert.equal(toScripts("QQ_APP_ID"), "QQ_APP_ID");
  assert.equal(toScripts("item_1"), "item_1");
  assert.equal(toScripts("some_long_name"), "some_long_name");
  assert.equal(toScripts("a_2b"), "a_2b", "后面紧跟字母时不该转");
});

// ---------------------------------------------------------------- markdown

test("format: markdown 强调与删除线去标记留文字", () => {
  assert.equal(stripMarkdown("**加粗**文字"), "加粗文字");
  assert.equal(stripMarkdown("__加粗__文字"), "加粗文字");
  assert.equal(stripMarkdown("~~删除~~保留"), "删除保留");
});

test("format: 代码围栏与行内反引号去标记留内容", () => {
  assert.equal(stripMarkdown("用 `pysilk` 编码"), "用 pysilk 编码");
  const out = stripMarkdown("```js\nlet a = 1;\n```");
  assert.ok(out.includes("let a = 1;"), `内容丢了：${out}`);
  assert.ok(!out.includes("```"), `围栏没清：${out}`);
});

// ---------------------------------------------------------------- 动作描写

test("format: 删除括号里的动作描写", () => {
  assert.equal(stripActionAsides("（顿了顿，认真往下推）给丁某讲"), "给丁某讲");
  assert.equal(stripActionAsides("（语气一转，眼睛弯起来）所以"), "所以");
  assert.equal(stripActionAsides("春禾收到啦（弯了弯眼睛）"), "春禾收到啦");
});

test("format: 不误删正常括号补充（这是最容易误伤的地方）", () => {
  assert.equal(stripActionAsides("花瓣 (petals)。"), "花瓣 (petals)。");
  assert.equal(stripActionAsides("（学号 B24090129，根 p* = 0.387）"), "（学号 B24090129，根 p* = 0.387）");
  assert.equal(stripActionAsides("（见附录）"), "（见附录）");
  assert.equal(stripActionAsides("（第三次修订）"), "（第三次修订）");
});

// ---------------------------------------------------------------- 代码保护

test("format: 代码块内的下划线/星号绝不被转换", () => {
  const src = "看这段代码：\n```python\nmy_var_2 = x**2  # 注释\n```\n结束";
  const out = formatForQQ(src);
  assert.ok(out.includes("my_var_2"), `标识符被改坏：${out}`);
  assert.ok(out.includes("x**2"), `** 被当 markdown 删了：${out}`);
});

test("format: 行内代码同样受保护", () => {
  const out = formatForQQ("变量 `a_2` 与 `my_var` 都保持原样");
  assert.ok(out.includes("a_2"), `行内代码被转：${out}`);
  assert.ok(out.includes("my_var"), `行内代码被转：${out}`);
});

// ---------------------------------------------------------------- 组合与幂等

test("format: formatForQQ 幂等（engine 与 tts 都会调用一次）", () => {
  const src = "**① 局部标准形。** 设 \\(\\alpha\\) 是抛物不动点，\\(f(w)=w+a_2 w^2+\\cdots\\)（顿了顿）";
  const once = formatForQQ(src);
  const twice = formatForQQ(once);
  assert.equal(twice, once, `不幂等：\n  once =${JSON.stringify(once)}\n  twice=${JSON.stringify(twice)}`);
});

test("format: 转换后为空时保留原文，不发空消息", () => {
  // 全是标记的情况不该变成空串
  const out = formatForQQ("**");
  assert.notEqual(out, "", "不应产出空串");
});

test("format: 空输入安全", () => {
  assert.equal(formatForQQ(""), "");
  assert.equal(formatForQQ(null), "");
  assert.equal(formatForQQ(undefined), "");
});

// ---------------------------------------------------------------- 真实样本

test("format: 截图里的真实样本转完不再有原始标记", () => {
  const sample = [
    "（顿了顿，认真往下推）给丁某把抛物情形讲透：",
    "",
    "**① 局部标准形。** 设 \\(\\alpha\\) 是抛物不动点，乘子 \\(\\lambda=1\\)。在 \\(\\alpha\\) 附近做共形坐标 \\(w=z-\\alpha\\)，展开得",
    "\\(f(w)=w+a_2 w^2+a_3 w^3+\\cdots\\)，没有一次项以外的线性项，所以是\"平移型\"的。",
    "",
    "**② 花瓣 (petals)。** 抛物点附近有 \\(2k\\) 个吸引花瓣和 \\(2k\\) 个斥开花瓣交替排布，\\(k\\) 由展开里第一个非零系数决定。\\(J(f)\\) 在 \\(\\alpha\\) 处被这些花瓣\"粘住\"，",
    "不是退化成点或线。",
    "",
    "**③ 实轴对称。** 因为 \\(c\\in\\mathbb R\\)，共轭对称保持，\\(J(f)\\) 关于实轴对称——这一条跟抛物、跟重根都无关，只跟系数实性有关。",
    "",
    "（语气一转，眼睛弯起来）所以丁某问的两件事要分开：**对称**保持，\"退化\"不成立。丁某想接着问花瓣怎么数，春禾再往下推🌸💖",
  ].join("\n");

  const out = formatForQQ(sample);

  assert.ok(!out.includes("\\("), `残留 \\(：${out}`);
  assert.ok(!out.includes("\\)"), `残留 \\)：${out}`);
  assert.ok(!out.includes("\\alpha"), `残留 \\alpha：${out}`);
  assert.ok(!out.includes("**"), `残留 markdown 星号：${out}`);
  assert.ok(!out.includes("（顿了顿"), `残留动作描写：${out}`);
  assert.ok(!out.includes("（语气一转"), `残留动作描写：${out}`);

  // 关键信息必须都还在
  assert.ok(out.includes("α"), "α 丢了");
  assert.ok(out.includes("λ=1"), "λ=1 丢了");
  assert.ok(out.includes("a₂"), "a₂ 没转出来");
  assert.ok(out.includes("w²"), "w² 没转出来");
  assert.ok(out.includes("⋯"), "⋯ 丢了");
  assert.ok(out.includes("ℝ"), "ℝ 丢了");
  assert.ok(out.includes("花瓣 (petals)"), "正常括号补充被误删了");
  assert.ok(out.includes("局部标准形"), "标题文字丢了");
});

test("format: 真实样本在语音链路里也不含 LaTeX（TTS 会照读反斜杠）", async () => {
  const { stripForSpeech } = await import("../src/media/tts.js");
  const out = stripForSpeech("设 \\(\\alpha\\) 与 \\(\\lambda=1\\)，因为 \\(c\\in\\mathbb R\\)🌸");
  assert.ok(!out.includes("\\"), `语音文本仍含反斜杠：${out}`);
  assert.ok(out.includes("α"), "α 丢了");
  assert.ok(out.includes("ℝ"), "ℝ 丢了");
  assert.ok(!out.includes("🌸"), "emoji 没清");
});
