import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FontRulesPanel } from "../ui/src/FontRulesPanel";
import { newFontRule, type FontRule } from "../ui/src/fontRules";
import App from "../ui/src/App";

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
