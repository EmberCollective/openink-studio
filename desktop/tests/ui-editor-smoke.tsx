import {editorMenuChecks} from "./ui-editor-menu-checks";
import {projectLifecycleChecks} from "./ui-project-lifecycle-checks";
import {registrationChecks} from "./ui-registration-checks";
import {projectChecks} from "./ui-project-checks";
import {clipboardChecks} from "./ui-clipboard-checks";
import {paperChecks} from './ui-paper-checks';
import {backgroundChecks} from './ui-background-checks';
import {DraftNumberInput} from "../ui/src/DraftNumberInput";
import {panChecks} from './ui-pan-checks';
import {registrationHandleChecks} from './ui-registration-handles-checks';
import {calibrationChecks} from './ui-calibration-checks';
import {DocumentEditLock} from "../ui/src/documentEditPolicy";
import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {useCanvasEditing} from '../ui/src/CanvasEditing';
import type {Drawing} from '../ui/src/editorGeometry';
import App from '../ui/src/App';
import { routeHookChecks } from './ui-route-checks';
import { transformHandleChecks } from './ui-transform-checks';
import { writtenChecks } from './ui-written-checks';
import {mapMachineCoordinates,outsideDirection} from '../ui/src/coordinateGeometry';

// Fixed-paper positioning replaces earlier first-point anchoring assertions.
// Telemetry, jogging, source changes and job_started must never redefine origin.
// Only confirmed calibration changes that origin; IPC and hardware stay mocked.

const fixture:Drawing={name:'Offline generated trajectory fixture',width_mm:160,height_mm:240,strokes:[[{x:10,y:10},{x:20,y:20}],[{x:50,y:50},{x:60,y:60}]]};
let latest:Drawing=fixture;
function Harness(){const[doc,setDoc]=useState(fixture);latest=doc;const edit=useCanvasEditing({document:doc,sourceKey:'fixture-1',locked:false,extracting:false,onChange:setDoc,onMessage:()=>{}});return <div className="canvas-panel">{edit.toolbar}{edit.historyToolbar}<svg viewBox="0 0 160 240">{edit.layer}</svg>{edit.inspector}</div>}
function findButton(text:string){const button=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text||b.title===text);assert.ok(button,`Missing button ${text}`);return button}
async function click(text:string){await act(async()=>findButton(text).click())}
async function number(label:string,value:number){const input=document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;assert.ok(input,`Missing ${label}`);await act(async()=>{input.focus();Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,String(value));input.dispatchEvent(new Event('input',{bubbles:true}));});await act(async()=>input.blur());}
async function pointer(type:string,x:number,y:number){const layer=document.querySelector('.canvas-edit-layer.active')!;assert.ok(layer);await act(async()=>layer.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:x*10,clientY:y*10})));}
async function dragBox(x0:number,y0:number,x1:number,y1:number){await pointer('pointerdown',x0,y0);await pointer('pointermove',x1,y1);await pointer('pointerup',x1,y1);}
const copy=(value:unknown)=>JSON.parse(JSON.stringify(value));
function independentCoordinateChecks(){
 // Fixed paper origin replaces the old first-point minus live-anchor convention.
 const result=mapMachineCoordinates([5,14],[-3,4,0]);assert.ok(result);
 assert.deepEqual(result.origin,{x:5,y:14});assert.deepEqual(result.pen,{x:2,y:10});
 assert.deepEqual(mapMachineCoordinates([5,14],[8,-9,0])?.origin,result.origin,'Telemetry changes must never redefine the fixed paper origin');
 assert.equal(mapMachineCoordinates([5,NaN],[0,0,0]),null);assert.equal(mapMachineCoordinates([5,14],null)?.pen,null);
 assert.equal(outsideDirection({x:-20,y:250},160,240),'左侧 / 下方');
 console.log('PASS: independent signed coordinate fixtures, fixed-paper invariant, unknown coordinates and out-of-page direction.');
}
async function poll(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,230));});}
async function appIntegration(){
 const events:any[]=[];const requests:{name:string;args:any}[]=[];
 (globalThis as any).__openMock=async()=>'/offline/trajectory.svg';
 (globalThis as any).__invokeMock=async(name:string,args:any)=>{
   requests.push({name,args:copy(args??{})});if(name==='optimize_document')return {document:copy(args.document),stroke_order:args.document.strokes.map((_:unknown,i:number)=>i),before_distance_mm:100,after_distance_mm:20,before_travel_seconds:4,after_travel_seconds:.8};
   if(name==='poll_device')return events.splice(0);
   if(name==='import_document')return copy(fixture);
   if(name==='default_import_options')return {};
   if(['list_fonts','list_legacy_fonts','list_glyph_fonts','list_templates','list_registration_profiles'].includes(name))return [];
   if(name==='generate_gcode')return '; OFFLINE MOCK — no controller commands sent';
   return null;
 };
 const root=createRoot(document.getElementById('root')!);await act(async()=>root.render(<App/>));
 assert.equal(findButton('优化轨迹').getAttribute('aria-pressed'),'true','Trajectory optimization defaults ON and remains user-controllable');await click('优化轨迹');
 await click('导入素材…');assert.ok(document.querySelector('svg .canvas-edit-layer.active'),'SVG import must be immediately editable without enabling a mode');await dragBox(2,2,22,22);
 await number('选区X',25);
 const shapes=()=>[...document.querySelectorAll('.canvas-edit-layer polyline')].map(p=>p.getAttribute('points'));
 assert.equal(shapes()[0],'25,10 35,20','App must preserve edited selection translation');assert.equal(shapes()[1],'50,50 60,60','App global preparation must not move an unselected path');
 await click('撤销 Ctrl+Z');assert.equal(shapes()[0],'10,10 20,20','App sourceKey must preserve undo history across document edits');
 await click('重做 Ctrl+Shift+Z');assert.equal(shapes()[0],'25,10 35,20','App redo must restore edited coordinates and selection');
 await dragBox(0,0,70,70);await number('选区X',32);
 assert.equal(shapes()[0],'32,10 42,20','App must not renormalize whole-selection translation');assert.equal(shapes()[1],'57,50 67,60','Whole-selection translation must shift every path by the same offset');
 assert.equal(document.querySelector('.page-heading'),null,'Workspace must not reserve a marketing hero');
 assert.equal(document.querySelector('.ruler-top, .ruler-left'),null,'Approved workspace has no rulers');
 assert.ok(document.querySelector('.canvas-panel .canvas-pointer-wrapper'),'Coordinate observation wraps the real paper for every editing tool');
 assert.equal(document.querySelector('.topbar-actions > :last-child')?.getAttribute('aria-label'),'规划与机器侧栏','Right sidebar toggle stays at the far-right topbar location');
 assert.ok(document.querySelector('.canvas-toolbar .path-edit-toolbar'),'Editing belongs above the canvas');assert.ok(document.querySelector('.canvas-bottom .history-tools'),'History belongs at the bottom left');assert.equal(document.querySelector('.topbar .path-edit-toolbar'),null);
 const footerInsert=document.querySelector('.left-panel > fieldset > .left-action') as HTMLElement;
 assert.ok(footerInsert,'Insert action must be a fixed sibling of the scroll area');assert.equal(footerInsert.hidden,false);
 const css=fs.readFileSync('desktop/ui/src/styles.css','utf8');
 assert.ok(!/\.left-panel\s+\.panel-scroll\s+\.button\.primary\s*\{\s*display:\s*none/.test(css),'A broad primary-button hide rule can suppress the only insert action');
 const inlineRule=css.match(/\.left-panel \.inline-submit\s*\{[^}]+\}/)![0];
 const visibilityStyle=document.createElement('style');visibilityStyle.textContent='.button { display: inline-flex; }'+inlineRule;document.head.append(visibilityStyle);
 assert.notEqual(window.getComputedStyle(footerInsert.querySelector('button')!).display,'none','Actual insertion footer must remain visible under production hide selector');
 document.querySelectorAll('.left-panel .inline-submit').forEach(button=>assert.equal(window.getComputedStyle(button).display,'none','Only redundant inline actions are hidden'));visibilityStyle.remove();
 assert.equal(document.querySelector('g[aria-label="完整走线"]'),null,'Complete route must default off for dense glyph pages');
 const boardTab=document.querySelector('nav.activity-rail button[aria-label="画板"]') as HTMLButtonElement;
 const materialTab=document.querySelector('nav.activity-rail button[aria-label="素材"]') as HTMLButtonElement;
 const preservedInput=document.querySelector('.left-panel textarea') as HTMLTextAreaElement;
 const preservedValue=preservedInput?.value;
 await act(async()=>boardTab.click());assert.equal(boardTab.getAttribute('aria-pressed'),'true');assert.equal(footerInsert.hidden,true,'Board tab does not expose material insertion action');
 await act(async()=>materialTab.click());assert.equal(footerInsert.hidden,false,'Returning to materials restores the insertion action');assert.equal(document.querySelector('.left-panel textarea'),preservedInput,'Tab switches retain the same input instance');assert.equal(preservedInput?.value,preservedValue);
 const leftToggle=materialTab;
 const rightToggle=()=>(document.querySelector('button[aria-label="规划与机器侧栏"]') as HTMLButtonElement).click();
 const beforeHide=shapes();await act(async()=>{leftToggle.click();rightToggle();});
 assert.equal((document.querySelector('.left-panel') as HTMLElement).hidden,true);assert.equal((document.querySelector('.right-panel') as HTMLElement).hidden,true);
 assert.deepEqual(shapes(),beforeHide,'Independent sidebars do not reset edited canvas');assert.ok(document.querySelector('.canvas-edit-layer.active'));
 await act(async()=>{leftToggle.click();rightToggle();});
 assert.equal(document.querySelector('g[aria-label="完整走线"]'),null);
 await poll();assert.equal([...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='查看完整走线'),false,'Main canvas has no complete-route switch');
 assert.equal(document.querySelector('g[aria-label="单笔定位"]'),null,'Automatic planning does not show any route overlay');
 await click('重新计算走线');await poll();assert.equal(document.querySelector('g[aria-label="单笔定位"]'),null,'Recompute does not open route visualization');
 await click('定位');assert.ok(document.querySelector('g[aria-label="已选第1笔"]'));assert.equal(document.querySelectorAll('g[aria-label="单笔定位"] polyline').length,2,'Single chosen stroke and outline only');
 await click('下一笔');assert.ok(document.querySelector('g[aria-label="已选第2笔"]'));assert.equal(document.querySelector('g[aria-label="已选第1笔"]'),null);
 await click('上一笔');assert.ok(document.querySelector('g[aria-label="已选第1笔"]'));assert.deepEqual(shapes(),beforeHide,'Route inspection cannot mutate editor geometry');
 await click('导出 SVG');const exported=requests.filter(r=>r.name==='export_document').at(-1)!.args.document;
 assert.equal((document.querySelector('input[aria-label="描线速率"]') as HTMLInputElement).value,'1500');
 assert.equal((document.querySelector('input[aria-label="移动速度"]') as HTMLInputElement).value,'2500');
 assert.equal((document.querySelector('input[aria-label="Z速率"]') as HTMLInputElement).value,'3000');
 assert.equal((document.querySelector('input[aria-label="落笔下探"]') as HTMLInputElement).value,'4');
 await number('落笔下探',1);assert.equal((document.querySelector('input[aria-label="落笔下探"]') as HTMLInputElement).value,'2');
 await number('落笔下探',11);assert.equal((document.querySelector('input[aria-label="落笔下探"]') as HTMLInputElement).value,'10');await number('落笔下探',7);
 await click('预览 CNC / G-code');const generated=requests.filter(r=>r.name==='generate_gcode').at(-1)!.args.job.document;
 assert.equal(requests.filter(r=>r.name==='generate_gcode').at(-1)!.args.job.z_down,7,'CNC uses committed Z down depth');
 const draft=requests.filter(r=>r.name==='generate_gcode').at(-1)!.args;assert.equal(draft.relative,false);assert.equal(draft.origin,null);assert.match(document.querySelector('[role="dialog"]')!.textContent!,/当前笔尖/,'Uncalibrated code preview must identify its draft origin source');
 assert.deepEqual(exported.strokes,generated.strokes,'SVG export and G-code must share edited geometry');await click('关闭');
 events.push({type:'connected',port:'MOCK'},{type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}},{type:'origin_mode',automatic:false},{type:'calibration_changed',origin:[12,16]});await poll();
 events.push({type:'status',status:{state:'Idle',position:[0,0,4],wco:[0,0,0]}});await poll();
 assert.equal(findButton('开始书写').disabled,false,'Starting at Z4 must be allowed because backend lifts automatically');
 await click('落笔 Z7');assert.equal(requests.filter(r=>r.name==='device_command'&&r.args.command.type==='pen_down').at(-1)!.args.command.depth,7,'Manual pen down uses the same committed depth');
 events.push({type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}});await poll();
 await click('预览 CNC / G-code');const calibratedCode=requests.filter(r=>r.name==='generate_gcode').at(-1)!.args;
 assert.equal(calibratedCode.relative,false,'Calibrated preview must use fixed absolute canvas positioning');assert.deepEqual(calibratedCode.origin,[12,16]);assert.deepEqual(calibratedCode.job.document.strokes,exported.strokes);
 await click('导出 .gcode');assert.equal(requests.filter(r=>r.name==='export_gcode').at(-1)!.args.job.z_down,7);assert.deepEqual(requests.filter(r=>r.name==='export_gcode').at(-1)!.args.origin,[12,16],'G-code export must use the same calibrated paper origin as Run');await click('关闭');
 await click('开始书写');const sent=requests.filter(r=>r.name==='device_command'&&r.args.command.type==='run').at(-1)!.args.command.job.document;
 assert.equal(requests.filter(r=>r.name==='device_command'&&r.args.command.type==='run').at(-1)!.args.command.job.z_down,7,'Run freezes same Z depth as preview/export');
 assert.equal(requests.filter(r=>r.name==='optimize_document').length,0,'Explicit OFF sends raw paths through preview/export/Run without invoking optimizer');
 assert.equal(findButton('优化轨迹').closest('fieldset')?.disabled,true,'Trajectory choice locks during a task');
 assert.equal((document.querySelector('input[aria-label="落笔下探"]') as HTMLInputElement).disabled,true,'Z depth is frozen during task');
 assert.deepEqual(sent.strokes,exported.strokes,'Queued mock Job must match exported edited geometry');
 const plannedBeforeMotion=requests.filter(r=>r.name==='optimize_document').length;
 events.push({type:'timing',total_seconds:120,cumulative_seconds:[20,120]},{type:'job_started'},{type:'progress',sent:2,total:2},{type:'status',status:{state:'Run',position:[3,-4,0],wco:[0,0,0]}});await poll();
 assert.ok(document.querySelector('[aria-label="任务时间估算"]')?.textContent?.includes('预计总耗时'));assert.ok(document.querySelector('[aria-label="任务时间估算"]')?.textContent?.includes('等待设备完成'),'All ACKed commands still wait for physical device completion');
 await click('预览 CNC / G-code');
 assert.deepEqual(requests.filter(r=>r.name==='generate_gcode').at(-1)!.args.job.document.strokes,sent.strokes,'Active-job CNC must retain frozen route after pen moves');
 await click('导出 .gcode');assert.deepEqual(requests.filter(r=>r.name==='export_gcode').at(-1)!.args.job.document.strokes,sent.strokes);
 assert.equal(requests.filter(r=>r.name==='optimize_document').length,plannedBeforeMotion,'Active preview/export must not plan from moving pen');await click('关闭');
 assert.equal((document.querySelector('.path-edit-toolbar button') as HTMLButtonElement).disabled,true,'Editing must lock while a job is active');
 await act(async()=>rightToggle());assert.equal((document.querySelector('.right-panel') as HTMLElement).hidden,true);
 assert.ok(document.querySelector('.topbar button.danger'),'Stop remains accessible with machine panel collapsed');assert.equal(document.querySelector('.canvas-edit-layer.active'),null);
 await act(async()=>rightToggle());assert.equal(document.querySelector('.canvas-edit-layer.active'),null,'Reopening panel must not bypass active job read-only policy');
 events.push({type:'job_rejected',reason:'mock repeated command refused; current job remains active',running:true});await poll();
 assert.ok(document.querySelector('.status-message')?.textContent?.includes('mock repeated command refused; current job remains active'),'The rejected-command reason field must be presented in the visible status message');
 assert.equal(findButton('开始书写').disabled,true,'Rejected extra command must not mark an active job idle');
 events.push({type:'job_rejected',reason:'mock preflight rejected',running:false},{type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}});await poll();
 assert.ok(document.querySelector('.status-message')?.textContent?.includes('mock preflight rejected'),'The preflight rejection reason must be presented in the visible status message');
 assert.equal(findButton('开始书写').disabled,false,'Preflight rejection must release running state while retaining connection');
 await act(async()=>root.unmount());
 console.log('PASS: real App with mocked IPC — import, edited coordinates, SVG/G-code/Job parity, edit lock, job_rejected active/idle state. No native runtime or hardware exercised.');
}
async function sourceParity(kind:'pdf'|'gfont'){
 const requests:{name:string,args:any}[]=[];
 (globalThis as any).__openMock=async()=>'/offline/current-upload.pdf';
 (globalThis as any).__invokeMock=async(name:string,args:any)=>{
   requests.push({name,args:copy(args??{})});if(name==='optimize_document')return {document:copy(args.document),stroke_order:args.document.strokes.map((_:unknown,i:number)=>i),before_distance_mm:100,after_distance_mm:20,before_travel_seconds:4,after_travel_seconds:.8};
   if(name==='poll_device')return [];
   if(name==='import_document')return {...copy(fixture),name:'Current PDF mock conversion'};
   if(name==='pdf_page_count')return 3;
   if(name==='private_gfont_available')return kind==='gfont';
   if(name==='legacy_font_document')return {document:{...copy(fixture),name:'Current gfont mock composition'},missing:[],choices:['/offline/smoke.gfont']};
   if(name==='list_legacy_fonts')return [{display:'Smoke gfont',version:1,size:100,count:200,author:'Offline test',description:'Mock font metadata',path:'/offline/smoke.gfont',preview_strokes:fixture.strokes}];
   if(name==='default_import_options')return {};
   if(['list_fonts','list_glyph_fonts','list_templates','list_registration_profiles'].includes(name))return [];
   return null;
 };
 const root=createRoot(document.getElementById('root')!);await act(async()=>root.render(<App/>));
 if(kind==='pdf'){
   assert.equal(document.querySelector('option[value="legacy"]'),null,'Public builds must hide the private font source');
   assert.ok(!requests.some(r=>r.name==='list_legacy_fonts'),'Public startup must not call private commands');
   assert.equal(document.querySelector('.legacy-picker'),null);
   await click('导入素材…');assert.equal(requests.find(r=>r.name==='import_document')?.args.path,'/offline/current-upload.pdf');
 }else{
   const select=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='legacy'))!;assert.ok(select);
   await act(async()=>{select.value='legacy';select.dispatchEvent(new Event('change',{bubbles:true}));});
   await act(async()=>(document.querySelector('.legacy-picker') as HTMLButtonElement).click());
   const checkbox=document.querySelector('input[aria-label="选中Smoke gfont"]') as HTMLInputElement;assert.ok(checkbox);await act(async()=>checkbox.click());
   await click('确认选择');await click('插入文字到画布');assert.ok(requests.some(r=>r.name==='legacy_font_document'),'gfont text generation must use its real App command entry');
 }
 const layers=document.querySelectorAll('svg .canvas-edit-layer');assert.equal(layers.length,1,`${kind} must use exactly the common SVG editor layer`);assert.ok(layers[0].classList.contains('active'),`${kind} must allow immediate box selection`);assert.equal(layers[0].querySelectorAll('polyline').length,2);
 await dragBox(2,2,22,22);await number('选区X',25);
 const shapes=[...layers[0].querySelectorAll('polyline')].map(p=>p.getAttribute('points'));
 assert.deepEqual(shapes,['25,10 35,20','50,50 60,60'],`${kind} must use the same no-drift selection transformation`);
 if(kind==='gfont'){
   await click('插入文字到画布');assert.equal(document.querySelectorAll('.canvas-edit-layer polyline').length,4,'Generating another gfont material must append');
   assert.deepEqual([...document.querySelectorAll('.canvas-edit-layer polyline')].slice(0,2).map(p=>p.getAttribute('points')),shapes,'gfont insertion must retain previous edited paths');
 }
 await act(async()=>root.unmount());console.log(`PASS: ${kind} App source uses the same immediately active SVG editor layer and box-selection transform (mocked conversion/composition).`);
}
async function recoveryAndCoordinates(){
 const events:any[]=[];const requests:{name:string,args:any}[]=[];
 let opened=0;(globalThis as any).__openMock=async()=>++opened===1?'/offline/trajectory.svg':'/offline/replacement.svg';
 (globalThis as any).__invokeMock=async(name:string,args:any)=>{
  requests.push({name,args:copy(args??{})});if(name==='optimize_document')return {document:copy(args.document),stroke_order:args.document.strokes.map((_:unknown,i:number)=>i),before_distance_mm:100,after_distance_mm:20,before_travel_seconds:4,after_travel_seconds:.8};if(name==='poll_device')return events.splice(0);if(name==='import_document'){const doc=copy(fixture);if(args.path.endsWith('replacement.svg'))doc.strokes.reverse();return doc;}if(name==='default_import_options')return {};if(['list_fonts','list_legacy_fonts','list_glyph_fonts','list_templates','list_registration_profiles'].includes(name))return [];return null;
 };
 const root=createRoot(document.getElementById('root')!);await act(async()=>root.render(<App/>));await click('导入素材…');
 const marker=(kind:string)=>document.querySelector(`svg .coordinate-overlay [data-coordinate="${kind}"]`);
 const assertMarker=(kind:string,x:number,y:number)=>{const node=marker(kind);assert.ok(node,`Missing ${kind} marker`);assert.ok(Math.abs(Number(node.getAttribute('data-x'))-x)<1e-8,`${kind} X must agree with the independent work-coordinate mapping`);assert.ok(Math.abs(Number(node.getAttribute('data-y'))-y)<1e-8,`${kind} Y must agree with the independent work-coordinate mapping`);};
 assert.equal(marker('origin'),null,'Unknown controller position must not invent an origin');assert.equal(marker('pen'),null,'Unknown controller position must not invent a pen location');
 assert.ok(document.querySelector('.coordinate-unknown')?.textContent,'Uncalibrated controller must present a visible explanation');
 events.push({type:'ports',ports:[{name:'MOCK',description:'Offline mock controller',preferred:true}]},{type:'connected',port:'MOCK'},{type:'status',status:{state:'Idle',position:[5,-6,0],wco:[0,0,0]}});await poll();
 assert.equal(findButton('开始书写').disabled,false);assert.equal(findButton('移动到指定点').disabled,true);assert.equal(findButton('电动返回工作原点 XY0').disabled,true);
 assert.equal(marker('origin'),null,'Known telemetry must not auto-calibrate the paper origin');
 const jogRight=document.querySelector('button.jog.right') as HTMLButtonElement;assert.equal(jogRight.disabled,false,'Uncalibrated manual jogging must remain available');

 for(const label of ['选择','拖动','设置工作原点']) { const tool=document.querySelector(`button[aria-label="${label}"]`);assert.ok(tool?.querySelector('svg'),`${label} must be one SVG icon`);assert.equal(tool.textContent?.trim(),'',`${label} must not mix text`);assert.ok(tool.getAttribute('title')?.includes(label),`${label} needs a hover explanation`); }
 assert.ok(findButton('将当前位置设为工作原点'));assert.ok(findButton('重置到画布左上角'));assert.equal(document.body.textContent?.includes('确认重置为当前笔尖位置'),false);
 events.push({type:'status',status:{state:'Idle',position:[5,-6,0],wco:[0,0,0]}},{type:'origin_mode',automatic:false},{type:'calibration_changed',origin:[5,14]},{type:'positioning',active:false});await poll();
 assertMarker('start',10,10);assertMarker('origin',5,14);assertMarker('pen',10,20);
 await number('移动速度',12000);
 await act(async()=>jogRight.click());assert.ok(requests.filter(r=>r.name==='device_command'&&r.args.command.type==='jog').at(-1)!.args.command.x>0);
 assert.equal(requests.filter(r=>r.name==='device_command'&&r.args.command.type==='jog').at(-1)!.args.command.feed,12000,'Jog must preserve the selected travel feed without a hidden cap');
 events.push({type:'status',status:{state:'Idle',position:[7,-9,0],wco:[0,0,0]}});await poll();assertMarker('origin',5,14);assertMarker('pen',12,23);
 await click('导入素材…');assert.equal(requests.filter(r=>r.name==='import_document').at(-1)!.args.path,'/offline/replacement.svg');assertMarker('start',10,10);assertMarker('origin',5,14);assertMarker('pen',12,23);
 await number('目标画布X',30);await number('目标画布Y',25);await click('移动到指定点');
 const move=requests.filter(r=>r.name==='device_command'&&r.args.command.type==='move_to').at(-1)!.args.command;assert.equal(move.canvas_x,30);assert.equal(move.canvas_y,25);
 assert.equal(move.feed,12000,'Explicit canvas move must preserve selected travel feed without a hidden cap');
 events.push({type:'positioning',active:true});await poll();assert.equal(findButton('开始书写').disabled,true);assert.equal(findButton('停止').disabled,false,'Stop must remain available while an explicit position move is busy');assert.equal(document.querySelector('.canvas-edit-layer.active'),null);
 await click('停止');events.push({type:'stopped'},{type:'positioning',active:false},{type:'status',status:{state:'Idle',position:[7,-9,0],wco:[0,0,0]}});await poll();assertMarker('origin',5,14);
 await click('电动返回工作原点 XY0');assert.equal(requests.filter(r=>r.name==='device_command'&&r.args.command.type==='return_origin').length,1);
 events.push({type:'positioning',active:true},{type:'error',message:'mock positioning refused; no arrival confirmed'},{type:'positioning',active:false});await poll();assert.ok(document.querySelector('.status-message')?.textContent?.includes('mock positioning refused; no arrival confirmed'),'A failed positioning operation must not invent an arrival success');
 await click('开始书写');events.push({type:'job_started',anchor:[99,-88,0]},{type:'status',status:{state:'Run',position:[9,-10,0],wco:[0,0,0]}});await poll();assertMarker('origin',5,14);assertMarker('pen',14,24);
 await click('停止');events.push({type:'stopped'},{type:'status',status:{state:'Idle',position:[9,-10,0],wco:[2,3,0]}});await poll();
 assert.ok(document.querySelector('.connection-badge')?.textContent?.includes('MOCK 已连接'),'Stopped must preserve a live connection');
 assert.ok(document.querySelector('.coordinate-overlay')?.textContent?.includes('工作原点'),'Nonzero WCO must retain an explicitly work-coordinate origin label');
 assert.ok(!document.querySelector('.coordinate-overlay')?.textContent?.includes('机器原点'),'Work coordinates must not be labelled machine-origin MPos');
 assertMarker('origin',5,14);assertMarker('pen',14,24);
 events.push({type:'origin_mode',automatic:false},{type:'calibration_changed',origin:[-20,4]});await poll();assertMarker('origin',-20,4);
 assert.equal(marker('origin')?.getAttribute('data-outside'),'true');assert.ok(document.querySelector('.origin-outside-note')?.textContent?.includes('左侧'),'Out-of-page origin must show its actual direction');assert.ok(document.querySelector('.origin-outside-note')?.textContent?.includes('(-20.00, 4.00)'),'Out-of-page origin must show its actual canvas coordinates');
 events.push({type:'disconnected'});await poll();
 assert.equal(marker('origin'),null,'Disconnect must invalidate confirmed paper calibration');assert.equal(findButton('移动到指定点').disabled,true);assert.equal(findButton('电动返回工作原点 XY0').disabled,true);
 assert.ok(![...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='清除旧任务并恢复连接'),'Ordinary offline state should not present failure recovery');
 await click('连接设备');events.push({type:'error',message:'mock connection failed'},{type:'disconnected'});await poll();
 await click('清除旧任务并恢复连接');assert.equal(requests.filter(r=>r.name==='device_command'&&r.args.command.type==='recover').length,1,'Recovery must use the explicit recover command after failed connection');
 assert.equal(requests.filter(r=>r.name==='device_command'&&r.args.command.type==='recover').at(-1)!.args.command.port,'MOCK','Recovery must identify the currently connected port');
 events.push({type:'recovering',active:true});await poll();assert.equal(findButton('开始书写').disabled,true,'Recovery must block new jobs');assert.equal(document.querySelector('.canvas-edit-layer.active'),null,'Recovery must lock canvas editing');assert.equal(findButton('清除旧任务并恢复连接').disabled,true,'Recovery must not allow a second recovery request');
 assert.equal((document.querySelector('fieldset.recovery-lock') as HTMLFieldSetElement).disabled,true,'Recovery must disable the whole application fieldset');
 events.push({type:'connected',port:'MOCK'},{type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}});await poll();assert.equal(findButton('开始书写').disabled,true,'Even fresh online Idle/Z0 telemetry cannot unlock a recovery still in progress');assert.equal(document.querySelector('.canvas-edit-layer.active'),null);
 events.push({type:'error',message:'mock recovery handshake failed'},{type:'disconnected'},{type:'recovering',active:false});await poll();
 assert.ok(document.querySelector('.status-message')?.textContent?.includes('mock recovery handshake failed'),'Failed recovery must present the actual failure');
 assert.ok(!document.querySelector('.connection-badge')?.textContent?.includes('已连接'),'Failed recovery must not display successful connection');assert.equal(findButton('开始书写').disabled,true);
 await act(async()=>root.unmount());console.log('PASS: recovery lifecycle and independent SVG work-coordinate mapping; mocked IPC only, no serial or native GUI.');
}
async function numericDraftChecks(){
 let committed=12;
 function Inputs(){const [value,setValue]=useState(12);return <DraftNumberInput aria-label="draft regression" type="number" min={10} max={100} value={value} onChange={e=>{committed=Number(e.target.value);setValue(committed)}}/>}
 const root=createRoot(document.getElementById('root')!);await act(async()=>root.render(<Inputs/>));
 const input=document.querySelector('input')!;
 async function edit(text:string){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));});}
 await act(async()=>input.focus());await edit('');assert.equal(input.value,'');assert.equal(committed,12);
 await edit('1');assert.equal(input.value,'1');assert.equal(committed,12,'Partial numbers must not commit or clamp');
 await edit('75');assert.equal(input.value,'75');assert.equal(committed,12);await act(async()=>input.blur());assert.equal(committed,75);
 await act(async()=>input.focus());await edit('');await act(async()=>input.blur());assert.equal(committed,75);assert.equal(input.value,'75','Empty blur restores prior value instead of zero');
 await act(async()=>input.focus());await edit('4');assert.equal(input.value,'4');await act(async()=>input.blur());assert.equal(committed,10,'Bounds apply only on blur');
 await act(async()=>root.unmount());
 let speed=300;
 function Speed(){const [value,setValue]=useState(300);return <DraftNumberInput aria-label="draft regression" type="number" positive value={value} onChange={e=>{speed=Number(e.target.value);setValue(speed)}}/>}
 const speedRoot=createRoot(document.getElementById('root')!);await act(async()=>speedRoot.render(<Speed/>));
 await number('draft regression',12500);assert.equal(speed,12500,'Positive speeds have no arbitrary upper bound');
 await number('draft regression',0);assert.equal(speed,12500);await number('draft regression',-3);assert.equal(speed,12500);
 await number('draft regression',0.5);assert.equal(speed,0.5,'All finite positive speeds are accepted');
 await act(async()=>speedRoot.unmount());console.log('PASS: numeric drafts preserve empty and partial edits; clamp only on blur; speed accepts any finite positive value.');
 let setLock:(locked:boolean)=>void=()=>{};let protectedValue=12;
 function Protected(){const [locked,setLocked]=useState(false);setLock=setLocked;return <DocumentEditLock.Provider value={locked}><DraftNumberInput aria-label="protected draft" type="number" value={protectedValue} onChange={e=>protectedValue=Number(e.target.value)}/></DocumentEditLock.Provider>}
 const protectedRoot=createRoot(document.getElementById('root')!);await act(async()=>protectedRoot.render(<Protected/>));const protectedInput=document.querySelector('input')!;
 await act(async()=>{protectedInput.focus();Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(protectedInput,'99');protectedInput.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>setLock(true));await act(async()=>setLock(false));await act(async()=>protectedInput.blur());assert.equal(protectedValue,12,'A draft present before job lock must be discarded, never committed after unlock');await act(async()=>protectedRoot.unmount());
}
async function fitTravelChecks(){
 const events:any[]=[];const requests:{name:string;args:any}[]=[];
 (globalThis as any).__openMock=async()=>'/offline/tall-page.pdf';
 (globalThis as any).__invokeMock=async(name:string,args:any)=>{
  requests.push({name,args:copy(args??{})});if(name==='optimize_document')return {document:copy(args.document),stroke_order:args.document.strokes.map((_:unknown,i:number)=>i),before_distance_mm:100,after_distance_mm:20,before_travel_seconds:4,after_travel_seconds:.8};
  if(name==='poll_device')return events.splice(0);
  if(name==='import_document')return {name:'Tall PDF',width_mm:210,height_mm:297,strokes:[[{x:10,y:10},{x:80,y:277}]]};
  if(name==='pdf_page_count')return 1;
  if(name==='default_import_options')return {};
  if(['list_fonts','list_legacy_fonts','list_glyph_fonts','list_templates','list_registration_profiles'].includes(name))return [];
  return null;
 };
 const root=createRoot(document.getElementById('root')!);await act(async()=>root.render(<App/>));await click('导入素材…');
 events.push({type:'connected',port:'MOCK'},{type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}},{type:'origin_mode',automatic:false},{type:'calibration_changed',origin:[0,0]});await poll();
 assert.equal(findButton('开始书写').disabled,true,'Tall imported PDF must initially exceed the travel envelope');
 await click('适配画布');assert.equal(findButton('开始书写').disabled,false,'Fit must produce a runnable placement within fixed-origin travel');
 await click('导出 SVG');const fitted=requests.filter(r=>r.name==='export_document').at(-1)!.args.document;
 const points=fitted.strokes.flat();const ys=points.map((p:any)=>p.y);
 assert.ok(Math.min(...ys)>=0);assert.ok(Math.max(...ys)<=240,'Fit must use the whole current page within the A4 axis range');
 await click('全选路径 Ctrl+A');await number('选区Y',190);
 assert.equal(findButton('开始书写').disabled,true,'Moving fitted geometry out of reachable area must be blocked before IPC');
 await click('开始书写');assert.equal(requests.filter(r=>r.name==='device_command'&&r.args.command.type==='run').length,0);
 await click('适配画布');assert.equal(findButton('开始书写').disabled,false);
 events.push({type:'status',status:{state:'Idle',position:[0,190,0],wco:[0,0,0]}});await poll();
 assert.equal(findButton('开始书写').disabled,true,'Current-tip travel must also limit reachable placement');
 await act(async()=>root.unmount());console.log('PASS: tall PDF fit uses the whole canvas and fixed-origin endpoint limits; edited placement/current-tip travel blocked before dispatch.');
}
async function submissionLockChecks(){
 const events:any[]=[];const requests:{name:string;args:any}[]=[];let resolveRun:()=>void=()=>{};
 (globalThis as any).__openMock=async()=>'/offline/pending.svg';
 (globalThis as any).__invokeMock=async(name:string,args:any)=>{
  requests.push({name,args:copy(args??{})});if(name==='optimize_document')return {document:copy(args.document),stroke_order:args.document.strokes.map((_:unknown,i:number)=>i),before_distance_mm:100,after_distance_mm:20,before_travel_seconds:4,after_travel_seconds:.8};if(name==='poll_device')return events.splice(0);
  if(name==='import_document')return copy(fixture);if(name==='default_import_options')return {};
  if(['list_fonts','list_legacy_fonts','list_glyph_fonts','list_templates','list_registration_profiles'].includes(name))return [];
  if(name==='device_command'&&args.command.type==='run')await new Promise<void>(resolve=>{resolveRun=resolve});
  return null;
 };
 const root=createRoot(document.getElementById('root')!);await act(async()=>root.render(<App/>));await click('导入素材…');
 events.push({type:'ports',ports:[{name:'MOCK',preferred:true}]},{type:'connected',port:'MOCK'},{type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}},{type:'origin_mode',automatic:false},{type:'calibration_changed',origin:[0,0]});await poll();
 const locked=()=>assert.equal(document.querySelector('.canvas-edit-layer.active'),null);
 const editable=()=>assert.ok(document.querySelector('.canvas-edit-layer.active'));
 await click('开始书写');locked();assert.equal(findButton('导入素材…').disabled,true,'Source imports lock before run IPC resolves or job_started arrives');
 assert.equal((document.querySelector('.left-panel fieldset') as HTMLFieldSetElement|null)?.disabled??true,true);
 events.push({type:'job_started'},{type:'paused',paused:true});await poll();locked();
 await click('停止');locked();events.push({type:'stopped'});await poll();editable();
 await act(async()=>resolveRun());editable();assert.equal(findButton('开始书写').disabled,false,'Late submission acknowledgement must not relock a cancelled task');
 await click('开始书写');events.push({type:'job_started'},{type:'paused',paused:true},{type:'error',message:'mock uncertain device fault'},{type:'disconnected'});await poll();locked();
 assert.equal(findButton('清除旧任务并恢复连接').disabled,false,'Disconnected uncertain job must retain an explicit recovery route');
 await click('清除旧任务并恢复连接');events.push({type:'recovering',active:true},{type:'error',message:'mock failed recovery'},{type:'disconnected'},{type:'recovering',active:false});await poll();locked();
 assert.equal(findButton('清除旧任务并恢复连接').disabled,false,'Failed recovery preserves edit lock and permits retry');
 await click('清除旧任务并恢复连接');events.push({type:'recovering',active:true},{type:'stopped'},{type:'connected',port:'MOCK'},{type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}},{type:'recovering',active:false},{type:'origin_mode',automatic:false},{type:'calibration_changed',origin:[0,0]});await poll();editable();
 await act(async()=>resolveRun());await click('开始书写');events.push({type:'job_started'},{type:'completed'});await poll();editable();await act(async()=>resolveRun());editable();
 await act(async()=>root.unmount());console.log('PASS: immediate submission lock, pause/stop/complete lifecycle, late IPC acknowledgement and failed/successful recovery lock behavior.');
}
async function pendingRouteStopChecks(){
 const events:any[]=[];const requests:{name:string;args:any}[]=[];
 let finishPlan:()=>void=()=>{};
 (globalThis as any).__openMock=async()=>'/offline/pending-plan.svg';
 (globalThis as any).__invokeMock=async(name:string,args:any)=>{
  requests.push({name,args:copy(args??{})});
  if(name==='poll_device')return events.splice(0);
  if(name==='import_document')return copy(fixture);
  if(name==='optimize_document')return new Promise(resolve=>{finishPlan=()=>resolve({document:copy(args.document),stroke_order:[0,1],before_distance_mm:100,after_distance_mm:20,before_travel_seconds:4,after_travel_seconds:.8});});
  if(name==='default_import_options')return {};
  if(['list_fonts','list_legacy_fonts','list_glyph_fonts','list_templates','list_registration_profiles'].includes(name))return [];
  return null;
 };
 const root=createRoot(document.getElementById('root')!);await act(async()=>root.render(<App/>));await click('导入素材…');
 events.push({type:'connected',port:'MOCK'},{type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}});await poll();
 // Fire without awaiting completion: planning is pending and the task must lock immediately.
 await click('开始书写');assert.equal(document.querySelector('.canvas-edit-layer.active'),null);
 await click('停止');
 await act(async()=>finishPlan());
 assert.equal(requests.filter(r=>r.name==='device_command'&&r.args.command.type==='run').length,0,'Stop must cancel pending start even before stopped acknowledgement');
 assert.equal(document.querySelector('.canvas-edit-layer.active'),null,'Stop acknowledgement still owns unlock');
 events.push({type:'stopped'});await poll();assert.ok(document.querySelector('.canvas-edit-layer.active'));
 await act(async()=>root.unmount());console.log('PASS: Start locks while planning; Stop cancels late route before native stopped acknowledgement, with no queued Run.');
}
async function routeComparisonChecks(){
 const events:any[]=[];const requests:{name:string;args:any}[]=[];
 let mergedSavings=4.99;
 const connectedFixture={...copy(fixture),strokes:[[{x:10,y:10},{x:20,y:20}],[{x:20,y:20},{x:30,y:30}]]};
 (globalThis as any).__openMock=async()=>'/offline/comparison.svg';
 (globalThis as any).__invokeMock=async(name:string,args:any)=>{
  requests.push({name,args:copy(args??{})});
  if(name==='poll_device')return events.splice(0);
  if(name==='import_document')return copy(connectedFixture);
  if(name==='optimize_document')return {document:{...copy(args.document),strokes:[...args.document.strokes].reverse()},stroke_order:args.document.strokes.map((_:unknown,i:number)=>args.document.strokes.length-1-i),before_distance_mm:20,after_distance_mm:10,before_travel_seconds:1,after_travel_seconds:.5};
  if(name==='generate_gcode')return '; comparison mock';
  if(name==='compare_routes')return {recommended:'merged',variants:['original','current','merged','aggressive'].map(id=>({id,label:id==='original'?'原始拟合':id==='current'?'当前规划':id==='merged'?'精确端点合并':'激进连写',document:{...args.job.document,strokes:id==='merged'||id==='aggressive'?[[...args.job.document.strokes[0],...args.job.document.strokes[1].slice(1)]]:args.job.document.strokes},stroke_owners:id==='merged'||id==='aggressive'?[args.stroke_owners[0]]:args.stroke_owners,strokes:id==='merged'||id==='aggressive'?1:2,draw_mm:28.28,travel_mm:0,z_mm:id==='merged'?14:28,estimated_seconds:id==='merged'?4:7,compute_ms:.2,geometry_preserved:id!=='aggressive',coverage_preserved:true,savings_percent:id==='merged'?mergedSavings:id==='aggressive'?(args.max_gap_mm>0?12:4):0,eligible:id==='merged'||id==='aggressive',added_bridges:id==='aggressive'&&args.max_gap_mm>0?[[{x:20,y:20},{x:20.2,y:20.2}]]:[],removed_overlap_mm:id==='aggressive'&&args.deduplicate?2:0}))};
  if(name==='default_import_options')return {};
  if(['list_fonts','list_legacy_fonts','list_glyph_fonts','list_templates','list_registration_profiles'].includes(name))return [];
  return null;
 };
 const root=createRoot(document.getElementById('root')!);await act(async()=>root.render(<App/>));await click('导入素材…');
 events.push({type:'connected',port:'MOCK'},{type:'origin_mode',automatic:false},{type:'calibration_changed',origin:[0,0]},{type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}});await poll();
 const shapes=()=>[...document.querySelectorAll('.canvas-edit-layer polyline')].map(p=>p.getAttribute('points'));
 const before=shapes();
 await click('预览 CNC / G-code');const optimized=requests.filter(r=>r.name==='generate_gcode').at(-1)!.args.job.document.strokes;await click('关闭');
 assert.equal(optimized[0][0].x,20,'ON plans reversed fixture order');await click('开始书写');assert.deepEqual(requests.filter(r=>r.name==='device_command'&&r.args.command.type==='run').at(-1)!.args.command.job.document.strokes,optimized,'ON Run uses the same optimized snapshot');
 events.push({type:'stopped'},{type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}});await poll();await click('优化轨迹');assert.equal(findButton('优化轨迹').getAttribute('aria-pressed'),'false');
 await click('优化书写对照');
 const compared=requests.filter(r=>r.name==='compare_routes').at(-1)!.args;
 assert.equal(compared.official_baseline,false,'SVG/PDF references cannot claim official gfont order');assert.equal(compared.job.z_down,4);assert.equal(compared.job.feed,1500);assert.equal(compared.job.travel_feed,2500);assert.equal(compared.trajectory_enabled,false);assert.equal(compared.max_gap_mm,0);assert.equal(compared.deduplicate,false);
 assert.ok(document.querySelector('svg[aria-label="优化方案墨迹对照"]'));assert.equal(document.querySelector('svg[aria-label="优化方案墨迹对照"] line'),null,'Comparison renders ink only, never full-route travel');
 assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('完整用时'));assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('不含加减速和通信等待'));
 assert.equal(findButton('应用合并方案').disabled,false,'4.99% savings is a user choice');assert.equal(findButton('应用连写方案').disabled,false);assert.equal([...document.querySelectorAll('button')].some(b=>b.textContent==='应用当前规划'),false,'Trajectory is independently controlled, never applied from comparison');
 const gapToggle=document.querySelector('input[aria-label="允许跨小间隙连笔"]') as HTMLInputElement;const dedupToggle=document.querySelector('input[aria-label="删除重叠笔路"]') as HTMLInputElement;
 assert.equal(gapToggle.checked,false);assert.equal(dedupToggle.checked,false);assert.equal((document.querySelector('input[aria-label="最大连接距离"]') as HTMLInputElement).value,'0.3');
 events.push({type:'status',status:{state:'Idle',position:[1,0,0],wco:[0,0,0]}});await poll();
 assert.equal(findButton('应用合并方案').disabled,true,'Moving fixed-start pen invalidates comparison application');assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('旧对照不可应用'));
 mergedSavings=-1;await click('重新计算对照');assert.equal(findButton('应用合并方案').disabled,false,'Slower candidates remain manually selectable');
 await act(async()=>{gapToggle.click();dedupToggle.click();});assert.equal(findButton('应用合并方案').disabled,true,'Changed writing options invalidate comparison');await number('最大连接距离',2);assert.equal((document.querySelector('input[aria-label="最大连接距离"]') as HTMLInputElement).value,'1');await number('最大连接距离',.4);
 await click('重新计算对照');const aggressiveRequest=requests.filter(r=>r.name==='compare_routes').at(-1)!.args;assert.equal(aggressiveRequest.max_gap_mm,.4);assert.equal(aggressiveRequest.deduplicate,true);assert.equal(aggressiveRequest.trajectory_enabled,false);
 await click('激进连写');assert.ok(document.querySelector('g[aria-label="新增连笔"] polyline'),'Extra ink bridges are separately highlighted');assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('保留原墨迹，有新增连线'));assert.equal(findButton('应用连写方案').disabled,false,'Coverage-preserved candidate with added ink can be eligible despite geometry changes');await click('应用连写方案');assert.equal(shapes().length,1);assert.equal(findButton('优化轨迹').getAttribute('aria-pressed'),'false');await click('撤销 Ctrl+Z');assert.deepEqual(shapes(),before);
 await click('优化书写对照');await click('应用合并方案');assert.equal(shapes().length,1);assert.equal(document.querySelectorAll('.material-item').length,1);assert.equal(findButton('优化轨迹').getAttribute('aria-pressed'),'false','Applying merged writing must not enable trajectory optimization');
 await click('撤销 Ctrl+Z');assert.deepEqual(shapes(),before,'Applying merged comparison must be undoable');assert.equal(document.querySelectorAll('.material-item').length,1);
 await click('重做 Ctrl+Shift+Z');assert.equal(shapes().length,1);await click('删除素材 Offline generated trajectory fixture');assert.equal(shapes().length,0,'Merged strokes retain original material ownership');
 await act(async()=>root.unmount());console.log('PASS: route comparison ink-only overlays, full-time stats, exact job options, stale rejection, apply/undo/redo and material ownership.');
}
async function materialCompositionChecks(){
 const requests:{name:string,args:any}[]=[]; let opened=0;
 (globalThis as any).__openMock=async()=>`/offline/material-${++opened}.${opened===2?'pdf':'svg'}`;
 (globalThis as any).__invokeMock=async(name:string,args:any)=>{
  requests.push({name,args:copy(args??{})});
  if(name==='poll_device')return [];
  if(name==='import_document')return {...copy(fixture),name:`Material ${opened}`};
  if(name==='pdf_page_count')return 1;
  if(name==='save_glyph')return {path:'/offline/glyph.json',name:'Test',characters:['永']};
  if(name==='default_import_options')return {};
  if(['list_fonts','list_legacy_fonts','list_glyph_fonts','list_templates','list_registration_profiles'].includes(name))return [];
  if(name==='optimize_document')return {document:{...args.document,strokes:[...args.document.strokes].reverse()},stroke_order:args.document.strokes.map((_:unknown,i:number)=>args.document.strokes.length-1-i),before_distance_mm:100,after_distance_mm:20,before_travel_seconds:4,after_travel_seconds:0.8};
  return null;
 };
 const root=createRoot(document.getElementById('root')!);await act(async()=>root.render(<App/>));
 const paths=()=>[...document.querySelectorAll('.canvas-edit-layer polyline')].map(p=>p.getAttribute('points'));
 await click('导入素材…');await dragBox(2,2,22,22);await number('选区X',25);const first=paths();
 await click('导入素材…');assert.equal(paths().length,4);assert.deepEqual(paths().slice(0,2),first,'Appending must preserve prior edited material');
 assert.notDeepEqual(paths().slice(2),first,'New material should be placed beside prior content when space permits');
 assert.equal((document.querySelector('input[aria-label="选区X"]') as HTMLInputElement).value,'65','Inserted material must be selected for immediate movement');
 await click('撤销 Ctrl+Z');assert.deepEqual(paths(),first,'Undo insert preserves prior edits');await click('重做 Ctrl+Shift+Z');assert.equal(paths().length,4);
 await click('重新计算走线');await act(async()=>{await new Promise(r=>setTimeout(r,220));});assert.equal(requests.filter(r=>r.name==='optimize_document').at(-1)!.args.start,null);
 assert.ok(document.body.textContent?.includes('100.0 → 20.0'));
 await click('删除素材 Material 1');assert.equal(paths().length,2,'Deleting material after optimization must follow ownership permutation');assert.equal(document.querySelectorAll('.material-item').length,1);
 await click('撤销 Ctrl+Z');assert.equal(paths().length,4);assert.equal(document.querySelectorAll('.material-item').length,2,'Undo restores material identity');
 assert.ok(!document.querySelector('.material-list')?.textContent?.includes('100.0 → 20.0'),'Any edit/undo must invalidate optimization stats');
 const extraction=document.querySelector('details.glyph-extraction') as HTMLDetailsElement;
 await act(async()=>{extraction.open=true;extraction.dispatchEvent(new Event('toggle'));});
 assert.equal(paths().length,2,'Extraction view must contain only the most recent PDF, not all composed materials');
 const character=[...document.querySelectorAll('label.field')].find(l=>l.textContent?.includes('绑定字符'))!.querySelector('input')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(character,'永');character.dispatchEvent(new Event('input',{bubbles:true}));});
 await click('保存这个字形');const saved=requests.filter(r=>r.name==='save_glyph').at(-1)!.args;
 assert.deepEqual(saved.document.strokes,fixture.strokes,'Glyph save must use raw imported PDF coordinates without unrelated materials');
 await act(async()=>{extraction.open=false;extraction.dispatchEvent(new Event('toggle'));});assert.equal(paths().length,4,'Closing extraction restores composition');
 await act(async()=>root.unmount());console.log('PASS: multiple materials append without losing edits; insert/delete/optimization ownership and undo; mocked IPC only.');
}
export async function run(){
 await editorMenuChecks();
 await projectLifecycleChecks();
 await projectChecks();
 await clipboardChecks();
 await registrationHandleChecks();
 await registrationChecks();
 calibrationChecks();
 await writtenChecks();
 await panChecks();
 await paperChecks();
 await backgroundChecks();
 await transformHandleChecks();
 await routeHookChecks();
 await numericDraftChecks();
 independentCoordinateChecks();
 const root=createRoot(document.getElementById('root')!);await act(async()=>root.render(<Harness/>));
 assert.ok(document.querySelector('.canvas-edit-layer.active'),'A drawing must be immediately box-selectable');await dragBox(2,2,22,22);
 const untouched=copy(latest.strokes[1]);await number('选区X',25);
 assert.equal(latest.strokes[0][0].x,25,'Selected path translation must persist');assert.deepEqual(latest.strokes[1],untouched,'Unselected path must not drift');
 await number('选区宽',20);assert.equal(latest.strokes[0][1].x-latest.strokes[0][0].x,20);
 const beforeRotate=copy(latest);await number('选区旋转角度',90);await click('应用');assert.notDeepEqual(latest.strokes[0],beforeRotate.strokes[0]);assert.deepEqual(latest.strokes[1],untouched);
 await click('复制 Ctrl+C');await click('粘贴 Ctrl+V');assert.equal(latest.strokes.length,3);await click('撤销 Ctrl+Z');assert.equal(latest.strokes.length,2);
 await click('剪切 Ctrl+X');assert.equal(latest.strokes.length,1);await click('撤销 Ctrl+Z');assert.equal(latest.strokes.length,2);
 await click('全选路径 Ctrl+A');const prior=copy(latest);const min=Math.min(...prior.strokes.flat().map((p:any)=>p.x));await number('选区X',min+7);
 latest.strokes.forEach((s,i)=>s.forEach((p,k)=>assert.ok(Math.abs(p.x-prior.strokes[i][k].x-7)<1e-8,'Whole-selection translation must persist')));
 await act(async()=>root.unmount());console.log('PASS: real CanvasEditing React hook — selection move/no drift, resize, rotate, copy/paste, cut, undo, whole-selection translation. Offline jsdom only; no GUI or hardware acceptance.');
 await appIntegration();
 await sourceParity('pdf');await sourceParity('gfont');
 await materialCompositionChecks();
 await recoveryAndCoordinates();
 await fitTravelChecks();
 await submissionLockChecks();
 await pendingRouteStopChecks();
 await routeComparisonChecks();
}
