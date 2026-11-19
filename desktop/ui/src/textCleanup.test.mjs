import test from "node:test";
import assert from "node:assert/strict";
import { cleanStraySpaces } from "./textCleanup.ts";

test("removes the space between Chinese and a digit", () => {
  assert.deepEqual(cleanStraySpaces("本册共 6个单元"), { text: "本册共6个单元", removed: 1 });
});

test("removes spaces between Chinese characters and around Chinese punctuation", () => {
  assert.deepEqual(cleanStraySpaces("本 册， 共 6 个。"), { text: "本册，共6个。", removed: 4 });
});

test("removes full-width spaces between Chinese characters", () => {
  assert.deepEqual(cleanStraySpaces("标题\u3000图\u3000建议\u3000口号"), { text: "标题图建议口号", removed: 3 });
  assert.deepEqual(cleanStraySpaces("本册\u3000共\u30006个单元"), { text: "本册共6个单元", removed: 2 });
});

test("removes full-width spaces after Chinese punctuation", () => {
  assert.deepEqual(cleanStraySpaces("ow/oa、\u3000ee/ea、\u3000y/igh"), { text: "ow/oa、ee/ea、y/igh", removed: 2 });
});

test("keeps spaces inside English words and before English words", () => {
  assert.deepEqual(cleanStraySpaces("Get ready 热身与 Start up配图"), { text: "Get ready 热身与 Start up配图", removed: 0 });
});

test("keeps leading indentation and leaves text without stray spaces untouched", () => {
  assert.deepEqual(cleanStraySpaces("　　二、教材分析\n本册共 6个单元"), { text: "　　二、教材分析\n本册共6个单元", removed: 1 });
  assert.deepEqual(cleanStraySpaces("二、教材分析"), { text: "二、教材分析", removed: 0 });
});
