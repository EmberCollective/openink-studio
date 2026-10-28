import React, { act } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import App from "../ui/src/App";

export async function writtenChecks() {
  const events: any[] = [], requests: { name: string; args: any }[] = [];
  const fixture = { name: "Written tracking", width_mm: 160, height_mm: 240, strokes: [10, 40, 70].map((x) => [{ x, y: 10 }, { x: x + 10, y: 20 }]) };
  const copy = (value: any) => JSON.parse(JSON.stringify(value));
  (globalThis as any).__openMock = async () => "/offline/written.svg";
  (globalThis as any).__invokeMock = async (name: string, args: any) => {
    requests.push({ name, args: copy(args || {}) });
    if (name === "poll_device") return events.splice(0);
    if (name === "import_document") return copy(fixture);
    if (name === "optimize_document") {
      const stroke_order = args.document.strokes.map((_: any, index: number) => index).reverse();
      return { document: { ...copy(args.document), strokes: stroke_order.map((index: number) => args.document.strokes[index]) }, stroke_order, before_distance_mm: 100, after_distance_mm: 20, before_travel_seconds: 4, after_travel_seconds: .8 };
    }
    if (name === "generate_gcode") return "; mocked code";
    if (name === "default_import_options") return {};
    if (name.startsWith("list_")) return [];
    return null;
  };
  const button = (text: string) => {
    const found = [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text || node.title === text);
    assert.ok(found, `Missing button ${text}`);
    return found;
  };
  const click = async (text: string) => { await act(async () => button(text).click()); };
  const poll = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); }); };
  const shapes = () => [...document.querySelectorAll(".canvas-edit-layer polyline")];
  const points = () => shapes().map((line) => line.getAttribute("points"));
  const written = () => shapes().filter((line) => line.querySelector("title")?.textContent === "已书写");
  const run = () => requests.filter((r) => r.name === "device_command" && r.args.command.type === "run").at(-1)!.args.command.job.document;
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<App />));
  await click("导入素材…");
  events.push({ type: "connected", port: "MOCK" }, { type: "status", status: { state: "Idle", position: [0, 0, 0], wco: [0, 0, 0] } });
  await poll();
  const original = points();
  await click("开始书写");
  const frozen = copy(run().strokes);
  assert.equal(frozen[0][0].x, 70, "Optimizer reverses stroke order for the identity test");
  events.push({ type: "job_started" }, { type: "stroke_completed", index: 0 });
  await poll();
  assert.equal(written().length, 1, "Live event updates title without changing geometry");
  assert.equal(shapes()[2].getAttribute("stroke"), "#159875");
  assert.deepEqual(points(), original);
  await click("预览 CNC / G-code");
  assert.deepEqual(requests.filter((r) => r.name === "generate_gcode").at(-1)!.args.job.document.strokes, frozen, "Live marks cannot mutate active job exports");
  await click("关闭");
  await click("停止");
  events.push({ type: "stroke_completed", index: 1 }, { type: "stopped" }, { type: "status", status: { state: "Idle", position: [0, 0, 0], wco: [0, 0, 0] } });
  await poll();
  assert.equal(written().length, 2, "A completion queued before stopped survives the Stop click");
  assert.equal(shapes()[0].querySelector("title"), null, "Unconfirmed interrupted stroke stays pending");
  await click("开始书写");
  assert.equal(run().strokes.length, 1, "Restart filters only confirmed finished strokes");
  assert.equal(run().strokes[0][0].x, 10);
  events.push({ type: "job_started" }, { type: "stroke_completed", index: 0 });
  await poll();
  assert.equal(written().length, 3);
  await click("停止");
  events.push({ type: "stopped" }, { type: "status", status: { state: "Idle", position: [0, 0, 0], wco: [0, 0, 0] } });
  await poll();
  assert.equal(button("开始书写").disabled, true, "All completed paths remain skipped after stopping");
  await click("全选路径 Ctrl+A");
  await click("重置选区书写标记");
  assert.equal(written().length, 0, "Explicit reset clears color and hover labels at unchanged geometry");
  assert.deepEqual(points(), original);
  await click("开始书写");
  assert.equal(run().strokes.length, 3, "Reset makes selected content writable again");
  events.push({ type: "job_rejected", reason: "mock failure", running: false });
  await poll();
  assert.equal(written().length, 0, "Failure never marks unconfirmed paths completed");
  await act(async () => root.unmount());
  console.log("PASS: live written color/title, optimized identity, frozen running route, late stop checkpoint, pending-only restart, explicit reset and failure (mock IPC only).");
}
