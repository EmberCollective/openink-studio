import React, { act } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import App from "../ui/src/App";

export async function clipboardChecks() {
  const fixture = { name: "Clipboard", width_mm: 160, height_mm: 240, strokes: [[{x:10,y:10},{x:20,y:20}]] };
  let files: any[] = [], opened = 0, clipboardReads = 0;
  const imported: string[] = [];
  let failPreview = false;
  (globalThis as any).__openMock = async () => { opened++; return "/picked.svg"; };
  (globalThis as any).__invokeMock = async (name: string, args: any) => {
    if (name === "clipboard_files") { clipboardReads++; return files; }
    if (name === "clipboard_file_preview") { if (failPreview) throw new Error("preview unavailable"); return {document:fixture,data_url:null}; }
    if (name === "import_document") { imported.push(args.path); return fixture; }
    if (name === "poll_device" || name.startsWith("list_")) return [];
    if (name === "default_import_options") return {};
    if (name === "optimize_document") return {document:args.document,stroke_order:[0],before_distance_mm:0,after_distance_mm:0,before_travel_seconds:0,after_travel_seconds:0};
    return null;
  };
  const root = createRoot(document.getElementById("root")!);
  const click = async (text: string) => { const b = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text || b.title === text); assert.ok(b, text); assert.equal(b.disabled, false); await act(async () => b.click()); };
  await act(async () => root.render(<App />));
  await click("导入素材…"); assert.equal(opened,1); assert.deepEqual(imported,["/picked.svg"]);
  files = [{path:"/clipboard.svg",name:"clipboard.svg",size:120}];
  await click("导入文件");
  assert.equal(clipboardReads,0,"Switching the import tab must not read the clipboard");
  await click("从剪贴板读取图片或文件");
  assert.equal(opened,1,"Clipboard match must not open the picker");
  assert.equal(imported.length,1,"Preview must not import before consent");
  assert.ok(document.querySelector('.clipboard-preview svg'));
  assert.ok(document.querySelector('.left-panel .clipboard-import'), "Preview belongs inside Insert materials");
  assert.equal(document.querySelector('[role="dialog"]'), null, "Material preview must not open a global dialog");
  await click("取消"); assert.equal(imported.length,1);
  files = [{path:"/temp/clipboard-image.png",name:"剪贴板图片.png",size:1500}];
  await click("从剪贴板读取图片或文件"); await click("使用此文件");
  assert.equal(imported.at(-1),"/temp/clipboard-image.png");
  files = [{path:"/clipboard.svg",name:"clipboard.svg",size:120}];
  const beforeReads = clipboardReads;
  await click("导入素材…");
  assert.equal(opened,2,"Explicit file open always uses the picker, even with clipboard content");
  assert.equal(clipboardReads,beforeReads);
  assert.deepEqual(imported,["/picked.svg","/temp/clipboard-image.png","/picked.svg"]);
  assert.equal(document.querySelector('.clipboard-import'),null);
  await act(async()=>document.querySelector<HTMLButtonElement>('.upload-zone')!.click());
  assert.equal(opened,3,"The photo upload zone also uses the picker");
  assert.equal(clipboardReads,beforeReads);
  await click("从剪贴板读取图片或文件"); await click("浏览其他文件"); assert.equal(opened,4);
  failPreview = true;
  await click("从剪贴板读取图片或文件"); assert.ok(document.querySelector('.clipboard-preview')?.textContent?.includes('preview unavailable'));
  await click("使用此文件"); assert.equal(imported.at(-1),"/clipboard.svg","Preview failure must not block import");
  files = [];
  await click("从剪贴板读取图片或文件"); assert.equal(opened,4,"An empty clipboard must not unexpectedly open a picker");
  await act(async () => root.unmount());
  console.log("PASS: file selection never reads clipboard; explicit clipboard import previews, cancels, browses, and tolerates preview failure (mock IPC).");
}
