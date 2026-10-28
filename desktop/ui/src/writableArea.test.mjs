import test from "node:test";
import assert from "node:assert/strict";
import { writableArea, boundsWithinArea } from "./writableArea.ts";

test("A4 fit includes margins in fixed-origin limits", () => {
  const area = writableArea(210, 297, 10, [0, 0]);
  assert.deepEqual(area, { x: 10, y: 10, width: 190, height: 277 });
  assert.equal(boundsWithinArea({ x: 10, y: 10, width: 180, height: 278 }, area), false);
  assert.equal(boundsWithinArea({ x: 10, y: 10, width: 183.15, height: 183.15 }, area), true);
});
test("nonzero origin and current pen travel are intersected without moving paper", () => {
  const area = writableArea(420, 420, 10, [100, 100], [-190, 190, 0]);
  assert.deepEqual(area, { x: 10, y: 10, width: 110, height: 197 });
  assert.equal(boundsWithinArea({ x: 10, y: 10, width: 95, height: 95 }, area), true);
});
test("A4 lower ink remains reachable from the top right", () => {
  assert.equal(boundsWithinArea({ x: 30, y: 268, width: 20, height: 10 }, writableArea(210, 297, 10, [210, 0], [0, 0, 0])), true);
});
test("unreachable paper and invalid input cannot produce fit geometry", () => {
  assert.equal(writableArea(210, 297, 10, [1000, 1000]), null);
  assert.equal(writableArea(210, 297, 10, [0, 0], [NaN, 0]), null);
  assert.equal(boundsWithinArea({ x: 0, y: 0, width: 1, height: 1 }, null), false);
});
