import test from 'node:test';
import assert from 'node:assert/strict';
import { screenToCanvas, pointerCoordinates } from './pointerGeometry.ts';
test('pointer follows zoom and scroll translation with independent scale', () => {
  assert.deepEqual(screenToCanvas({ x: 145, y: 164 }, { a: 3, b: 0, c: 0, d: 4, e: -5, f: 84 }), { x: 50, y: 20 });
  assert.deepEqual(screenToCanvas({ x: 120, y: 110 }, { a: 2, b: 0, c: 0, d: 2, e: 20, f: 70 }), { x: 50, y: 20 });
});
test('hover converts confirmed origin with exactly one Y inversion', () => {
  assert.deepEqual(pointerCoordinates({ x: 50, y: 20 }, [10, 35]), { canvas: { x: 50, y: 20 }, work: { x: 40, y: 15 }, confirmed: true });
});
test('unpositioned coordinates explicitly remain preview', () => {
  for (const origin of [null, [], [NaN, 2]]) {
    const value = pointerCoordinates({ x: 5, y: 10 }, origin);
    assert.equal(value.confirmed, false);
    assert.deepEqual(value.work, { x: 5, y: -10 });
  }
});
test('singular transforms do not create pointer coordinates', () => {
  assert.equal(screenToCanvas({ x: 1, y: 2 }, { a: 0, b: 0, c: 0, d: 1, e: 0, f: 0 }), null);
});
