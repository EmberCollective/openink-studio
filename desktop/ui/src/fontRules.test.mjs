import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const ts = createRequire(import.meta.url)("typescript"), api = {};
new Function("exports", ts.transpileModule(readFileSync(new URL("./fontRules.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(api);
test("selection counts Unicode characters and rejects split surrogate pairs", () => {
  assert.deepEqual(api.scalarSelection("A😀BC", 1, 4), [1, 3]);
  assert.equal(api.scalarSelection("A😀B", 2, 3), null);
  assert.equal(api.scalarSelection("ABC", 2, 2), null);
});
test("saved rules reject duplicate characters, invalid ranges, unknown fields and stale selected IDs", () => {
  const rule = api.newFontRule("one");
  assert.equal(api.ruleError(rule), "");
  assert.equal(api.validRuleLibrary({ rules: [rule], selected: "one" }), true);
  assert.equal(api.validRuleLibrary({ rules: [rule], selected: "missing" }), false);
  assert.notEqual(api.ruleError({ ...rule, general: { size: [120, 90] } }), "");
  assert.notEqual(api.ruleError({ ...rule, general: { other: 1 } }), "");
  assert.notEqual(api.ruleError({ ...rule, overrides: [{ characters: "AA", settings: {} }] }), "");
});

test("duplicate characters name the character and both rule positions", () => {
  const rule = { ...api.newFontRule("one"), overrides: [
    { characters: "W", settings: {} },
    { characters: "QWERTY", settings: {} },
  ] };
  const message = api.ruleError(rule);
  assert.match(message, /字符「W」重复/);
  assert.match(message, /第 1 组/);
  assert.match(message, /第 2 组/);
  const newline = { ...api.newFontRule("one"), overrides: [{ characters: "A\nB", settings: {} }] };
  assert.match(api.ruleError(newline), /换行/);
});

test("negative side bearings persist with strict bounds", () => {
  const rule = { ...api.newFontRule("one"), general: { left: -2, right: -3 }, overrides: [{ characters: "A", settings: { left: -20, right: 20 } }] };
  assert.equal(api.validRuleLibrary({ rules: [rule], selected: "one" }), true);
  for (const value of [-20.1, 20.1, NaN, Infinity]) assert.notEqual(api.ruleError({ ...rule, general: { left: value } }), "");
});
