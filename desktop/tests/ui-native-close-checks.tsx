import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Window as NativeWindow } from "../ui/node_modules/@tauri-apps/api/window.js";
import { useProjectFiles } from "../ui/src/useProjectFiles";
import { WindowControls } from "../ui/src/WindowControls";
import type { Project } from "../ui/src/projectModel";
import App from "../ui/src/App";

export async function run() {
  const capabilities = JSON.parse(fs.readFileSync("desktop/capabilities/default.json", "utf8"));
  assert.ok(capabilities.permissions.includes("core:window:allow-destroy"), "Guarded destruction requires explicit permission, core:default is insufficient");
  assert.ok(capabilities.permissions.includes("core:window:allow-close"));
  const native = new NativeWindow("main", { skip: true } as any);
  const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
  let listener: ((event: any) => Promise<void>) | undefined;
  let allowed = true, failWrite = false, picker: string | null = "/offline/saved.inkproj";
  let closeRequests = 0, destroyed = 0, writes = 0;
  const errors: string[] = [];
  // Keep the installed SDK's onCloseRequested/close/destroy implementations.
  // Only native event transport and IPC permission enforcement are simulated.
  native.listen = (async (_name: string, handler: typeof listener) => { listener = handler; return () => { listener = undefined; }; }) as any;
  native.onResized = async () => () => {};
  native.isMaximized = async () => false;
  (globalThis as any).__testNativeWindow = native;
  (globalThis as any).__saveMock = async () => picker;
  (window as any).__TAURI_INTERNALS__.invoke = async (command: string) => {
    if (command === "plugin:window|close") { closeRequests++; await listener?.({ event: "tauri://close-requested", id: closeRequests, payload: null }); return; }
    if (command === "plugin:window|destroy") { if (!allowed) throw new Error("window.destroy not allowed: core:window:allow-destroy"); destroyed++; return; }
    throw new Error(`Unexpected native command ${command}`);
  };
  function Harness({ blocked = false, draft = false }: { blocked?: boolean; draft?: boolean }) {
    const [value, setValue] = useState(0), [path, setPath] = useState("");
    const files = useProjectFiles({ snapshot: { current_page: value } as Project, path, onPath: setPath, blocked: blocked || draft, closeBlocked: blocked, closeWarning: draft ? "图片背景设置尚未完成" : "", desktop: true,
      onSave: async () => { if (failWrite) throw new Error("write failed"); writes++; }, onOpen: async () => {}, onNew: async () => {}, onMessage: (message, error) => { if (error) errors.push(message); } });
    return <><button onClick={() => setValue(v => v + 1)}>Edit</button><WindowControls desktop onError={message => errors.push(message)} />{files.confirmation}</>;
  }
  let root = createRoot(document.getElementById("root")!);
  const render = async (blocked = false, draft = false) => { await act(async () => root.render(<Harness blocked={blocked} draft={draft} />)); };
  const click = async (name: string) => { const button = [...document.querySelectorAll("button")].find(b => b.textContent === name || b.getAttribute("aria-label") === name); assert.ok(button, name); await act(async () => button.click()); };
  const reset = async () => { await act(async () => root.unmount()); root = createRoot(document.getElementById("root")!); await render(); };
  try {
    await render(); await click("关闭窗口");
    assert.equal(destroyed, 1, "Unmodified project exits via guarded explicit destruction"); assert.equal(closeRequests, 1, "No recursive close request");
    await reset(); await click("Edit"); await click("关闭窗口"); await click("取消"); assert.equal(destroyed, 1);
    await click("关闭窗口"); await click("不保存"); assert.equal(destroyed, 2); assert.equal(closeRequests, 3);
    await reset(); await click("Edit"); picker = null; await click("关闭窗口"); await click("保存并继续"); assert.equal(destroyed, 2, "Canceled file picker prevents close");
    picker = "/offline/saved.inkproj"; failWrite = true; await click("关闭窗口"); await click("保存并继续"); assert.equal(destroyed, 2); assert.ok(errors.some(e => e.includes("write failed")));
    failWrite = false; await click("关闭窗口"); await click("保存并继续"); assert.equal(destroyed, 3); assert.equal(writes, 1);
    await reset(); allowed = false; await click("Edit"); await click("关闭窗口"); await click("不保存");
    assert.equal(destroyed, 3); assert.ok(errors.some(e => e.includes("allow-destroy")), "Native destruction failure is shown rather than silently lost in SDK listener");
    allowed = true; await click("关闭窗口"); await click("取消"); assert.equal(destroyed, 3, "Failed destruction does not bypass the next dirty guard");
    await render(true); await click("关闭窗口"); assert.equal(destroyed, 3); assert.ok(errors.some(e => e.includes("请先停止当前任务")));
    await reset(); await render(false, true); await click("关闭窗口");
    assert.match(document.querySelector('.project-confirmation')!.textContent!, /图片背景设置尚未完成/);
    await click("取消"); assert.equal(destroyed, 3, "Clean project with background draft still asks before closing");
    picker = null; await click("关闭窗口"); await click("保存并继续"); assert.equal(destroyed, 3);
    picker = "/offline/saved.inkproj"; failWrite = true;
    await click("关闭窗口"); await click("保存并继续"); assert.equal(destroyed, 3);
    failWrite = false; await click("关闭窗口"); await click("保存并继续"); assert.equal(destroyed, 4, "Draft edit lock does not block saving applied content on close");
    await click("关闭窗口"); await click("关闭窗口");
    assert.equal(document.querySelectorAll('.project-confirmation').length, 1);
    await click("不保存"); assert.equal(destroyed, 5);
    await click("关闭窗口"); await render(true, true); await click("不保存"); assert.equal(destroyed, 5, "Task starting during confirmation still blocks destruction");

    // Exercise App's actual photo entry, which previously passed its edit lock to close.
    await act(async () => root.unmount()); root = createRoot(document.getElementById("root")!);
    (globalThis as any).__invokeMock = async (name: string, args: any) => {
      if (name === "poll_device" || name.startsWith("list_")) return [];
      if (name === "default_import_options") return {};
      if (name === "paper_background") return {path:"/photo.png",kind:"image",page:1,page_count:1,data_url:"data:image/png;base64,cGFnZQ==",width_mm:args.width_mm,height_mm:args.height_mm};
      if (name === "pdf_background_page") return {path:"/paper.pdf",kind:"pdf",page:1,page_count:1,data_url:"data:image/png;base64,cGFnZQ==",width_mm:160,height_mm:240};
      return null;
    };
    (globalThis as any).__openMock = async () => "/photo.png";
    await act(async () => root.render(<App />));
    await click("画板"); await click("导入照片作为背景"); await click("选择照片背景");
    await click("关闭窗口"); assert.ok(document.querySelector('.project-confirmation'), "Photo wizard must not silently block native close");
    await click("取消"); assert.ok(document.querySelector('[aria-label="纸张背景设置"]'));
    await click("关闭窗口"); await click("不保存"); assert.equal(destroyed, 6);
    await click("取消背景设置"); assert.equal(document.querySelector('[aria-label="纸张背景设置"]'), null);
    (globalThis as any).__openMock = async () => "/paper.pdf";
    await click("导入 PDF 作为背景");
    assert.equal(document.querySelector('[aria-label="纸张背景设置"]'), null);
    await click("关闭窗口"); await click("取消"); assert.equal(destroyed, 6);
    await click("关闭窗口"); await click("保存并继续"); assert.equal(destroyed, 7, "PDF background still saves and closes");
    console.log("PASS installed Tauri SDK close semantics and permission: clean/discard/save exits, cancel/save failure/picker cancel stay open, denied destroy reports error, retry and task guard retained");
  } finally {
    await act(async () => root.unmount()); delete (globalThis as any).__testNativeWindow; delete (globalThis as any).__saveMock;
    delete (globalThis as any).__invokeMock; delete (globalThis as any).__openMock;
    (window as any).__TAURI_INTERNALS__.invoke = originalInvoke;
  }
}
