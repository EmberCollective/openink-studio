import React, { act } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import { RegistrationPanel, type RegistrationSetup } from "../ui/src/RegistrationPanel";
import { canvasToMachine, mapMachineCoordinates, validRegistrationPoints, type Registration } from "../ui/src/coordinateGeometry";
import { writableArea, AXIS_LIMITS_MM } from "../ui/src/writableArea";
import { createRoutePlanner, type RouteRequest } from "../ui/src/useRoutePlan";
import { calibratedRouteComparison, measureRoute } from "../ui/src/routeMetrics";
import type { RouteVariant } from "../ui/src/RouteComparison";

export async function threePointChecks() {
  const documentFixture = { name: "metric", width_mm: 210, height_mm: 297, strokes: [[{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 10, y: 10 }, { x: 10, y: 20 }]] };
  const matrix: [number, number, number, number] = [2, 0, 0, 3];
  assert.deepEqual(measureRoute(documentFixture, { x: 0, y: 0 }, matrix), { draw: 50, travel: 30 });
  let computations = 0;
  const planner = createRoutePlanner(async request => { computations++; return { document: request.document, stroke_order: [0, 1], before_distance_mm: 10, after_distance_mm: 10, before_travel_seconds: 10, after_travel_seconds: 10 }; });
  const request: RouteRequest = { document: documentFixture, start: null, allow_reverse: true, travel_feed_mm_min: 60, metric_matrix: matrix };
  assert.equal((await planner(request)).after_travel_seconds, 30);
  await planner(request); assert.equal(computations, 1);
  assert.equal((await planner({ ...request, metric_matrix: [2, 0, 0, 4] })).after_travel_seconds, 40);
  assert.equal(computations, 2, "A matrix-only change invalidates cached route metrics");
  const original: RouteVariant = { id: "original", label: "Original", document: documentFixture, stroke_owners: [], strokes: 2, draw_mm: 20, travel_mm: 10, z_mm: 4, estimated_seconds: 34, compute_ms: 1, geometry_preserved: true, savings_percent: 0, eligible: false, added_bridges: [], removed_overlap_mm: 0, coverage_preserved: true };
  const comparison = calibratedRouteComparison({ variants: [original, { ...original, id: "current" }], recommended: "current" }, matrix, null, 60, 60, true);
  assert.equal(comparison.variants[0].draw_mm, 50); assert.equal(comparison.variants[0].travel_mm, 30);
  assert.equal(comparison.variants[0].estimated_seconds, 84, "Directional XY lengths change while backend Z timing stays intact");
  assert.deepEqual(comparison.variants[0].document, documentFixture, "Metrics never mutate canvas geometry");
  const registration: Registration = { scale: 1, rotation_deg: 90, matrix: [0, -3, 2, 0] };
  assert.deepEqual(canvasToMachine({ x: 20, y: 80 }, [10, 100], registration), { x: -60, y: 20 });
  assert.deepEqual(mapMachineCoordinates([10, 100], [-60, 20, 0], registration)?.pen, { x: 20, y: 80 });
  assert.equal(mapMachineCoordinates([0, 0], [1, 1, 0], { ...registration, matrix: [1, 1, 1, 1] })?.pen, null);
  assert.equal(validRegistrationPoints([[0, 0], [200, 0], [200, 1]], 210, 297), false);
  assert.equal(validRegistrationPoints([[0, 0], [200, 0], [0, 99]], 210, 297), false);
  assert.equal(validRegistrationPoints([[0, 0], [200, 0], [0, 200]], 210, 297), true);
  const area = writableArea(210, 297, 0, [0, 0], null, registration)!;
  for (const p of [{x: area.x, y: area.y}, {x: area.x + area.width, y: area.y + area.height}]) {
    const machine = canvasToMachine(p, [0, 0], registration);
    assert.ok(Math.abs(machine.x) <= AXIS_LIMITS_MM[0] + 1e-8 && Math.abs(machine.y) <= AXIS_LIMITS_MM[1] + 1e-8);
  }
  const root = createRoot(document.getElementById("root")!);
  const commands: any[] = [];
  let version = 0, captured = 0, session = 0, positioning = false, ready = true, locked = false, complete = 0, switched = 0;
  let setup: RegistrationSetup | undefined, shown: number[][] | null = null;
  const render = async () => {
    await act(async () => root.render(<RegistrationPanel width={210} height={297} travelFeed={2500} origin={null} registration={registration}
      ready={ready} positioning={positioning} calibrationVersion={version} secondPointVersion={captured} sessionVersion={session}
      onCommand={async command => { commands.push(command); return true; }} onLock={value => { locked = value; }}
      onSetupChange={value => { setup = value; }} onPointsChange={value => { shown = value; }} onComplete={() => { complete++; }} onPositioningStarted={() => { switched++; }} />));
  };
  const button = (text: string) => { const result = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === text); assert.ok(result, text); return result; };
  const click = async (text: string) => { assert.equal(button(text).disabled, false); await act(async () => button(text).click()); };
  const select = async (label: string, value: string) => { const node = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; await act(async () => { node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); }); };
  try {
    await render(); assert.equal(setup!.point3, undefined); assert.equal(shown!.length, 2);
    await select("校准方式", "three"); assert.equal(shown!.length, 3); assert.equal(setup!.points.length, 2); assert.ok(setup!.point3);
    await click("已对齐第一点，确认并移向第二点"); assert.equal(locked, true); assert.equal(switched, 1);
    assert.equal(commands.length, 1);
    version++; positioning = true; await render(); assert.equal(commands.length, 1);
    positioning = false; await render(); assert.equal(commands.at(-1).type, "move_to"); assert.equal(switched, 2);
    await click("已对齐第二点，确认并移向第三点"); assert.equal(commands.at(-1).type, "capture_registration_second");
    const count = commands.length;
    await render(); assert.equal(commands.length, count, "IPC acceptance does not authorize third-point movement");
    captured++; positioning = true; await render(); assert.equal(commands.length, count, "Capture event still waits for verified positioning completion");
    positioning = false; await render(); assert.equal(commands.at(-1).type, "move_to"); assert.equal(switched, 3);
    assert.deepEqual([commands.at(-1).canvas_x, commands.at(-1).canvas_y], setup!.point3);
    assert.equal(locked, true); assert.equal(complete, 0);
    await click("已对齐第三点，完成校准"); assert.equal(commands.at(-1).type, "finish_registration_third");
    assert.equal(complete, 0); assert.equal(locked, true);
    version++; positioning = true; await render(); assert.equal(complete, 0);
    positioning = false; await render(); assert.equal(complete, 1); assert.equal(locked, false);
    assert.equal(document.querySelector('[aria-label="校准方案名称"]'), null);
    assert.equal(document.querySelector('[aria-label="已保存校准方案"]'), null);
    assert.equal(commands.some(command => command.type === "apply_registration"), false);
    await select("校准方式", "three"); await click("已对齐第一点，确认并移向第二点");
    session++; ready = false; await render(); assert.equal(locked, false); assert.equal(button("已对齐第一点，确认并移向第二点").disabled, true);
    assert.equal(document.querySelector('input[aria-label="校准方案名称"]'), null);
    console.log("PASS: three-point event gates, session invalidation, removed profile controls, affine inverse and fit bounds.");
  } finally { await act(async () => root.unmount()); }
}
