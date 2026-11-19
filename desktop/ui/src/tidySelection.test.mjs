import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const ts = createRequire(import.meta.url)("typescript"), api = {};
// tidySelection 只依赖 writtenTracking 的 ensureStrokeIds；测试文档都带完整 strokeIds，恒等实现等价。
new Function("exports", "require", ts.transpileModule(readFileSync(new URL("./tidySelection.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(api,
  (name) => name.includes("writtenTracking") ? { ensureStrokeIds: (doc) => doc } : Promise.reject(new Error("unexpected require: " + name)));

function doc(strokes, selection) {
  return {
    name: "page", width_mm: 210, height_mm: 297,
    strokes,
    strokeIds: strokes.map((_, i) => `s${i}`),
    strokeOwners: strokes.map(() => ""),
    strokeGroups: strokes.map((_, i) => Math.floor(i / 2)),
  };
}
const line = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y1 }];

test("sorting reorders the selection top-to-bottom, left-to-right, keeping parallel arrays aligned", () => {
  // 三条笔画：A 行 2 靠右、B 行 2 靠左、C 行 1。期望：C、B、A。
  const strokes = [line(30, 50, 40, 55), line(10, 50, 20, 55), line(0, 10, 5, 15)];
  const original = doc(strokes, [0, 1, 2]);
  const { doc: next } = api.sortSelectionForWriting(original, [0, 1, 2]);
  assert.deepEqual(next.strokes.map(s => Math.round(s[0].x)), [0, 10, 30], "先上行、行内从左到右");
  assert.deepEqual(next.strokeIds, ["s2", "s1", "s0"], "并行数组跟随笔画重排");
  assert.deepEqual(next.strokeGroups, [1, 0, 0], "分组数组跟随笔画值重排");
});

test("sorting leaves everything untouched when already in writing order", () => {
  const original = doc([line(0, 10, 5, 15), line(10, 50, 20, 55)], [0, 1]);
  assert.equal(api.sortSelectionForWriting(original, [0, 1]).doc, original);
});

test("merge joins nearby endpoints, reversing when needed, and syncs parallel arrays", () => {
  // 尾 (20,50) 与第二条头 (20.2,50) 距离 0.2mm → 正向拼接；第三条反向端点接近 → 反转拼接。
  const strokes = [
    line(0, 50, 20, 50),
    line(20.2, 50, 40, 50),
    line(60, 50, 40.3, 50),
  ];
  const original = doc(strokes, [0, 1, 2]);
  const { doc: next, selection, merged } = api.mergeNearbyEnds(original, [0, 1, 2], 0.6, new Set());
  assert.equal(merged, 2);
  assert.equal(next.strokes.length, 1);
  assert.equal(next.strokes[0].length, 6, "三条拼成一条 6 点连续线");
  assert.deepEqual(next.strokes[0].map(p => Math.round(p.x)), [0, 20, 20, 40, 40, 60]);
  assert.equal(next.strokeIds.length, 1);
  assert.equal(next.strokeIds[0], "s0", "保留链首笔画的标识");
  assert.equal(next.strokeGroups.length, 1);
  assert.deepEqual(selection, [0], "新选区指向保留的笔画");
});

test("merge refuses strokes that are already written", () => {
  const original = doc([line(0, 0, 10, 0), line(10.2, 0, 20, 0)], [0, 1]);
  assert.throws(() => api.mergeNearbyEnds(original, [0, 1], 0.6, new Set(["s1"])), /已书写/);
});

test("dedupe removes exact repeats and keeps the first occurrence", () => {
  const original = doc([line(0, 0, 10, 0), line(0.01, 0.01, 10, 0), line(50, 50, 60, 60)], [0, 1, 2]);
  const { doc: next, removed, selection } = api.dedupeSelection(original, [0, 1, 2], 0.05);
  assert.equal(removed, 1);
  assert.equal(next.strokes.length, 2);
  assert.equal(next.strokeIds.length, 2);
  assert.deepEqual(next.strokeIds, ["s0", "s2"]);
  assert.deepEqual(selection, [0, 1], "新下标重新映射到保留笔画");
});

test("tidy functions are no-ops for empty or single selections", () => {
  const original = doc([line(0, 0, 10, 0)], [0]);
  assert.equal(api.sortSelectionForWriting(original, [0]).doc, original);
  assert.equal(api.mergeNearbyEnds(original, [0], 0.6, new Set()).merged, 0);
  assert.equal(api.dedupeSelection(original, [0]).removed, 0);
});
