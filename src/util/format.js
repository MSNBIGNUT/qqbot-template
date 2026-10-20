/**
 * 把模型输出转成 QQ 能看的纯文本。
 *
 * 为什么需要这个模块：QQ 文本消息**既不渲染 LaTeX 也不渲染 markdown**。
 * 提示词里其实已经写死了规则（chunhe.js 第 25 行把「（顿了顿）」「（语气一转）」
 * 当反例列出，第 48-58 行整节讲"绝对不要输出 LaTeX 源码"），
 * 但模型照样违反——所以只能在代码层兜底，不能指望提示词。
 *
 * 设计上最重要的不是"转得漂亮"，而是**不许误伤**：
 *   - 代码标识符（my_var / QQ_APP_ID / x**2）必须原样保留
 *   - 正常括号补充（花瓣 (petals)、（学号 B24090129））必须保留
 * 因此：先保护代码块，再转换，最后还原；删除括号内容要同时满足
 * "命中动作词汇" 且 "不含连续英文单词" 两个条件。
 *
 * 全部为纯函数，无依赖，可安全重复调用（幂等）。
 */

// ---------------------------------------------------------------- 字符表

const GREEK = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", varpi: "ϖ",
  rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ",
  phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const SYMBOLS = {
  cdots: "⋯", ldots: "…", dots: "…", vdots: "⋮", ddots: "⋱",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆",
  supset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩", emptyset: "∅", varnothing: "∅",
  infty: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃", neg: "¬",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
  approx: "≈", equiv: "≡", sim: "∼", propto: "∝", ll: "≪", gg: "≫",
  pm: "±", mp: "∓", times: "×", div: "÷", cdot: "·", ast: "∗",
  to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔",
  Rightarrow: "⇒", mapsto: "↦", implies: "⟹", iff: "⟺",
  sum: "∑", prod: "∏", int: "∫", oint: "∮",
  angle: "∠", perp: "⊥", parallel: "∥", therefore: "∴", because: "∵",
  lvert: "|", rvert: "|", lVert: "‖", rVert: "‖", langle: "⟨", rangle: "⟩",
  // 纯排版命令：直接去掉
  left: "", right: "", big: "", Big: "", bigg: "", Bigg: "",
  bigl: "", bigr: "", displaystyle: "", textstyle: "", limits: "", nolimits: "",
  quad: " ", qquad: "  ", ",": " ", ";": " ", "!": "",
};

const BLACKBOARD = { R: "ℝ", C: "ℂ", N: "ℕ", Z: "ℤ", Q: "ℚ", H: "ℍ", P: "ℙ", E: "𝔼", F: "𝔽" };

const SUP = {
  0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ",
};

const SUB = {
  0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ",
  o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};

/** 全部字符都能映射才转，否则整段保持原样（避免出现半截混排） */
function mapAll(text, table) {
  let out = "";
  for (const ch of text) {
    const mapped = table[ch];
    if (mapped === undefined) return null;
    out += mapped;
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------- LaTeX

/** LaTeX → Unicode 纯文本。未知命令直接丢弃（留下 \foo 更难看）。 */
export function latexToUnicode(text) {
  let s = String(text ?? "");
  if (!s) return "";

  // 数学定界符：\( \) \[ \] $$ $
  s = s.replace(/\\\(|\\\)|\\\[|\\\]/g, "");
  s = s.replace(/\$\$?/g, "");

  // 黑板体等：\mathbb R 与 \mathbb{R} 两种写法都要吃
  s = s.replace(
    /\\(?:mathbb|mathbf|mathcal|mathrm|mathsf|mathfrak|operatorname)\s*\{([^{}]*)\}|\\(?:mathbb|mathbf|mathcal|mathrm|mathsf|mathfrak|operatorname)\s*([A-Za-z])/g,
    (m, grouped, single) => {
      const body = grouped ?? single ?? "";
      return body.replace(/[A-Za-z]/g, (ch) => BLACKBOARD[ch] ?? ch);
    },
  );

  // \frac{a}{b} → (a)/(b)；\sqrt[n]{x} → (n)√(x)；\sqrt{x} → √(x)
  s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
  s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, "($1)√($2)");
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)");
  s = s.replace(/\\text\s*\{([^{}]*)\}/g, "$1");

  // 命名命令：长名优先，避免 \in 抢先匹配掉 \infty
  const named = { ...GREEK, ...SYMBOLS };
  const keys = Object.keys(named).sort((a, b) => b.length - a.length);
  if (keys.length) {
    const re = new RegExp(`\\\\(${keys.map(escapeRe).join("|")})(?![A-Za-z])`, "g");
    s = s.replace(re, (m, name) => named[name]);
  }

  // 未识别命令整个丢掉，不留反斜杠垃圾
  s = s.replace(/\\[A-Za-z]+/g, "");
  // 残余反斜杠
  s = s.replace(/\\/g, "");
  // 分组花括号
  s = s.replace(/[{}]/g, "");

  return s.replace(/[ \t]{2,}/g, " ");
}

// ---------------------------------------------------------------- 上下标

/**
 * a_2 → a₂，w^2 → w²。
 *
 * 最大风险是把代码标识符转坏（my_var → myᵥₐᵣ），所以加了双重防护：
 *   1. 基准字符前面不能是字母（`my_var` 里的 `y` 前面是 `m`，被挡掉）
 *   2. 脚本后面不能紧跟字母数字（`a_2b` 被挡掉）
 * 另外 formatForQQ 会先把代码块整体保护起来。
 */
export function toScripts(text) {
  let s = String(text ?? "");
  if (!s) return "";

  const BASE =
    "(?<![A-Za-z\\u03b1-\\u03c9\\u0391-\\u03a9])([A-Za-z\\u03b1-\\u03c9\\u0391-\\u03a9])";
  const TAIL = "(?![A-Za-z0-9])";
  // 脚本部分：x^{n+1} 与 x^2 / x_n 两种写法
  const SCRIPT = "(\\{([^{}]{1,8})\\}|([0-9]{1,2}|[a-z]))";

  // marker 必须是 \^ 或 _ ——少了它就会把 C0 这种普通「字母+数字」也当成上标
  const apply = (src, marker, table) => {
    const re = new RegExp(`${BASE}\\${marker}${SCRIPT}${TAIL}`, "g");
    return src.replace(re, (whole, _base, _outer, braced, bare) => {
      const mapped = mapAll(braced ?? bare, table);
      return mapped === null ? whole : whole[0] + mapped;
    });
  };

  s = apply(s, "^", SUP);
  s = apply(s, "_", SUB);
  return s;
}

// ---------------------------------------------------------------- markdown

/** 去 markdown 标记，留文字内容。 */
export function stripMarkdown(text) {
  let s = String(text ?? "");
  if (!s) return "";
  // 代码围栏：连语言标记一起丢，保留代码内容
  s = s.replace(/```[a-zA-Z0-9]*\r?\n?([\s\S]*?)```/g, "$1");
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, "$1");
  // 强调与删除线
  s = s.replace(/\*\*|__|~~/g, "");
  // 行首标题标记
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  // 链接留文字
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  return s;
}

// ---------------------------------------------------------------- 动作描写

/**
 * 舞台提示类词汇。刻意**不**收录「认真 / 看 / 停 / 转」这类日常词，
 * 否则会把「（第三次修订）」这种正常补充也一起删掉。
 */
const ACTION_WORDS =
  /(顿了顿|顿了|语气|眼睛|眼神|弯了弯|弯起|眯起|眯了|笑了笑|微笑|轻笑|苦笑|沉默|点头|摇头|皱眉|叹气|摊手|耸肩|歪头|脸红|眨眼|抿嘴|咳嗽|清了清嗓|低声|小声|压低|放轻|提高声|转头|低头|抬头|回神|沉吟|正色|俏皮|比划|摆手|托腮|凑近|后退|伸手|摸摸|拍拍|扭头|板起脸|吐舌|叉腰|鼓腮|噗嗤|忍住|深吸|挑眉|扬眉|垂眸|抬眼|想了想|眨巴)/;

/**
 * 保守删除全角括号里的动作描写。
 *
 * 两个条件同时满足才删，缺一不可：
 *   1. 内容命中动作词汇
 *   2. 内容不含 3 个以上连续英文字母（保住「花瓣 (petals)」这类术语注释）
 */
export function stripActionAsides(text) {
  const s = String(text ?? "");
  if (!s) return "";

  return s
    .replace(/[（(]([^（）()]{1,24})[）)]/g, (whole, inner) => {
      if (!ACTION_WORDS.test(inner)) return whole;
      if (/[A-Za-z]{3,}/.test(inner)) return whole;
      return "";
    })
    .replace(/^[ \t]+/gm, "")
    .replace(/ {2,}/g, " ")
    .replace(/ +\n/g, "\n");
}

// ---------------------------------------------------------------- 组合

/**
 * 统一入口：LaTeX → Unicode、上下标 → Unicode、去 markdown、去括号动作描写。
 *
 * 先保护代码块/行内代码（用占位符），转换完再原样还原——否则 `x**2`、`my_var`
 * 这类内容会被 markdown 与上下标规则改坏。
 *
 * 幂等：可以放心在 engine 和 tts 两处各调一次。
 */
export function formatForQQ(text) {
  const original = String(text ?? "");
  if (!original) return "";

  const codes = [];
  let s = original;

  // 1) 保护代码（围栏 + 行内）。占位符只用数字，避免被上下标/LaTeX 规则误伤
  s = s.replace(/```[a-zA-Z0-9]*\r?\n?([\s\S]*?)```/g, (m, body) => {
    codes.push(body.replace(/\n+$/, ""));
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, (m, body) => {
    codes.push(body);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // 2) 正文转换
  s = latexToUnicode(s);
  s = toScripts(s);
  s = stripMarkdown(s);
  s = stripActionAsides(s);

  // 3) 还原代码
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)] ?? "");

  // 4) 若整条只剩标记导致被清空，宁可保留原文也不要发空消息
  return s.trim() ? s : original.trim();
}
