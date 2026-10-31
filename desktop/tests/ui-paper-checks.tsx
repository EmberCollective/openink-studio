import React, { act } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import App from "../ui/src/App";
import { backgroundSnapshot, guideLineNumber, validTextSettings } from "../ui/src/paperModel";
import { PageNavigation, type PageAddition } from "../ui/src/PageNavigation";
import { PaperCornerEditor, validPaperCorners } from "../ui/src/PaperCornerEditor";

export async function paperChecks() {
  const requests: { name: string; args: any }[] = [], events: any[] = [];
  let path = "/offline/ink.svg";
  const fixture = { name: "Background ink", width_mm: 160, height_mm: 240, strokes: [[{ x: 10, y: 10 }, { x: 20, y: 20 }]] };
  const lines = [{ id: "line-1", start: [18, 30], end: [142, 30] }, { id: "line-2", start: [18, 42], end: [142, 43] }];
  (globalThis as any).__openMock = async () => path;
  (globalThis as any).__invokeMock = async (name: string, args: any) => {
    requests.push({ name, args: structuredClone(args ?? {}) });
    if (name === "poll_device") return events.splice(0);
    if (name === "import_document") return structuredClone(fixture);
    if (name === "font_document") return structuredClone(fixture);
    if (name === "lined_text_document") return { ...fixture, width_mm: args.width_mm, height_mm: args.height_mm, strokes: [[{ x: 18, y: 29.5 }, { x: 28, y: 29.5 }]] };
    if (name === "paper_background") return { path: "/cache/processed.png", source_path: args.path, kind: "image", page: args.page, page_count: 2, width_mm: args.width_mm, height_mm: args.height_mm, data_url: "data:image/png;base64,cGFnZQ==", corners: [[0, 0], [1, 0], [1, 1], [0, 1]], guide_lines: args.process ? lines : [] };
    if (name === "default_import_options") return {};
    if (name.startsWith("list_")) return [];
    if (name === "optimize_document") return { document: args.document, stroke_order: args.document.strokes.map((_: any, i: number) => i), before_distance_mm: 0, after_distance_mm: 0, before_travel_seconds: 0, after_travel_seconds: 0 };
    return null;
  };
  const button = (text: string) => { const b = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === text || b.title === text); assert.ok(b, `Missing ${text}`); return b; };
  const click = async (text: string) => { const b = button(text); assert.equal(b.disabled, false, `${text} enabled`); await act(async () => b.click()); };
  const draftNumber = async (selector: string, value: number) => { const input = document.querySelector<HTMLInputElement>(selector)!; assert.equal(input.disabled, false, `${selector} enabled during photo setup`); await act(async () => input.focus()); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, String(value)); input.dispatchEvent(new Event("input", { bubbles: true })); }); await act(async () => input.blur()); };
  const paths = () => [...document.querySelectorAll(".canvas-edit-layer polyline")].map(p => p.getAttribute("points"));
  const poll = async (...next: any[]) => { events.push(...next); await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); }); };
  const idle = { type: "status", status: { state: "Idle", position: [0, 0, 0], wco: [0, 0, 0] } };
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(<App />)); await click("优化轨迹"); await click("导入素材…"); const original = paths();
    const board = document.querySelector('nav.activity-rail button[aria-label="画板"]') as HTMLButtonElement;
    await act(async () => board.click()); path = "/offline/form.png"; await click("导入照片作为背景"); await draftNumber('input[aria-label="照片大致宽度"]', 200); await draftNumber('input[aria-label="照片大致高度"]', 250); assert.equal((document.querySelector('input[aria-label="照片大致宽度"]') as HTMLInputElement).value, "200"); assert.equal((document.querySelector('input[aria-label="照片大致高度"]') as HTMLInputElement).value, "250"); await draftNumber('input[aria-label="照片大致宽度"]', 160); await draftNumber('input[aria-label="照片大致高度"]', 240);
    assert.equal(button("下一步").disabled, true, "Import is required before proceeding");
    await click("选择照片背景"); assert.equal(requests.filter(r => r.name === "paper_background").at(-1)!.args.width_mm, 160); assert.equal(requests.filter(r => r.name === "paper_background").at(-1)!.args.height_mm, 240); await click("下一步");
    assert.ok(document.querySelector('.paper-corner-host .paper-corner-stage'), "Next edits corners directly in the main canvas");
    assert.equal(document.querySelector('[role="dialog"]'), null, "Corner adjustment is inline, not a modal");
    assert.equal(button("应用并继续").disabled, true, "Image must finish loading before processing");
    await act(async () => (globalThis as any).__loadPaperImages());
    assert.equal(document.querySelector('svg[aria-label="背景四角调整"]')!.getAttribute("viewBox"), "0 0 1200 1800");
    const moveCorner = async () => {
      const corner = document.querySelector('[aria-label="右下纸张角"]')!;
      await act(async () => corner.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true })));
    };
    await moveCorner();
    assert.equal(button("应用并继续").disabled, false);
    await click("应用并继续");
    assert.deepEqual(requests.filter(r => r.name === "paper_background").at(-1)!.args.corners, [[0, 0], [1, 0], [1195 / 1200, 1], [0, 1]], "Normalized inline corner edits reach processing");
    assert.equal(document.querySelectorAll(".paper-guideline").length, 2);
    const guideLabels = () => [...document.querySelectorAll(".paper-guideline-label")].map(label => label.textContent);
    assert.deepEqual(guideLabels(), ["1", "2"]);
    const guidePoints = () => [...document.querySelectorAll(".guide-edit-layer polyline")].map(line => line.getAttribute("points"));
    const originalGuides = guidePoints();
    async function guidePointer(type: string, x: number, y: number) {
      const layer = document.querySelector(".guide-edit-layer .canvas-edit-layer.active");
      assert.ok(layer, "Guide editor is active while confirming lines");
      await act(async () => layer.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x * 10, clientY: y * 10 })));
    }
    await click("设备控制");
    await guidePointer("pointerdown", 16, 28); await guidePointer("pointermove", 144, 32); await guidePointer("pointerup", 144, 32);
    assert.equal(button("属性").getAttribute("aria-pressed"), "true", "Selecting a guide opens the right properties panel automatically");
    assert.ok(document.querySelector('.selection-inspector input[aria-label="选区X"]'));
    await guidePointer("pointerdown", 80, 30); await guidePointer("pointermove", 83, 34); await guidePointer("pointerup", 83, 34);
    assert.deepEqual(guidePoints(), ["21,34 145,34", originalGuides[1]], "Guide dragging moves only the selected baseline");
    await click("撤销 Ctrl+Z"); assert.deepEqual(guidePoints(), originalGuides);
    await click("删除 Delete"); assert.deepEqual(guidePoints(), [originalGuides[1]]);
    assert.deepEqual(guideLabels(), ["2"], "Deleting the first baseline retains the second baseline's number");
    await click("撤销 Ctrl+Z"); assert.deepEqual(guidePoints(), originalGuides);
    assert.deepEqual(guideLabels(), ["1", "2"]);
    const firstLine = document.querySelector<HTMLButtonElement>(".paper-line-choice button")!;
    await act(async () => firstLine.click());
    assert.deepEqual(guideLabels(), ["2"], "Deselecting an earlier line preserves the remaining line number");
    await act(async () => firstLine.click());
    assert.deepEqual(guideLabels(), ["1", "2"]);
    assert.equal(guideLineNumber({ id: "custom", start: [0, 0], end: [1, 0] }, 4), 5);
    await click("清空"); assert.equal(button("确认 0 条并继续").disabled, true);
    await click("全选"); await click("显示全部定位横线"); assert.equal(document.querySelectorAll(".paper-guideline").length, 0);
    await click("显示全部定位横线"); await click("确认 2 条并继续");
    assert.equal(button("完成并应用").disabled, true, "Real device confirmation is required, not IPC acceptance");
    await poll({ type: "connected", port: "MOCK" }, idle);
    await click("已对齐第一点，确认并移向第二点");
    await poll({ type: "origin_mode", automatic: false }, { type: "calibration_changed", origin: [160, 0] }, { type: "registration_changed", scale: 1, rotation_deg: 0 }, { type: "positioning", active: false }, idle);
    await poll({ type: "positioning", active: false }, idle);
    await click("已对齐第二点，完成校准");
    assert.equal(button("完成并应用").disabled, true);
    await poll({ type: "registration_changed", scale: 1.01, rotation_deg: 1 }, { type: "positioning", active: false }, idle);
    assert.equal(button("完成并应用").disabled, false);
    await poll({ type: "disconnected" });
    assert.equal(button("完成并应用").disabled, true, "Disconnect invalidates completed physical alignment before applying background");
    await poll({ type: "connected", port: "MOCK" }, idle);
    assert.equal(button("完成并应用").disabled, true, "Reconnect cannot reuse old physical alignment");
    await click("已对齐第一点，确认并移向第二点");
    await poll({ type: "origin_mode", automatic: false }, { type: "calibration_changed", origin: [160, 0] }, { type: "registration_changed", scale: 1, rotation_deg: 0 }, { type: "positioning", active: false }, idle);
    await poll({ type: "positioning", active: false }, idle);
    await click("已对齐第二点，完成校准");
    await poll({ type: "registration_changed", scale: 1.01, rotation_deg: 1 }, { type: "positioning", active: false }, idle);
    await click("完成并应用"); assert.deepEqual(paths(), original, "Background transaction preserves existing ink");
    const image = document.querySelector('image[aria-label="PDF 背景（不可选中）"]')!;
    assert.ok(image); assert.equal(image.getAttribute("pointer-events"), "none");
    assert.equal(image.getAttribute("width"), "160", "Background uses existing page dimensions, no forced A4 reset");
    assert.equal(requests.filter(r => r.name === "paper_background").at(-1)!.args.process, true);
    const add = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="添加页面"]')].at(-1)!;
    await act(async () => add.click());
    const choice = [...document.querySelectorAll(".page-add-options button")].find(b => b.textContent?.includes("复制已有页面")) as HTMLButtonElement;
    assert.ok(choice); await act(async () => choice.click());
    await click("复制并添加"); assert.deepEqual(paths(), original);
    assert.equal(document.querySelector('[aria-label="纸张背景设置"]'), null, "Copy reuses processed background, no wizard");
    const commands = requests.filter(r => r.name === "device_command").map(r => r.args.command.type);
    assert.equal(commands.at(-1), "set_registration_scale", "Copy applies page scales without resetting the current sheet origin");
    await click("上一页画板"); assert.deepEqual(paths(), original);
    await click("下一页画板"); assert.deepEqual(paths(), original);
    await click("导出 SVG"); const exported = requests.filter(r => r.name === "export_document").at(-1)!.args.document;
    assert.equal(JSON.stringify(exported).includes("data:image"), false);
    const materials = document.querySelector('nav.activity-rail button[aria-label="素材"]') as HTMLButtonElement;
    await act(async () => materials.click()); await click("输入文字");
    path = "/offline/font.ttf"; await click("浏览字体文件"); await click("插入文字到画布");
    const normal = requests.filter(r => r.name === "font_document").at(-1)!.args;
    const layout = [...document.querySelectorAll("select")].find(s => s.querySelector('option[value="lines"]'))!;
    await act(async () => { layout.value = "lines"; layout.dispatchEvent(new Event("change", { bubbles: true })); });
    await click("插入文字到画布");
    const lined = requests.filter(r => r.name === "lined_text_document").at(-1)!.args;
    assert.equal(lined.text, normal.text); assert.equal(lined.path, normal.path);
    assert.equal(lined.size_mm, normal.size_mm); assert.equal(lined.spacing_mm, normal.spacing_mm);
    assert.deepEqual(lined.guide_lines, lines); assert.equal(lined.baseline_offset_mm, .5);
    assert.equal(paths().at(-1), "18,29.5 28,29.5", "Along-line output uses absolute canvas coordinates, not ordinary append auto-placement");
    const saved = backgroundSnapshot({ path: "/p.png", source_path: "/p.pdf", page: 1, page_count: 2, data_url: "", kind: "image", guide_lines: lines as any, processed: true, guides_visible: false });
    assert.equal(saved?.source_path, "/p.pdf"); assert.equal(saved?.guides_visible, false); assert.equal(saved?.guide_lines?.length, 2);
    assert.equal(validTextSettings({ text: "unsafe" }), false);
    console.log("PASS: editable approximate photo size while layout is locked; inline corners and normalized arguments; baseline selection auto-opens properties, drag/delete/undo preserve ink; physical calibration event gates, independent page copies and shared along-line text settings (mock IPC).");
  } finally { await act(async () => root.unmount()); }
  await navigationChecks();
  await cornerValidationChecks();
}

async function cornerValidationChecks() {
  const root = createRoot(document.getElementById("root")!);
  let ready = false;
  try {
    for (const corners of [
      [[0, 0], [1, 1], [1, 0], [0, 1]],
      [[0, 0], [1, 0], [1, 0], [0, 1]],
    ]) {
      assert.equal(validPaperCorners(corners), false, "Crossing or overlapping corners cannot be applied");
      await act(async () => root.render(<PaperCornerEditor key={JSON.stringify(corners)} source="mock:image" corners={corners} onChange={() => {}} onReady={value => { ready = value; }} />));
      assert.equal(ready, false);
      await act(async () => (globalThis as any).__loadPaperImages());
      assert.equal(ready, true);
      assert.equal(document.querySelector('[role="dialog"]'), null);
    }
    console.log("PASS: inline corner editor waits for image load; corner validation rejects crossing/overlap.");
  } finally { await act(async () => root.unmount()); }
}

async function navigationChecks() {
  const jumps: number[] = [], additions: PageAddition[] = [];
  const root = createRoot(document.getElementById("root")!);
  const click = async (selector: string) => { const b = document.querySelector<HTMLButtonElement>(selector)!; assert.ok(b, selector); await act(async () => b.click()); };
  try {
    await act(async () => root.render(<PageNavigation page={2} count={8} width={160} height={240} disabled={false} onPage={i => jumps.push(i)} onAdd={p => additions.push(p)} />));
    await click(".page-trigger");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="跳转页码"]')!;
    async function jump(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
    await jump("99"); assert.deepEqual(jumps, []); assert.ok(document.querySelector('[role="alert"]'));
    await jump("4"); assert.deepEqual(jumps, [3]); assert.equal(document.querySelector('[role="dialog"]'), null);
    await click('button[aria-label="添加页面"]'); assert.equal(additions.length, 0, "+ opens chooser only");
    await click(".page-add-options button:first-child"); await click(".page-popover button.primary");
    assert.deepEqual(additions[0], { kind: "blank", width: 160, height: 240 });
    await click('button[aria-label="添加页面"]'); await click(".page-add-options button:nth-child(2)");
    const source = document.querySelector<HTMLSelectElement>('select[aria-label="复制页面"]')!;
    assert.equal(source.value, "2"); await act(async () => { source.value = "5"; source.dispatchEvent(new Event("change", { bubbles: true })); });
    await click(".page-popover button.primary"); assert.deepEqual(additions[1], { kind: "copy", index: 5 });
    await click('button[aria-label="添加页面"]'); await click(".page-add-options button:nth-child(3)"); assert.deepEqual(additions[2], { kind: "pdf" });
    await click('button[aria-label="添加页面"]'); await click(".page-add-options button:nth-child(4)"); assert.deepEqual(additions[3], { kind: "image" });
    console.log("PASS: page jump validation, borderless + chooser, blank dimensions, selected-source copy and PDF/photo route choices.");
  } finally { await act(async () => root.unmount()); }
}
