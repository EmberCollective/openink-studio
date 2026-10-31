import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import { useCanvasEditing } from "../ui/src/CanvasEditing";
import { boundsOf, handlePoint, resizeHandles, type Drawing } from "../ui/src/editorGeometry";

export async function transformHandleChecks() {
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const fixture:Drawing={name:'handles',width_mm:160,height_mm:240,strokes:[[{x:10,y:10},{x:30,y:10},{x:30,y:20},{x:10,y:20},{x:10,y:10}]]};
  let latest=fixture,commits=0,scale=5;let replace:(doc:Drawing)=>void=()=>{};
  function Harness({locked=false,zoom=5}:{locked?:boolean;zoom?:number}) {
    const [doc,setDoc]=useState(fixture);latest=doc;replace=setDoc;scale=zoom;
    const edit=useCanvasEditing({document:doc,sourceKey:'handles',locked,extracting:false,onChange:(next)=>{commits++;setDoc(next);},onMessage:()=>{}});
    return <div className="canvas-panel">{edit.toolbar}{edit.historyToolbar}<svg viewBox="0 0 160 240" ref={(svg)=>{
      if(!svg)return;
      (svg as any).getScreenCTM=()=>({a:zoom,b:0,c:0,d:zoom,e:100,f:200,inverse:()=>({a:1/zoom,d:1/zoom,e:-100/zoom,f:-200/zoom})});
      (svg as any).createSVGPoint=()=>({x:0,y:0,matrixTransform(matrix:any){return {x:this.x*matrix.a+matrix.e,y:this.y*matrix.d+matrix.f};}});
    }}>{edit.layer}{edit.handles}</svg>{edit.inspector}</div>;
  }
  const render=async(locked=false,zoom=5)=>act(async()=>root.render(<Harness locked={locked} zoom={zoom}/>));
  const button=(title:string)=>{const node=[...host.querySelectorAll('button')].find(b=>b.title===title);assert.ok(node);return node;};
  const undo=async()=>act(async()=>button('撤销 Ctrl+Z').click());
  const handle=(id:string)=>host.querySelector(id==='rotate'?'[aria-label="旋转选区手柄"]':`[data-resize-handle="${id}"]`)!;
  const pointer=async(target:Element,type:string,p:{x:number;y:number},shiftKey=false)=>act(async()=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:100+p.x*scale,clientY:200+p.y*scale,shiftKey})));
  await render();assert.equal(host.querySelectorAll('[data-resize-handle]').length,0);await act(async()=>button('全选路径 Ctrl+A').click());
  assert.equal(host.querySelectorAll('[data-resize-handle]').length,8);assert.ok(handle('rotate'));
  assert.equal(Number(handle('se').querySelectorAll('circle')[1].getAttribute('r'))*scale,4,'Handle radius is four screen pixels');
  for(const id of resizeHandles){
    const before=JSON.stringify(latest),start=handlePoint(boundsOf(latest)!,id);
    const delta={x:id.includes('w')?-4:id.includes('e')?4:0,y:id.includes('n')?-2:id.includes('s')?2:0};
    const target={x:start.x+delta.x,y:start.y+delta.y},node=handle(id),previousCommits=commits;
    await pointer(node,'pointerdown',start);await pointer(node,'pointermove',target);
    assert.equal(JSON.stringify(latest),before,'Pointer previews do not mutate committed document');
    await pointer(node,'pointerup',target);assert.equal(commits,previousCommits+1);
    const box=boundsOf(latest)!;assert.ok(Math.abs(box.width-(delta.x?24:20))<1e-8);assert.ok(Math.abs(box.height-(delta.y?12:10))<1e-8);
    if(id.includes('w'))assert.equal(box.x+box.width,30);else assert.equal(box.x,10);
    if(id.includes('n'))assert.equal(box.y+box.height,20);else assert.equal(box.y,10);
    await undo();assert.equal(JSON.stringify(latest),JSON.stringify(fixture),'One undo restores one drag');
  }
  let node=handle('e');await pointer(node,'pointerdown',{x:30.6,y:15.4});await pointer(node,'pointerup',{x:30.6,y:15.4});assert.deepEqual(latest,fixture,'Off-center hit without movement must not jump');
  await pointer(node,'pointerdown',{x:30.6,y:15.4});await pointer(node,'pointermove',{x:31.6,y:15.4});await pointer(node,'pointerup',{x:31.6,y:15.4});assert.equal(boundsOf(latest)!.width,21,'Hit-area offset is preserved during resize');await undo();
  for(const cancel of ['pointercancel','lostpointercapture','escape']){
    node=handle('se');await pointer(node,'pointerdown',{x:30,y:20});await pointer(node,'pointermove',{x:34,y:22});
    if(cancel==='escape')await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));else await pointer(node,cancel,{x:34,y:22});
    await pointer(node,'pointerup',{x:34,y:22});assert.deepEqual(latest,fixture,`${cancel} discards preview`);
  }
  const rotation=handle('rotate'),rotationY=10-24/scale;await pointer(rotation,'pointerdown',{x:20,y:rotationY});await pointer(rotation,'pointermove',{x:20+(15-rotationY),y:15},true);
  assert.ok(host.querySelector('.selection-handles')?.getAttribute('transform')?.startsWith('rotate(90 '),'Preview frame rotates with the shape');
  await pointer(rotation,'pointerup',{x:20+(15-rotationY),y:15},true);assert.ok(Math.abs(boundsOf(latest)!.width-10)<1e-8);assert.ok(Math.abs(boundsOf(latest)!.height-20)<1e-8);await undo();
  node=handle('se');await pointer(node,'pointerdown',{x:30,y:20});await pointer(node,'pointermove',{x:34,y:22});await render(true);assert.equal(host.querySelectorAll('[data-resize-handle]').length,0);await pointer(node,'pointerup',{x:34,y:22});assert.deepEqual(latest,fixture,'Task lock cancels draft before commit');await render(false,10);
  assert.equal(Number(handle('se').querySelectorAll('circle')[1].getAttribute('r'))*10,4,'Zoom preserves screen handle size');
  node=handle('se');await pointer(node,'pointerdown',{x:30,y:20});await pointer(node,'pointermove',{x:34,y:22});const external={...fixture,strokes:fixture.strokes.map(s=>s.map(p=>({x:p.x+2,y:p.y})))};await act(async()=>replace(external));await pointer(node,'pointerup',{x:34,y:22});assert.deepEqual(latest,external,'External/numeric document commit cancels stale drag');
  await act(async()=>handle('e').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));assert.equal(boundsOf(latest)!.width,21,'Keyboard handle manipulation remains available');
  await act(async()=>root.unmount());host.remove();console.log('PASS: 8 resize handles/anchors, preview-only drag, one undo, off-center hits, rotate90 frame, cancel/Escape/capture loss, lock, zoom matrix and keyboard.');
}
