import React, { act } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import { useJogKeys } from "../ui/src/useJogKeys";

export async function run() {
  const calls: any[] = [];
  let release: (() => void) | null = null;
  let defer = false;
  const command = async (request: Record<string, unknown>) => { calls.push(request); if (defer) await new Promise<void>(resolve => { release = resolve; }); return true; };
  function Harness({ enabled = true }: { enabled?: boolean }) { useJogKeys(enabled, .5, 1500, command); return <><input /><textarea /><select /><div contentEditable suppressContentEditableWarning /></>; }
  const root = createRoot(document.getElementById("root")!);
  const key = async (name: string, options: KeyboardEventInit = {}, target: Element | Window = window) => { await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options }))); };
  const up = (name: string) => window.dispatchEvent(new KeyboardEvent("keyup", { key: name }));
  try {
    await act(async () => root.render(<Harness />));
    await key("ArrowUp"); assert.deepEqual(calls.at(-1), { type: "jog", x: 0, y: .5, feed: 1500 });
    await key("ArrowUp", { repeat: true }); await key("ArrowUp"); assert.equal(calls.length, 1); up("ArrowUp");
    await key("ArrowLeft", { shiftKey: true }); assert.equal(calls.at(-1).x, -1); up("ArrowLeft");
    for (const selector of ["input", "textarea", "select", "[contenteditable]"]) await key("ArrowDown", {}, document.querySelector(selector)!);
    await key("ArrowDown", { ctrlKey: true }); assert.equal(calls.length, 2);
    window.dispatchEvent(new Event("blur")); await key("ArrowDown"); assert.equal(calls.length, 2);
    window.dispatchEvent(new Event("focus"));
    await act(async () => root.render(<Harness enabled={false} />)); await key("ArrowDown"); assert.equal(calls.length, 2);
    await act(async () => root.render(<Harness />));
    defer = true; await key("ArrowRight"); up("ArrowRight"); await key("ArrowDown"); assert.equal(calls.length, 3, "Outstanding IPC rejects new jog without queue");
    await act(async () => release!()); assert.equal(calls.length, 3);
    const modal = document.createElement("div"); modal.setAttribute("role", "dialog"); document.body.append(modal); await key("ArrowDown"); assert.equal(calls.length, 3); modal.remove();
    console.log("PASS device arrow jogging: step/Shift, repeat prevention, edit inputs, blur/tab gates, one IPC, modal lock; no real device used");
  } finally { await act(async () => root.unmount()); }
}
