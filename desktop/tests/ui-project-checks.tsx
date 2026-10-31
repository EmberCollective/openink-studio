import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import App from '../ui/src/App';
import type {Project} from '../ui/src/projectModel';
import type {TextSettings} from '../ui/src/paperModel';

export async function projectChecks(){
 const requests:{name:string,args:any}[]=[]; const events:any[]=[];
 let saved:Project|null=null, fail=false, accepted=true;
 (globalThis as any).__saveMock=async()=>'/offline/project.inkproj';
 (globalThis as any).__openMock=async()=>'/offline/project.inkproj';
 (globalThis as any).__askMock=async()=>accepted;
 const ink={name:'page one',width_mm:210,height_mm:297,strokes:[[{x:22,y:33},{x:44,y:55}]],strokeIds:['restored-1'],strokeOwners:['material-1'],materials:[{id:'material-1',name:'Inserted SVG',kind:'file'}]};
 const blank={name:'page two',width_mm:210,height_mm:297,strokes:[],materials:[],strokeIds:[],strokeOwners:[]};
 const value:Project={
  pages:[{document:ink,background:{path:'/cache/background.pdf',page:1,page_count:2,data_url:'data:image/png;base64,cGFnZQ==',width_mm:210,height_mm:297}},{document:blank,background:{path:'/cache/background.pdf',page:2,page_count:2,data_url:'',width_mm:210,height_mm:297}}],current_page:0,
  template:{id:'project-a4',name:'Custom A4',description:'test',width_mm:210,height_mm:297,margin_mm:12,font_size_mm:20,letter_spacing_mm:1,lines:8},
  writing:{feed:1234,travel_feed:2345,z_feed:456,z_down:5,jog_step:.5},
  routing:{optimize:false,allow_reverse:false,allow_gap:true,max_gap:.2,deduplicate:false},
  calibration:{origin:[210,0],registration:{scale:1,rotation_deg:0,matrix:[0.8,0,0,1.2]},points:[[210,0],[15,282]],point3:[15,0],show_points:false,selected_profile:'',profiles:[]},
  conversion:{dpi:300,threshold:180,conservative:false,tolerance_mm:.1,filter_iterations:4,error_threshold:2,line_threshold:1,despeckle_level:0},background_visible:true,show_margins:false
 };
 (globalThis as any).__invokeMock=async(name:string,args:any)=>{
  requests.push({name,args:structuredClone(args??{})});
  if(name==='poll_device')return events.splice(0);
  if(name==='open_project'){if(fail)throw new Error('corrupt archive');return structuredClone(value);}
  if(name==='save_project'){
   for(const page of args.project.pages)if(page.background)assert.deepEqual(Object.keys(page.background).sort(),['data_url','page','page_count','path'],'Save IPC must omit duplicated background target sizes');
   saved=structuredClone(args.project);return;
  }
  if(name==='default_import_options')return {};
  if(name==='pdf_background_page')return {data_url:'data:image/png;base64,cGFnZTI=',page_count:2,width_mm:210,height_mm:297};
  if(['list_fonts','list_legacy_fonts','list_glyph_fonts','list_templates','list_registration_profiles'].includes(name))return [];
  if(name==='optimize_document')return {document:args.document,stroke_order:args.document.strokes.map((_:any,i:number)=>i),before_distance_mm:0,after_distance_mm:0,before_travel_seconds:0,after_travel_seconds:0};
  return null;
 };
 const button=(text:string)=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text||b.title===text);assert.ok(b,`Missing ${text}`);return b;};
 const click=async(text:string)=>{await act(async()=>button(text).click());if(text==='打开工程' && document.querySelector('.project-confirmation'))await act(async()=>button(accepted?'不保存':'取消').click());};
 const paths=()=>[...document.querySelectorAll('.canvas-edit-layer polyline')].map(p=>p.getAttribute('points'));
 const poll=async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,230));});};
 const root=createRoot(document.getElementById('root')!);
 try{
  await act(async()=>root.render(<App/>));
  assert.equal(button('保存工程').disabled,false,'Empty workspace/settings can be saved');
  await click('保存工程');assert.equal(saved!.pages[0].document.strokes.length,0);
  await click('打开工程');await poll();
  assert.deepEqual(paths(),['22,33 44,55']);
  await click('设备控制');
  assert.ok(document.body.textContent?.includes('工作原点（工程保存，待两点校准）：画布 X 210.00 / Y 0.00'));
  assert.equal(document.body.textContent?.includes('工程已打开，请重新进行纸面校准'),false);
  assert.equal((document.querySelector('select[aria-label="校准方式"]') as HTMLSelectElement).value,'two');
  for(const [label,v] of [['描线速率',1234],['移动速度',2345],['Z速率',456],['落笔下探',5]])assert.equal((document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement).value,String(v));
  assert.equal(button('显示校准点').getAttribute('aria-pressed'),'false');
  await click('保存工程');
  assert.deepEqual(saved!.writing,value.writing);assert.deepEqual(saved!.routing,value.routing);assert.deepEqual(saved!.conversion,value.conversion);
  assert.deepEqual(saved!.calibration.points,value.calibration.points);assert.deepEqual(saved!.calibration.point3,value.calibration.point3);assert.equal(saved!.calibration.show_points,false);
  assert.deepEqual(saved!.calibration.origin,value.calibration.origin);assert.deepEqual(saved!.calibration.registration,value.calibration.registration);
  assert.deepEqual(saved!.pages[0].document.strokes,value.pages[0].document.strokes);assert.deepEqual(saved!.pages[0].document.strokeIds,['restored-1']);
  assert.equal(saved!.pages.length,2);
  assert.equal("width_mm" in saved!.pages[0].background!,false);assert.equal("height_mm" in saved!.pages[0].background!,false);
  assert.equal(requests.some(r=>r.name==='device_command'&&r.args.command.type==='forget_calibration'),true,'Opening clears the previous device session while preserving page scales');
  assert.equal(button('重置到画布左上角').disabled,true,'A saved scale cannot bypass the required new alignment');
  events.push({type:'connected',port:'MOCK'},{type:'status',status:{state:'Idle',position:[0,0,0],wco:[0,0,0]}});await poll();
  assert.ok(document.body.textContent?.includes('请用两点校准当前旋转；横纵比例沿用保存值'));
  assert.equal(requests.some(r=>r.name==='device_command'&&r.args.command.type==='apply_registration'),false,'Opening must not apply the saved rotation');
  assert.equal(button('开始书写').disabled,true,'Saved project needs two-point rotation calibration');
  await click('已对齐第一点，确认并移向第二点');
  assert.deepEqual(requests.filter(r=>r.name==='device_command').at(-1)!.args.command,{type:'begin_registration',canvas_x:210,canvas_y:0,preserve_scale:[0.8,1.2]});
  events.push({type:'error',message:'mock rotation-only calibration pause'},{type:'positioning',active:false});await poll();
  await click('下一页画板');assert.deepEqual(paths(),[]);assert.equal(requests.filter(r=>r.name==='pdf_background_page').at(-1)!.args.page,2);
  saved=null;await click('保存工程');assert.ok(saved,'Lazy-rendered background page must save');
  await click('上一页画板');assert.deepEqual(paths(),['22,33 44,55']);
  await click('显示校准点');accepted=false;const count=requests.filter(r=>r.name==='open_project').length;await click('打开工程');assert.equal(requests.filter(r=>r.name==='open_project').length,count);assert.deepEqual(paths(),['22,33 44,55']);
  accepted=true;fail=true;await click('打开工程');assert.deepEqual(paths(),['22,33 44,55'],'Failure preserves the current workspace');
  fail=false;
  const privateText:TextSettings={text:'retained private text',font_mode:'legacy',font_path:'',glyph_path:'',legacy_selection:[{path:'/offline/private.gfont',weight:1}],legacy_percent:100,legacy_baseline:1,legacy_seed:7,centerline:false,placement:'free',start_line:0,offset:.5,font_size_mm:20,letter_spacing_mm:1};
  value.pages[0].document={...value.pages[0].document,text_settings:privateText};
  await click('打开工程');
  assert.deepEqual(paths(),['22,33 44,55'],'Public build must preserve private-project ink');
  assert.equal((document.querySelector('option[value="legacy"]') as HTMLOptionElement).disabled,true);
  assert.equal(document.querySelector('.legacy-picker'),null,'Unsupported settings must not expose the private importer');
  await click('插入文字到画布');
  assert.ok(document.body.textContent?.includes('此版本不支持原版 gfont'));
  assert.deepEqual(paths(),['22,33 44,55'],'Rejected regeneration must preserve existing paths');
  assert.ok(!requests.some(r=>r.name==='legacy_font_document'||r.name==='list_legacy_fonts'));
  await click('保存工程');assert.deepEqual(saved!.pages[0].document.text_settings,privateText,'Saving publicly must retain private text settings');
  // Opening a background-only current page renders the packaged PDF before replacing state.
  value.current_page=1;await click('打开工程');assert.deepEqual(paths(),[]);assert.ok(document.querySelector('image[aria-label="PDF 背景（不可选中）"]'));
  saved=null;await click('保存工程');assert.ok(saved,'Reopened project with regenerated preview must save');assert.equal(saved!.current_page,1);assert.deepEqual(saved!.pages[0].document.strokeIds,['restored-1']);
  console.log('PASS: complete project save/open, saved origin restore, pages/layouts, hidden points, lazy PDFs and failure preservation (mock IPC).');
 }finally{await act(async()=>root.unmount());delete (globalThis as any).__saveMock;delete (globalThis as any).__askMock;}
}
