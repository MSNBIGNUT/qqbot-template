/**
 * 场景标注不该出现在**她的发言**里。
 *
 * 真机故障（2026-10-19 主人反馈）：
 *   「她发消息时总是无意间加上群聊、私聊的备注」
 *   —— 回复里出现「〔私聊〕…」「〔群聊〕…」前缀。
 *
 * 根因：主人统一会话（owner:xxx）的历史里，每条消息都被 annotate 加了场景前缀，
 * 连**她自己过去的回复**也被标了，模型照着模仿。
 *
 * 修法：
 *   1. annotateEntry 只标注用户侧；
 *   2. engine.#sendOne 与 tts.stripForSpeech 各加一道确定性剥离兜底。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { annotateEntry, SCENE_LABELS } from "../src/core/memory.js";
import { stripForSpeech } from "../src/media/tts.js";

test("场景标注：用户发言带前缀", () => {
  const out = annotateEntry({ role: "user", content: "你好", scene: "c2c" });
  assert.equal(out.content, `〔${SCENE_LABELS.c2c}〕你好`);
  const g = annotateEntry({ role: "user", content: "在吗", scene: "group" });
  assert.equal(g.content, `〔${SCENE_LABELS.group}〕在吗`);
});

test("场景标注：**她自己过去的回复不加前缀**（否则模型会模仿）", () => {
  const out = annotateEntry({ role: "assistant", content: "在的", scene: "c2c" });
  assert.equal(out.content, "在的", "assistant 的历史不该带场景标注");

  const g = annotateEntry({ role: "assistant", content: "好", scene: "group" });
  assert.equal(g.content, "好");
});

test("场景标注：没有 scene 的条目不处理", () => {
  const e = { role: "user", content: "x" };
  assert.equal(annotateEntry(e), e);
});

test("语音清洗：句首的场景标被剥掉，正文保留", () => {
  assert.equal(stripForSpeech("〔私聊〕春禾听到了"), "春禾听到了");
  assert.equal(stripForSpeech("〔群聊〕好的"), "好的");
  // 句中出现的标注也一并清掉（不该被念出来）
  assert.ok(!stripForSpeech("主人～〔群聊〕这个我不接").includes("群聊"));
  // 正常文本不受影响
  assert.equal(stripForSpeech("主人～春禾在这儿呢"), "主人～春禾在这儿呢");
});
