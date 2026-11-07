import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FontRulesPanel } from "../ui/src/FontRulesPanel";
import { newFontRule, type FontRule } from "../ui/src/fontRules";
import App from "../ui/src/App";
import { InkFontManager } from "../ui/src/InkFontManager";
import { InkGlyphEditor } from "../ui/src/InkGlyphEditor";
import { type InkVariant, inkWritingMetrics } from "../ui/src/inkfont";

export async function run() {
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const root = createRoot(document.getElementById("root")!);
  const library = { rules: [newFontRule("one")], selected: "one" };
  const calls: { seed: number; rule: FontRule; baseline: number | undefined; sample: { font: string; text: string }; resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  let closed = 0;
  const result = { document: { width_mm: 210, height_mm: 297, strokes: [[{ x: 10, y: 10 }, { x: 30, y: 20 }]] }, guides: [] };
  const wait = () => act(async () => { await new Promise(r => setTimeout(r, 220)); });
  const input = () => document.querySelector<HTMLInputElement>('input[aria-label="基准线偏移（正值向上）"]')!;
  const type = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    await act(async () => root.render(<FontRulesPanel library={library} locked={false} fonts={[{ id: "glyph:test", name: "Test font" }]} onClose={() => { closed++; }} onSave={() => assert.fail("Preview must not save")} onPreview={(rule, seed, sample) => new Promise((resolve, reject) => calls.push({ seed, rule, sample, baseline: rule.general.baseline, resolve, reject }))} />));
    await wait();
    assert.equal(calls.length, 1, "Opening automatically previews");
    await type("2"); await wait(); await type("3"); await wait();
    assert.equal(calls.length, 1, "Serializes preview conversions");
    await act(async () => calls[0].resolve(result));
    assert.equal(document.querySelector(".font-preview-paper svg"), null, "Stale result is ignored");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].baseline, 3, "Only latest edit is queued before blur");
    assert.equal(calls[0].seed, calls[1].seed);
    await act(async () => calls[1].resolve(result));
    const svg = document.querySelector(".font-preview-paper svg")!;
    assert.equal(svg.getAttribute("preserveAspectRatio"), "xMidYMid meet");
    assert.ok(Number(svg.getAttribute("viewBox")!.split(" ")[2]) < 210, "Preview crops to ink");
    await type(""); await wait(); assert.equal(calls.length, 2, "Incomplete input does not preview");
    await type("4"); await wait();
    await act(async () => calls[2].reject(new Error("test preview failure")));
    assert.ok(document.querySelector('[role="alert"]')!.textContent!.includes("test preview failure"));
    await act(async () => Array.from(document.querySelectorAll("button")).find(b => b.textContent === "重试预览")!.click());
    await wait(); assert.equal(calls.length, 4);
    await act(async () => calls[3].resolve(result));
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>(".font-rules-preview select")!;
      select.value = "glyph:test"; select.dispatchEvent(new Event("change", { bubbles: true }));
      const text = document.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(text, "ABC");
      text.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait(); assert.deepEqual(calls[4].sample, { font: "glyph:test", text: "ABC" });
    await act(async () => calls[4].resolve(result));
    await act(async () => {
      const left = document.querySelector<HTMLInputElement>('input[aria-label="左留白"]')!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(left, "-2");
      left.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait(); assert.equal(calls[5].rule.general.left, -2);
    await act(async () => calls[5].resolve(result));
    await act(async () => Array.from(document.querySelectorAll("button")).find(b => b.textContent === "恢复默认值")!.click());
    await wait(); assert.deepEqual(calls[6].rule, library.rules[0]);
    await act(async () => calls[6].resolve(result));
    await act(async () => Array.from(document.querySelectorAll("button")).find(b => b.textContent === "＋ 字符规则")!.click());
    assert.ok(document.querySelector('[role="alert"]'));
    await act(async () => {
      const character = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(e => e.parentElement?.textContent === "适用字符")!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(character, "A");
      character.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("2"); await wait(); await act(async () => calls[7].resolve(result));
    assert.equal(calls[7].rule.overrides[0].settings.baseline, 2);
    await act(async () => Array.from(document.querySelectorAll("button")).find(b => b.textContent === "恢复默认值")!.click());
    await wait(); assert.deepEqual(calls[8].rule.overrides, [{ characters: "A", settings: {} }]);
    await act(async () => calls[8].resolve(result));
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="删除字符规则：A"]')!.click());
    assert.equal(document.querySelector('[role="alert"]'), null, "Deleting incomplete override restores valid rule");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭字体规则"]')!.click());
    assert.equal(closed, 1);
    assert.deepEqual(library.rules[0].general, {}, "Draft edits never mutate saved rules");
    await act(async () => root.unmount());
    console.log("PASS: live preview debounce, latest edit queue, fixed seed, crop, incomplete input, failure/retry and unmount.");
  } finally {
    await act(async () => root.unmount());
  }
  await privateGfontPreviewChecks();
  await gfontConversionChecks();
  await squareGlyphEditorChecks();
}

async function squareGlyphEditorChecks() {
  const variant: InkVariant = { id: "quote", character: '"', width_mm: 3, height_mm: 20, advance_mm: 3,
    strokes: [[{ x: 0, y: 5 }, { x: 1, y: 7 }], [{ x: 2, y: 5 }, { x: 3, y: 7 }]] };
  let saved: InkVariant | undefined;
  const root = createRoot(document.getElementById("root")!);
  const click = async (label: string) => act(async () => {
    const button = Array.from(document.querySelectorAll("button")).find(b => b.getAttribute("aria-label") === label || b.textContent?.trim() === label)!;
    assert.ok(button, label); button.click();
  });
  try {
    await act(async () => root.render(<InkGlyphEditor variant={variant} packName="test" backgroundUrl="data:image/png;base64,cA==" onSave={async v => { saved = v; }} onExit={() => {}} />));
    const svg = document.querySelector('svg[aria-label="字形编辑画板"]')!;
    const paper = svg.querySelector("rect")!;
    assert.equal(paper.getAttribute("width"), "20"); assert.equal(paper.getAttribute("height"), "20");
    assert.equal(paper.getAttribute("x"), "-8.5", "The square expands equally around the original 3 mm face");
    assert.equal(svg.getAttribute("viewBox"), "-11 -2.5 25 25");
    assert.equal(svg.querySelector(".canvas-edit-layer > rect")!.getAttribute("x"), "-8.5", "Selection includes the added left margin");
    assert.equal(svg.querySelector("image")!.getAttribute("width"), "3", "The original crop must not stretch");
    assert.equal(svg.querySelector('[aria-label="基准线：字面高度的 75%"] path')!.getAttribute("d"), "M-8.5 15H11.5");
    assert.ok(document.body.textContent!.includes("当前字形"), "Opening does not mark the font dirty");
    await click("选择笔迹 2");
    const x = document.querySelector<HTMLInputElement>('input[aria-label="选区X"]')!;
    await act(async () => {
      x.focus(); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(x, "-8.5");
      x.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => x.blur());
    assert.ok(!document.querySelector(".ink-error"), "Edits may use the added square width");
    await click("画笔：新增笔画");
    (svg as any).getScreenCTM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const pen = svg.querySelector('rect[style*="crosshair"]')!;
    for (const [type, x, y] of [["pointerdown", -8, .5], ["pointermove", 11, 19.5], ["pointerup", 11, 19.5]] as const) {
      await act(async () => { const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }); Object.defineProperty(event, "pointerId", { value: 1 }); pen.dispatchEvent(event); });
    }
    await click("保存字形");
    assert.ok(saved); assert.equal(saved.width_mm, 3); assert.equal(saved.height_mm, 20);
    assert.deepEqual(saved.canvas, { x: -8.5, y: 0, width: 20, height: 20 });
    assert.equal(saved.advance_mm, 3); assert.deepEqual(saved.strokes[0], variant.strokes[0]);
    assert.deepEqual(saved.strokes[1], [{ x: -8.5, y: 5 }, { x: -7.5, y: 7 }]);
    assert.deepEqual(saved.strokes[2], [{ x: -8, y: .5 }, { x: 11, y: 19.5 }]);
    assert.equal(inkWritingMetrics({ ...variant, canvas: saved.canvas }).width, 3, "Expanding canvas does not expand writing advance");
    assert.equal(variant.width_mm, 3);
    await act(async () => root.render(<InkGlyphEditor key="reopened" variant={JSON.parse(JSON.stringify(saved))} packName="test" onSave={async () => {}} onExit={() => {}} />));
    assert.equal(document.querySelector('svg[aria-label="字形编辑画板"]')!.getAttribute("viewBox"), "-11 -2.5 25 25");
    assert.ok(!document.querySelector(".ink-error"));
    assert.equal(document.querySelectorAll(".canvas-edit-layer polyline").length, 3);
    await act(async () => root.render(<InkGlyphEditor key="crop" embedded variant={variant} packName="crop" onSave={async () => {}} onExit={() => {}} />));
    await click("选择笔迹 2");
    const cropX = document.querySelector<HTMLInputElement>('input[aria-label="选区X"]')!;
    await act(async () => {
      cropX.focus(); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(cropX, "10");
      cropX.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => cropX.blur());
    assert.ok(!document.querySelector(".ink-error"), "OCR calibration uses the displayed square too");
  } finally { await act(async () => root.unmount()); }
  console.log("PASS: square glyph editor preserves geometry/crop/baseline and saves horizontal edits without square-width spacing.");
}

async function gfontConversionChecks() {
  for (const available of [true, false]) {
    let selected: string | null = null, fail = false, imports = 0, changed = 0;
    let imported = false;
    const pack = { format: "openink-font", version: 1, id: "converted", name: "转换字体", revision: 1, variants: [] };
    (globalThis as any).__openMock = async (options: any) => {
      assert.deepEqual(options.filters[0].extensions, available ? ["inkfont", "gfont"] : ["inkfont"]);
      return selected;
    };
    (globalThis as any).__invokeMock = async (name: string, args: any) => {
      if (name === "inkfont_list") return imported ? [{ ...pack, characters: [], variant_count: 0 }] : [];
      if (name === "inkfont_load") return pack;
      if (name === "inkfont_import") {
        imports++; assert.equal(args.path, selected);
        if (fail) throw new Error("转换失败");
        imported = true; return pack;
      }
      throw new Error(`Unexpected command: ${name}`);
    };
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => root.render(<InkFontManager privateGfont={available} onClose={() => {}} onChanged={() => changed++} renderImport={() => null} />));
      const button = () => Array.from(document.querySelectorAll("button")).find(b => b.textContent?.startsWith("导入 .inkfont"))!;
      assert.equal(button().textContent!.includes("gfont"), available);
      await act(async () => button().click()); assert.equal(imports, 0, "Cancel does not import");
      selected = available ? "sample.GFONT" : "sample.inkfont";
      fail = true; await act(async () => button().click());
      assert.equal(changed, 0); assert.ok(document.body.textContent!.includes("转换失败"));
      fail = false; await act(async () => button().click());
      assert.equal(changed, 1); assert.ok(document.body.textContent!.includes("转换字体"));
      assert.ok(document.body.textContent!.includes(available ? "已转换为 OpenInk 字包" : "字包已导入"));
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as any).__openMock;
    }
  }
  console.log("PASS: gfont conversion import, cancellation, failure/retry and public capability filter.");
}

async function privateGfontPreviewChecks() {
  const path = "C:\\fonts\\sample.gfont";
  const requests: any[] = [];
  for (const available of [true, false]) {
    let approved = false, failDelete = true, deletes = 0;
    (globalThis as any).__askMock = async () => approved;
    (globalThis as any).__invokeMock = async (name: string, args: any) => {
      if (name === "private_gfont_available") return available;
      if (name === "list_legacy_fonts") return [{ path, display: "测试手写", count: 1, size: 550, version: 5, author: "test", preview_strokes: [] }];
      if (name === "delete_legacy_font") { deletes++; assert.equal(args.path, path); if (failDelete) throw new Error("test deletion failed"); return null; }
      if (name === "default_import_options") return {};
      if (name === "lined_text_document") {
        requests.push(args);
        return { name: "gfont preview", width_mm: 210, height_mm: 297, strokes: [[{ x: 10, y: 10 }, { x: 20, y: 20 }]] };
      }
      if (name === "poll_device" || name.startsWith("list_")) return [];
      return null;
    };
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => root.render(<App />));
      await act(async () => Array.from(document.querySelectorAll("button")).find(b => b.textContent === "设置字体规则")!.click());
      const select = document.querySelector<HTMLSelectElement>(".font-rules-preview select")!;
      const option = Array.from(select.options).find(o => o.value === `legacy:${path}`);
      assert.equal(!!option, available, "Only private builds offer gfont preview");
      if (!available) continue;
      assert.ok(option!.text.includes("gfont"));
      await act(async () => {
        select.value = option!.value; select.dispatchEvent(new Event("change", { bubbles: true }));
        const text = document.querySelector(".font-rules-preview textarea")!;
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(text, "永");
        text.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { await new Promise(r => setTimeout(r, 230)); });
      const request = requests.at(-1);
      assert.equal(request.font_mode, "legacy");
      assert.equal(request.text, "永");
      assert.deepEqual(request.selections, [{ path, weight: 1 }]);
      assert.ok(document.querySelector(".font-preview-paper svg"));
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭字体规则"]')!.click());
      await act(async () => {
        const mode = Array.from(document.querySelectorAll("select")).find(s => Array.from(s.options).some(o => o.value === "legacy"))!;
        mode.value = "legacy"; mode.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const picker = () => document.querySelector<HTMLButtonElement>(".legacy-picker")!;
      await act(async () => picker().click());
      await act(async () => document.querySelector<HTMLInputElement>('.legacy-font-row input[type="checkbox"]')!.click());
      await act(async () => Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "确认选择")!.click());
      assert.ok(picker().textContent!.includes("已选择 1"));
      await act(async () => picker().click());
      const remove = () => document.querySelector<HTMLButtonElement>('[aria-label="删除字体：测试手写"]')!;
      await act(async () => remove().click()); assert.equal(deletes, 0, "Cancel leaves font and selection intact");
      approved = true;
      await act(async () => remove().click()); assert.equal(deletes, 1);
      assert.ok(remove()); assert.ok(picker().textContent!.includes("已选择 1"), "Failure preserves active selection");
      failDelete = false;
      await act(async () => remove().click()); assert.equal(deletes, 2);
      assert.equal(remove(), null);
      assert.ok(picker().textContent!.includes("选择原版 gfont 字体"), "Successful deletion clears active selection");
      assert.ok(document.querySelector(".legacy-confirm")!.textContent!.includes("已选择 0"), "Draft selection is cleared too");
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as any).__askMock;
    }
  }
  console.log("PASS: private gfont choice reaches preview IPC with selected font/text; public build hides it.");
}
