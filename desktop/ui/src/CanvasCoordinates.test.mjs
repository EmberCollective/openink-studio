import test from "node:test";
import assert from "node:assert/strict";
import {
  mapMachineCoordinates,
  canvasToMachine,
  outsideDirection,
} from "./coordinateGeometry.ts";
test("two-point scale and rotation map the pen and pointer inversely", () => {
  const origin = [110, 20], p = { x: 35, y: 170 };
  for (const registration of [{ scale: 1.07, rotation_deg: 12 }, { scale: .93, rotation_deg: -27 }]) {
    const work = canvasToMachine(p, origin, registration);
    const mapped = mapMachineCoordinates(origin, [work.x, work.y, 0], registration);
    assert.ok(Math.abs(mapped.pen.x - p.x) < 1e-9);
    assert.ok(Math.abs(mapped.pen.y - p.y) < 1e-9);
  }
});
test("fixed paper origin maps work position with one Y flip", () => {
  const m = mapMachineCoordinates([5, 14], [-3, 4, 0]);
  assert.deepEqual(m.origin, { x: 5, y: 14 });
  assert.deepEqual(m.pen, { x: 2, y: 10 });
});
test("pen movement leaves confirmed origin unchanged", () => {
  const a = mapMachineCoordinates([5, 14], [-3, 4, 0]),
    b = mapMachineCoordinates([5, 14], [10, -8, 4]);
  assert.deepEqual(a.origin, b.origin);
  assert.notDeepEqual(a.pen, b.pen);
});
test("unknown positions and invalid origins do not invent pen zero", () => {
  assert.equal(mapMachineCoordinates([NaN, 0], null), null);
  assert.equal(mapMachineCoordinates([0], null), null);
  assert.equal(mapMachineCoordinates([5, 14], null).pen, null);
});
test("off-paper origins retain direction", () => {
  assert.equal(outsideDirection({ x: -2, y: 250 }, 160, 240), "左侧 / 下方");
  assert.equal(outsideDirection({ x: 20, y: 20 }, 160, 240), "");
});
