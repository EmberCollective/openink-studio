import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import { WindowControls, dragWindow } from "../ui/src/WindowControls";
import { useProjectFiles } from "../ui/src/useProjectFiles";
import type { Project } from "../ui/src/projectModel";

export async function run() {
  let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
  let resized: (() => void) | undefined;
  let closed = 0, minimized = 0, maximized = false, dragged = 0;
  (globalThis as any).__testNativeWindow = {
    onCloseRequested: async (callback: typeof closeHandler) => { closeHandler = callback; return () => { closeHandler = undefined; }; },
    close: async () => { let prevented = false; closeHandler?.({ preventDefault: () => { prevented = true; } }); if (!prevented) closed++; },
    destroy: async () => { closed++; },
    minimize: async () => { minimized++; },
    toggleMaximize: async () => { maximized = !maximized; resized?.(); },
    isMaximized: async () => maximized,
    startDragging: async () => { dragged++; },
    onResized: async (callback: () => void) => { resized = callback; return () => { resized = undefined; }; },
  };
  const errors: string[] = [];
  function Harness() {
    const [value, setValue] = useState(0);
    const files = useProjectFiles({ snapshot: { current_page: value } as Project, path: "", onPath: () => {}, blocked: false, desktop: true,
      onSave: async () => {}, onOpen: async () => {}, onNew: async () => {}, onMessage: message => errors.push(message) });
    return <><div id="drag" onMouseDown={event => dragWindow(event, true, message => errors.push(message))}><button id="nested">Menu</button></div>
      <button onClick={() => setValue(1)}>Edit</button><WindowControls desktop onError={message => errors.push(message)} />{files.confirmation}</>;
  }
  const root = createRoot(document.getElementById("root")!);
  const click = async (name: string) => { const button = [...document.querySelectorAll("button")].find(b => b.textContent === name || b.getAttribute("aria-label") === name); assert.ok(button, name); await act(async () => button.click()); };
  try {
    await act(async () => root.render(<Harness />));
    await click("最小化窗口"); assert.equal(minimized, 1);
    await click("最大化窗口"); assert.equal(maximized, true); assert.ok(document.querySelector('[aria-label="还原窗口"]'));
    const down = async (selector: string, detail: number) => { await act(async () => document.querySelector(selector)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail }))); };
    await down("#nested", 1); assert.equal(dragged, 0, "Controls never drag window");
    await down("#drag", 1); assert.equal(dragged, 1);
    await down("#drag", 2); assert.equal(maximized, false, "Double click restores window");
    await click("Edit"); await click("关闭窗口"); assert.ok(document.querySelector(".project-confirmation")); assert.equal(closed, 0);
    await click("取消"); assert.equal(closed, 0); assert.equal(document.querySelector(".project-confirmation"), null);
    await click("关闭窗口"); await click("不保存"); assert.equal(closed, 1, "Only guarded close completes");
    assert.deepEqual(errors, []);
    console.log("PASS native controls, drag isolation, maximize restore and unsaved close/cancel/discard guard");
  } finally { await act(async () => root.unmount()); delete (globalThis as any).__testNativeWindow; }
}
