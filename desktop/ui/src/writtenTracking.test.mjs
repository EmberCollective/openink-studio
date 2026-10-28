import test from "node:test";
import assert from "node:assert/strict";
import { ensureStrokeIds, unwrittenDocument, completedStrokeIds, resetWrittenSelection, markCompletedStroke, replacePendingStrokes } from "./writtenTracking.ts";
import { movePaths, deletePaths, copyPaths, pastePaths } from "./editorGeometry.ts";

test("applying pending optimization preserves completed geometry, identity and owners", () => {
  const document = ensureStrokeIds({ name: "mixed", width_mm: 100, height_mm: 100, strokes: [[{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 5, y: 5 }, { x: 6, y: 6 }]], strokeOwners: ["finished", "pending"] });
  const written = new Set([document.strokeIds[0]]);
  const replacement = { name: "optimized", width_mm: 100, height_mm: 100, strokes: [[{ x: 6, y: 6 }, { x: 5, y: 5 }]], strokeOwners: ["pending"] };
  const result = replacePendingStrokes(document, replacement, written);
  assert.deepEqual(result.strokes[0], document.strokes[0]);
  assert.equal(result.strokeIds[0], document.strokeIds[0]);
  assert.notEqual(result.strokeIds[1], document.strokeIds[1]);
  assert.deepEqual(result.strokeOwners, ["finished", "pending"]);
  assert.deepEqual(unwrittenDocument(result, written).strokes, replacement.strokes);
});

test("live execution follows optimized order and stopping retains only confirmed strokes", () => {
  const document = ensureStrokeIds({ name: "live", width_mm: 100, height_mm: 100, strokes: [[{ x: 0, y: 0 }, { x: 1, y: 1 }], [{ x: 5, y: 5 }, { x: 6, y: 6 }]] });
  const orderedIds = [document.strokeIds[1], document.strokeIds[0]];
  const written = markCompletedStroke(new Set(), orderedIds, 0);
  assert.deepEqual(unwrittenDocument(document, written).strokeIds, [document.strokeIds[0]]);
  assert.deepEqual([...markCompletedStroke(written, [], 0)], [...written]);
  for (const invalid of [-1, .5, NaN, 100]) assert.deepEqual([...markCompletedStroke(written, orderedIds, invalid)], [...written]);
  assert.equal(markCompletedStroke(written, orderedIds, 1).size, 2);
});

test("completed identity survives moving/deletion, but copies remain writable", () => {
  const document = ensureStrokeIds({ name: "test", width_mm: 100, height_mm: 100, strokes: [[{ x: 1, y: 2 }, { x: 3, y: 4 }], [{ x: 5, y: 6 }, { x: 7, y: 8 }]], strokeOwners: ["a", "b"] });
  assert.equal(ensureStrokeIds(document), document);
  const written = new Set(completedStrokeIds(document));
  const moved = movePaths(document, [0], 20, 30);
  assert.equal(unwrittenDocument(moved, written).strokes.length, 0);
  const remaining = deletePaths(moved, [0]);
  assert.deepEqual(remaining.strokeIds, [document.strokeIds[1]]);
  const pasted = pastePaths(remaining, copyPaths(document, [0]), { x: 0, y: 0 }).document;
  const pending = unwrittenDocument(pasted, written);
  assert.equal(pending.strokes.length, 1);
  assert.notEqual(pending.strokeIds[0], document.strokeIds[0]);
  assert.deepEqual([...resetWrittenSelection(written, document, [1])], [document.strokeIds[0]]);
  assert.equal(written.size, 2);
});

test("empty strokes never become completed and filtering keeps owners aligned", () => {
  const document = ensureStrokeIds({ name: "test", width_mm: 100, height_mm: 100, strokes: [[], [{ x: 0, y: 0 }, { x: 1, y: 1 }]], strokeOwners: ["empty", "ink"] });
  assert.deepEqual(completedStrokeIds(document), [document.strokeIds[1]]);
  const pending = unwrittenDocument(document, new Set([document.strokeIds[1]]));
  assert.deepEqual(pending.strokeOwners, ["empty"]);
  assert.deepEqual(pending.strokeIds, [document.strokeIds[0]]);
});
