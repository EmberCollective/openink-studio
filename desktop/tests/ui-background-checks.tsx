import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import App from '../ui/src/App';

export async function backgroundChecks(){
 const requests:{name:string,args:any}[]=[];const events:any[]=[];
 let path='/offline/ink.svg';
 const fixture={name:'Background ink',width_mm:160,height_mm:240,strokes:[[{x:10,y:10},{x:20,y:20}]]};
 (globalThis as any).__openMock=async()=>path;
 (globalThis as any).__invokeMock=async(name:string,args:any)=>{
  requests.push({name,args:JSON.parse(JSON.stringify(args??{}))});
  if(name==='poll_device')return events.splice(0);
  if(name==='import_document')return structuredClone(fixture);
  if(name==='pdf_background_page')return {data_url:`data:image/png;base64,cGFnZQ${args.page}==`,page_count:2,width_mm:210,height_mm:297};
  if(name==='default_import_options')return {};
  if(['list_fonts','list_legacy_fonts','list_glyph_fonts','list_templates','list_registration_profiles'].includes(name))return [];
  if(name==='optimize_document')return {document:args.document,stroke_order:[0],before_distance_mm:0,after_distance_mm:0,before_travel_seconds:0,after_travel_seconds:0};
  return null;
 };
 const button=(text:string)=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text||b.title===text);assert.ok(b,`Missing ${text}`);return b;};
 const click=async(text:string)=>{await act(async()=>button(text).click());};
 const paths=()=>[...document.querySelectorAll('.canvas-edit-layer polyline')].map(p=>p.getAttribute('points'));
 const root=createRoot(document.getElementById('root')!);
 try{
  await act(async()=>root.render(<App/>));await click('优化轨迹');await click('导入素材…');const original=paths();
  const board=document.querySelector('nav.activity-rail button[aria-label="画板"]') as HTMLButtonElement;
  await act(async()=>board.click());path='/offline/form.pdf';await click('导入 PDF 作为背景');
  assert.equal(document.querySelector('[aria-label="纸张背景设置"]'),null,'PDF remains a direct background import without the photo wizard');
  assert.equal(requests.filter(r=>r.name==='paper_background').length,0);
  assert.equal(requests.filter(r=>r.name==='pdf_background_page').length,2,'Every PDF page provides its actual dimensions before commit');
  assert.deepEqual(paths(),original,'Background import must preserve existing ink');
  const image=()=>document.querySelector('image[aria-label="PDF 背景（不可选中）"]')!;
  assert.ok(image());assert.equal(image().getAttribute('pointer-events'),'none');
  assert.equal(image().getAttribute('preserveAspectRatio'),'none','Map the entire PDF page to paper edges without added letterboxing or cropping');
  assert.equal(image().getAttribute('x'),'0');assert.equal(image().getAttribute('y'),'0');
  assert.equal(image().getAttribute('width'),'210');assert.equal(image().getAttribute('height'),'297');
  assert.deepEqual(requests.find(r=>r.name==='pdf_background_page')!.args,{path,page:1});
  await click('下一页画板');assert.deepEqual(paths(),[],'Each PDF page starts with an independent empty ink layer');
  assert.equal(requests.filter(r=>r.name==='pdf_background_page').at(-1)!.args.page,2);
  path='/offline/page-two.svg';await click('导入素材…');await click('全选路径 Ctrl+A');
  const x=document.querySelector('input[aria-label="选区X"]') as HTMLInputElement;assert.ok(x);
  await act(async()=>{x.focus();Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(x,'25');x.dispatchEvent(new Event('input',{bubbles:true}));});await act(async()=>x.blur());
  const second=paths();assert.deepEqual(second,['25,10 35,20']);
  await click('上一页画板');assert.deepEqual(paths(),original);await click('下一页画板');assert.deepEqual(paths(),second,'Returning to a page preserves its inserted ink');
  await click('导出 SVG');const exported=requests.filter(r=>r.name==='export_document').at(-1)!.args.document;
  assert.deepEqual(exported.strokes,[[{x:25,y:10},{x:35,y:20}]]);assert.equal(JSON.stringify(exported).includes('data:image'),false,'Background raster must never enter exported drawing');
  assert.equal([...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='新建四角定位页'),false);
  assert.equal([...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='当前笔尖设为画布右上角'),false);
  assert.ok(button('重置到画布左上角'));
  events.push({type:'connected',port:'MOCK'},{type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,230));});
  await click('设备控制');
  const before=requests.filter(r=>r.name==='device_command').length;
  await click('重置到画布左上角');
  assert.equal(requests.filter(r=>r.name==='device_command').length,before+1,'Origin setting must execute immediately without confirmation');
  assert.deepEqual(requests.filter(r=>r.name==='device_command').at(-1)!.args.command,{type:'reset_origin'});
  console.log('PASS: PDF background A4, non-selectable raster, independent page ink preservation and ink-only export; origin reset executes without confirmation.');
 }finally{await act(async()=>root.unmount());}
}
