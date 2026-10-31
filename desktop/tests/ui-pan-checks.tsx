import React, { act } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import { useCanvasPan } from "../ui/src/CanvasPan";

export async function panChecks() {
  let editorDown = 0, hover = 0, captured: number | null = null;
  function View({ selected = false }: { selected?: boolean }) {
    const pan = useCanvasPan(selected);
    return <div tabIndex={0} data-pan={pan.panActive} data-drag={pan.panning} {...pan.bind}>
      <svg onPointerDown={() => editorDown++} onPointerMove={() => hover++} />
      <input aria-label="pan-input" />
    </div>;
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(<View selected />));
    const viewport = document.querySelector("#root > div") as HTMLDivElement;
    viewport.setPointerCapture = id => { captured = id; };
    viewport.hasPointerCapture = id => captured === id;
    viewport.releasePointerCapture = () => { captured = null; };
    const svg = viewport.querySelector("svg")!;
    const pointer = async (type: string, x: number, y: number, id = 7) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: id, clientX: x, clientY: y, button: 0 });
      await act(async () => { svg.dispatchEvent(event); });
    };
    const key = async (type: string, target: Element = viewport) => {
      await act(async () => { target.dispatchEvent(new window.KeyboardEvent(type, { code: "Space", bubbles: true, cancelable: true })); });
    };
    viewport.scrollLeft = 100; viewport.scrollTop = 200;
    await pointer("pointerdown", 50, 80);
    assert.equal(captured, 7); assert.equal(editorDown, 0);
    await pointer("pointerdown", 55, 85, 8);
    assert.equal(editorDown, 0, "A second pointer cannot start an editor gesture during pan");
    await pointer("pointermove", 30, 45);
    assert.equal(viewport.scrollLeft, 120); assert.equal(viewport.scrollTop, 235);
    assert.equal(hover, 1, "Coordinate hover continues during pan");
    await pointer("pointercancel", 30, 45);
    assert.equal(captured, null); assert.equal(viewport.dataset.drag, "false");
    await act(async () => root.render(<View />));
    await key("keydown", viewport.querySelector("input")!);
    assert.equal(viewport.dataset.pan, "false", "Typing spaces never activates pan");
    await act(async () => viewport.focus()); await key("keydown");
    assert.equal(viewport.dataset.pan, "true");
    await pointer("pointerdown", 10, 10); await pointer("pointermove", 0, 0);
    assert.equal(editorDown, 0);
    await key("keyup"); assert.equal(captured, null); assert.equal(viewport.dataset.pan, "false");
    await pointer("pointerdown", 1, 1); await key("keydown");
    assert.equal(editorDown, 1); assert.equal(viewport.dataset.pan, "false", "Space cannot take over an editor gesture");
    await pointer("pointerup", 1, 1); await key("keyup");
    await act(async () => root.render(<View selected />));
    await pointer("pointerdown", 5, 5);
    await pointer("lostpointercapture", 5, 5);
    assert.equal(viewport.dataset.drag, "false");
    await pointer("pointerdown", 5, 5);
    await act(async () => window.dispatchEvent(new Event("blur")));
    assert.equal(captured, null);
    await pointer("pointerdown", 5, 5);
    await act(async () => root.unmount());
    assert.equal(captured, null, "Unmount releases pointer capture");
  } finally {
    await act(async () => root.unmount());
  }
}
