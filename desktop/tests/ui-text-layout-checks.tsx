import React, { act } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import App from "../ui/src/App";
import { validTextSettings } from "../ui/src/paperModel";

export async function run() {
  const requests: any[] = [];
  let saved: any;
  (globalThis as any).__saveMock = async () => "/offline/layout.inkproj";
  (globalThis as any).__openMock = async () => "/offline/layout.inkproj";
  (globalThis as any).__invokeMock = async (name: string, args: any) => {
    if (name === "list_fonts") return [{ name: "msyh", path: "/offline/font.ttf" }];
    if (name === "save_project") { saved = structuredClone(args.project); return; }
    if (name === "open_project") return structuredClone(saved);
    if (name === "lined_text_document") {
      requests.push(args);
      return { name: "text", width_mm: 210, height_mm: 297, strokes: [[{ x: 50, y: 40 }, { x: 60, y: 45 }]] };
    }
    if (name === "default_import_options") return {};
    if (name === "poll_device" || name.startsWith("list_")) return [];
    return null;
  };
  const root = createRoot(document.getElementById("root")!);
  const button = (name: string) => Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === name || b.title === name)!;
  const click = (name: string) => act(async () => { assert.ok(button(name), name); button(name).click(); });
  const input = (name: string) => Array.from(document.querySelectorAll("label")).find(l => l.textContent?.startsWith(name))?.querySelector<HTMLInputElement>("input");
  const select = (name: string) => Array.from(document.querySelectorAll("label")).find(l => l.textContent?.startsWith(name))!.querySelector<HTMLSelectElement>("select")!;
  const number = async (name: string, value: string) => {
    const node = input(name)!; assert.ok(node, name);
    await act(async () => {
      node.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => node.blur());
  };
  const choose = async (name: string, value: string) => act(async () => { const node = select(name); node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); });
  try {
    await act(async () => root.render(<App />));
    assert.ok(input("行间距"));
    assert.equal(button("自动段落缩进").getAttribute("aria-pressed"), "false");
    await number("行间距", "5");
    await click("自动段落缩进"); await number("首行缩进", "3"); await choose("对齐规则", "right");
    await click("插入文字到画布");
    const free = requests.at(-1); assert.ok(free);
    assert.deepEqual(free.paragraph, { indent_mm: 33, alignment: "right" });
    assert.equal(free.guide_lines[1].start[1] - free.guide_lines[0].start[1], 15);
    assert.equal(document.querySelector(".canvas-edit-layer polyline")?.getAttribute("points"), "50,40 60,45", "Insertion must retain aligned coordinates");
    await click("保存工程");
    let settings = saved.pages[0].document.text_settings;
    assert.equal(settings.line_gap_mm, 5); assert.equal(settings.indent_chars, 3);
    assert.equal(settings.paragraph_indent, true); assert.equal(settings.alignment, "right");
    assert.ok(validTextSettings(settings));
    for (const patch of [{ line_gap_mm: -1 }, { indent_chars: 1.5 }, { paragraph_indent: "yes" }, { alignment: "unknown" }]) assert.equal(validTextSettings({ ...settings, ...patch }), false);
    const guides = [{ id: "line-1", start: [10, 30], end: [150, 32] }, { id: "line-2", start: [10, 54], end: [150, 56] }];
    saved.pages[0].background = { path: "/offline/paper.png", data_url: "data:image/png;base64,cA==", page: 1, page_count: 1, processed: true, guide_lines: guides };
    saved.pages[0].document.text_settings.placement = "lines";
    await click("打开工程");
    assert.ok(!input("行间距"), "Line gap must be hidden on baselines");
    assert.equal(input("首行缩进")!.value, "3"); assert.equal(select("对齐规则").value, "right");
    await click("插入文字到画布");
    assert.deepEqual(requests.at(-1).guide_lines, guides, "Free spacing must never replace real baselines");
    assert.deepEqual(requests.at(-1).paragraph, free.paragraph);
    await choose("文字排版", "free"); assert.equal(input("行间距")!.value, "5");
    await click("保存工程"); settings = saved.pages[0].document.text_settings;
    for (const key of ["line_gap_mm", "paragraph_indent", "indent_chars", "alignment"]) delete settings[key];
    assert.ok(validTextSettings(settings), "Old projects remain valid");
    await click("打开工程");
    assert.equal(button("自动段落缩进").getAttribute("aria-pressed"), "false");
    assert.equal(select("对齐规则").value, "left");
    console.log("PASS: free line gap, shared indentation/alignment, absolute insertion, saved settings and old-project defaults.");
  } finally { await act(async () => root.unmount()); }
}
