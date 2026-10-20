/**
 * resolveAtMentions 单测：把回复里的「@名字」解析成平台真 @ 标签。
 *
 * 边界很关键：
 *  - 命中成员表要换成 <qqbot-at-user id="..."/>；
 *  - 不在成员表的名字必须原样保留（不能吞字、不能乱 @）；
 *  - 唤名（春禾）与「@所有人/@all」不替换。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveAtMentions, roleLabelOf, ROLE_LABELS } from "../src/core/engine.js";

// 造一个成员表：张飞扬 = openid-A，李雷 = openid-B
function makeMemberMap() {
  const byName = new Map([
    ["张飞扬", { member_openid: "oid-zhang", username: "张飞扬", member_role: "member" }],
    ["李雷", { member_openid: "oid-li", username: "李雷", member_role: "admin" }],
  ]);
  return { byName, byOpenid: new Map(), list: [] };
}

test("命中成员表：@名字 替换成真 @ 标签", () => {
  const r = resolveAtMentions("张飞扬，@张飞扬 提醒他一下吃饭", makeMemberMap(), {
    wakeNames: ["春禾"],
  });
  assert.match(r.text, /<qqbot-at-user id="oid-zhang" \/>/, "应替换为真 @ 标签");
  assert.doesNotMatch(r.text, /@张飞扬/, "原文 @名字 不应残留");
  assert.equal(r.resolved.length, 1);
  assert.equal(r.resolved[0].name, "张飞扬");
  assert.equal(r.resolved[0].member_openid, "oid-zhang");
  assert.equal(r.unresolved.length, 0);
});

test("未匹配的名字：原样保留并记入 unresolved", () => {
  const r = resolveAtMentions("@韩梅梅 你好", makeMemberMap(), { wakeNames: ["春禾"] });
  assert.match(r.text, /@韩梅梅/, "不在成员表的名字必须原样保留");
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.unresolved[0], "韩梅梅");
  assert.equal(r.resolved.length, 0);
});

test("唤名「春禾」不替换", () => {
  const r = resolveAtMentions("@春禾 帮我看看", makeMemberMap(), { wakeNames: ["春禾"] });
  assert.match(r.text, /@春禾/, "唤名必须原样保留");
  assert.equal(r.unresolved.length, 0, "唤名不应算作未匹配");
  assert.equal(r.resolved.length, 0);
});

test("@所有人 / @all 不替换", () => {
  for (const t of ["@所有人 集合", "@all 集合", "@全员 集合"]) {
    const r = resolveAtMentions(t, makeMemberMap(), { wakeNames: ["春禾"] });
    assert.equal(r.text, t, `伪 @ 应原样保留：${t}`);
    assert.equal(r.unresolved.length, 0);
  }
});

test("同一名字重复出现：都替换，resolved 只记一次", () => {
  const r = resolveAtMentions("@李雷 和 @李雷 说一声", makeMemberMap(), { wakeNames: ["春禾"] });
  const hits = r.text.match(/<qqbot-at-user id="oid-li" \/>/g) ?? [];
  assert.equal(hits.length, 2, "两处 @李雷 都应被替换");
  assert.equal(r.resolved.length, 1, "同一名字 resolved 只记一次");
});

test("memberMap 为空时不报错，全部原样保留", () => {
  const r = resolveAtMentions("@张三 你好", null, { wakeNames: ["春禾"] });
  assert.match(r.text, /@张三/);
  assert.equal(r.unresolved.length, 1);
});

test("roleLabelOf：member_role → 可读标签", () => {
  assert.equal(roleLabelOf("owner"), ROLE_LABELS.owner);
  assert.equal(roleLabelOf("admin"), "管理员");
  assert.equal(roleLabelOf("member"), "普通成员");
  assert.equal(roleLabelOf(undefined), null);
  assert.equal(roleLabelOf("weird"), null);
});
