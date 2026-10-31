import React, { act } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import { PaperCornerEditor, validPaperCorners } from "../ui/src/PaperCornerEditor";
import { registrationHandleChecks } from "./ui-registration-handles-checks";

export async function paperCornerChecks() {
  await registrationHandleChecks();
  const root = createRoot(document.getElementById("root")!);
  let corners = [[0, 0], [1, 0], [1, 1], [0, 1]], changes = 0, captured: number | null = null;
  const render = async (disabled = false) => {
    await act(async () => root.render(<PaperCornerEditor source="mock:image" corners={corners} disabled={disabled} onChange={value => { corners = value; changes++; }} />));
  };
  const handle = () => document.querySelector<SVGGElement>('[aria-label="右下纸张角"]')!;
  const pointer = async (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 7, clientX: x * .5, clientY: y * .5, button: 0 });
    await act(async () => handle().dispatchEvent(event));
  };
  try {
    await render();
    assert.equal(document.querySelector('[aria-label="背景四角调整"]'), null);
    await act(async () => (globalThis as any).__loadPaperImages());
    const svg = document.querySelector<SVGSVGElement>('[aria-label="背景四角调整"]')!;
    assert.equal(svg.getAttribute("viewBox"), "0 0 1200 1800");
    assert.equal(document.querySelectorAll('[data-registration-handle]').length, 4);
    assert.equal(document.querySelector('[role="dialog"]'), null, "Corner editing stays in the main canvas");
    svg.getScreenCTM = () => ({ a: .5, b: 0, inverse: () => ({}) }) as DOMMatrix;
    svg.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x * 2, y: this.y * 2 }; } }) as DOMPoint;
    handle().setPointerCapture = id => { captured = id; };
    handle().hasPointerCapture = id => captured === id;
    handle().releasePointerCapture = () => { captured = null; };
    await pointer("pointerdown", 1200, 1800); await pointer("pointermove", 900, 1500);
    assert.equal(changes, 0, "Dragging only updates a draft");
    assert.match(document.querySelector('.paper-corner-outline')!.getAttribute('points')!, /900,1500/);
    const loupe = document.querySelector('.paper-corner-stage .registration-loupe')!;
    assert.ok(loupe, "Shared loupe stays inside the corner canvas");
    assert.equal(loupe.querySelector('use')!.getAttribute('href'), `#${svg.querySelector('g[id]')!.id}`);
    assert.match(loupe.textContent!, /px/); assert.doesNotMatch(handle().textContent!, /间距/);
    await pointer("pointerup", 900, 1500);
    assert.deepEqual(corners[2], [.75, 1500 / 1800]); assert.equal(changes, 1);
    assert.equal(document.querySelector('.registration-loupe'), null);
    await render();
    await pointer("pointerdown", 900, 1500); await pointer("pointermove", 800, 1400);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.match(document.querySelector('.paper-corner-outline')!.getAttribute('points')!, /900,1500/);
    assert.equal(changes, 1);
    await act(async () => handle().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true })));
    assert.equal(corners[2][0], 895 / 1200); assert.equal(changes, 2);
    await render(true);
    await act(async () => handle().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    assert.equal(changes, 2, "Disabled corners cannot change");
    assert.equal(validPaperCorners([[0, 0], [1, 1], [1, 0], [0, 1]]), false);
    assert.equal(validPaperCorners([[0, 0], [1, 0], [1, 0], [0, 1]]), false);
    assert.equal(validPaperCorners(corners), true);
    console.log("PASS: existing two-point calibration handles unchanged; inline four-corner canvas shares drag/loupe, normalized commits, draft mask, cancellation and disabled state.");
  } finally { await act(async () => root.unmount()); }
}
