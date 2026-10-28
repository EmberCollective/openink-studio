import React, {act} from "react";
import {createRoot} from "react-dom/client";
import assert from "node:assert/strict";
import App from "../ui/src/App";

export async function editorMenuChecks() {
  const fixture={name:"menu.svg",width_mm:210,height_mm:297,strokes:[[{x:10,y:10},{x:20,y:20}]]};
  (globalThis as any).__openMock=async()=>"/menu.svg";
  (globalThis as any).__invokeMock=async(name:string,args:any)=>{
    if(name==="import_document")return structuredClone(fixture);
    if(name==="poll_device"||name.startsWith("list_"))return [];
    if(name==="default_import_options")return {};
    if(name==="optimize_document")return {document:args.document,stroke_order:[0],before_distance_mm:0,after_distance_mm:0,before_travel_seconds:0,after_travel_seconds:0};
    return null;
  };
  const root=createRoot(document.getElementById('root')!);
  const menu=()=>[...document.querySelectorAll('.application-menu')].find(m=>m.querySelector('summary')?.textContent==='编辑')!;
  const button=(text:string)=>[...menu().querySelectorAll('button')].find(b=>b.firstChild?.textContent===text)!;
  const click=async(text:string)=>{const b=button(text);assert.ok(b,text);assert.equal(b.disabled,false,text);await act(async()=>b.click());};
  const paths=()=>document.querySelectorAll('.canvas-edit-layer polyline').length;
  try {
    await act(async()=>root.render(<App/>));
    assert.ok(document.querySelector('.activity-rail [aria-label="素材"]'));
    assert.ok(document.querySelector('.activity-rail [aria-label="画板"]'));
    assert.equal([...document.querySelectorAll('.application-menu > summary')].some(s=>s.textContent==='视图'),false);
    assert.equal(button('粘贴').disabled,true);
    await act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='导入素材…')!.click());
    await click('全选');
    assert.ok(document.querySelector('.right-panel .selection-inspector'));
    assert.equal(document.querySelector('.canvas-panel > .selection-inspector'),null);
    await click('复制');await click('粘贴');assert.equal(paths(),2);
    await click('剪切');assert.equal(paths(),1);
    await click('撤销');assert.equal(paths(),2);
    await click('重做');assert.equal(paths(),1);
    console.log('PASS: genuine Edit menu undo/redo/copy/cut/paste, retained left rail, right-side inspector and no unsupported View menu.');
  } finally {await act(async()=>root.unmount());}
}
