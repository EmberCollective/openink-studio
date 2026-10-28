import React, { act } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import RegistrationHandles from "../ui/src/RegistrationHandles";

export async function registrationHandleChecks() {
  const root = createRoot(document.getElementById("root")!);
  let commits: { index: number; point: number[] }[] = [], messages: string[] = [], ink = 0;
  let points = [[10, 10], [160, 10]], disabled = false, captured: number | null = null;
  const render = async () => {
    await act(async () => root.render(<svg onPointerDown={() => ink++}><RegistrationHandles previewHost={document.body} points={points} width={210} height={297} pixelsPerMm={2} disabled={disabled} onCommit={(index, point) => commits.push({ index, point })} onMessage={message => messages.push(message)} /></svg>));
    const svg = document.querySelector("#root svg") as SVGSVGElement;
    // A scaled and translated viewport verifies client coordinates are inverted.
    svg.getScreenCTM = () => ({ inverse: () => ({}) }) as DOMMatrix;
    svg.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform() { return { x: (this.x - 100) / 2, y: (this.y - 50) / 2 }; } }) as DOMPoint;
    document.querySelectorAll<SVGGElement>("[data-registration-handle]").forEach(handle => {
      handle.setPointerCapture = id => { captured = id; };
      handle.hasPointerCapture = id => captured === id;
      handle.releasePointerCapture = () => { captured = null; };
    });
  };
  const handle = () => document.querySelector('[data-registration-handle="0"]') as SVGGElement;
  const pointer = async (type: string, x: number, y: number, id = 7) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: id, clientX: 100 + x * 2, clientY: 50 + y * 2, button: 0 });
    await act(async () => handle().dispatchEvent(event));
  };
  const key = async (key: string, shiftKey = false) => { await act(async () => handle().dispatchEvent(new window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }))); };
  try {
    await render();
    assert.equal(handle().querySelector('.registration-target')?.getAttribute('fill'), 'none');
    assert.notEqual(handle().querySelector('text')?.getAttribute('x'), handle().dataset.x, 'Number must not obscure the target center');
    await pointer("pointerdown", 12, 11); await pointer("pointermove", 22, 21);
    assert.equal(ink, 0); assert.equal(commits.length, 0);
    assert.equal(handle().dataset.x, "20", "Off-center grab preserves the grab offset");
    assert.equal(document.querySelector('.registration-loupe svg')?.getAttribute('viewBox'), '7.5 7.5 25 25', 'Loupe remains centered on the actual point at 4x canvas scale');
    assert.equal(document.querySelector('.registration-loupe use')?.getAttribute('href'), '#registration-preview-content');
    assert.match(handle().textContent!, /间距/);
    await pointer("pointerup", 22, 21); await pointer("pointerup", 22, 21);
    assert.deepEqual(commits, [{ index: 0, point: [20, 20] }]); assert.equal(captured, null);
    assert.equal(document.querySelector('.registration-loupe'), null, 'Release removes the loupe');
    commits = [];
    await pointer("pointerdown", 10, 10); await pointer("pointermove", 120, 10); await pointer("pointerup", 120, 10);
    assert.equal(commits.length, 0); assert.equal(messages.length, 1); assert.equal(handle().dataset.x, "10");
    for (const cancellation of ["pointercancel", "lostpointercapture", "Escape", "disabled", "external"]) {
      await pointer("pointerdown", 10, 10); await pointer("pointermove", 20, 20);
      if (cancellation === "Escape") await key("Escape");
      else if (cancellation === "disabled") { disabled = true; await render(); }
      else if (cancellation === "external") { points = [[11, 10], [160, 10]]; await render(); }
      else await pointer(cancellation, 20, 20);
      await pointer("pointerup", 20, 20); assert.equal(commits.length, 0, cancellation);
      disabled = false; points = [[10, 10], [160, 10]]; await render();
    }
    await pointer("pointerdown", 10, 10); await pointer("pointermove", -30, -20); await pointer("pointerup", -30, -20);
    assert.deepEqual(commits.pop(), { index: 0, point: [0, 0] });
    await key("ArrowRight"); assert.deepEqual(commits.pop(), { index: 0, point: [11, 10] });
    await key("ArrowDown", true); assert.deepEqual(commits.pop(), { index: 0, point: [10, 15] });
    disabled = true; await render(); await key("ArrowRight"); await pointer("pointerdown", 10, 10); await pointer("pointermove", 20, 20); await pointer("pointerup", 20, 20);
    assert.equal(commits.length, 0); assert.equal(captured, null);
    disabled = false; points = [[10, 10], [160, 10], [10, 110]]; await render();
    assert.equal(document.querySelectorAll('[data-registration-handle]').length, 3);
    const third = document.querySelector('[data-registration-handle="2"]')!;
    const previousMessages = messages.length;
    await act(async () => third.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true })));
    assert.equal(commits.length, 0, "Third point must remain at least 100 mm from the first");
    assert.equal(messages.length, previousMessages + 1);
    await act(async () => third.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    assert.deepEqual(commits.pop(), { index: 2, point: [11, 110] });
  } finally { await act(async () => root.unmount()); }
}
