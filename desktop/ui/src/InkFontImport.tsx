import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { Undo2, Redo2 } from "lucide-react";
import { DraftNumberInput } from "./DraftNumberInput";
import Toggle from "./Toggle";
import { screenToCanvas } from "./pointerGeometry";
import { InkGlyphEditor, InkGlyphView } from "./InkGlyphEditor";
import { inkCanvas, variantError, type InkPackage, type InkVariant } from "./inkfont";
import { clampCrop, emptyImportHistory, glyphPageTransform, neighborhood, recordImport, sourceKey, travelImport, type Bounds, type Candidate, type ImportHistory, type InkImportOptions, type Page, type Result, type Snapshot, type Source } from "./inkfontImportModel";
import "./inkfontImport.css";
export type { InkImportOptions } from "./inkfontImportModel";

export function InkFontImport({pack,onSaved,onCancel,options:initial}: {pack:InkPackage;onSaved:(p:InkPackage)=>void;onCancel:()=>void;options:InkImportOptions}) {
  const [options,setOptions]=useState({...initial,page:1});
  const [path,setPath]=useState(""),[models,setModels]=useState("");
  const [history,setHistory]=useState<ImportHistory>(emptyImportHistory);
  const [selected,setSelected]=useState(""),[step,setStep]=useState(0);
  const [busy,setBusy]=useState(""),[error,setError]=useState("");
  const [page,setPage]=useState<Page|null>(null),[previewBusy,setPreviewBusy]=useState(false);
  const [thumbs,setThumbs]=useState<Record<number,string>>({}),[thumbStart,setThumbStart]=useState(0);
  const [previewMode,setPreviewMode]=useState<"boxes"|"curves"|"overlay">("boxes");
  const [editorRevision,setEditorRevision]=useState(0);
  const [pageSelections,setPageSelections]=useState<Record<string,number[]>>({});
  const [progress,setProgress]=useState<{total:number;done:number;failed:number;current:number|null;reused:number}|null>(null);
  const stopBatch=useRef(false);
  const progressToken=useRef(0);
  const refitToken=useRef(0);
  const [singleProgress,setSingleProgress]=useState<{stage:string;done:number;total:number}|null>(null);
  const [elapsed,setElapsed]=useState(0);
  const svg=useRef<SVGSVGElement>(null),loading=useRef(false);
  const histories=useRef(new Map<string,ImportHistory>()),pages=useRef(new Map<string,Page>()),thumbnails=useRef(new Map<string,string>());
  const pageHistories=useRef(new Map<string,ImportHistory>());
  const drag=useRef<{pointer:number;x:number;y:number;bounds:Bounds;next:Bounds;candidate:string;corner:boolean;before:Snapshot}|null>(null);
  const source:Source={path,options,models},key=sourceKey(source);
  const snapshot=history.present,result=snapshot?.result,matches=!!snapshot&&sourceKey(snapshot.source)===key;
  const current=result?.candidates.find(c=>c.id===selected);
  const candidates=[...(result?.candidates||[])].sort((a,b)=>Number(!b.confirmed&&b.needs_review)-Number(!a.confirmed&&a.needs_review));
  const confirmed=candidates.filter(c=>c.confirmed&&!c.excluded),locked=!!busy;
  const drafts=new Map([...pageHistories.current].map(([id,h])=>[id,h.present!] as const));
  if(snapshot)drafts.set(JSON.stringify([snapshot.source.path,snapshot.source.options.page]),snapshot);
  const selectedPages=pageSelections[path]||[];
  const includedDrafts=[...drafts.values()].filter(d=>pageSelections[d.source.path]?.includes(d.source.options.page));
  const pending=includedDrafts.flatMap(d=>d.result.candidates.filter(c=>c.confirmed&&!c.excluded));
  const cachedPage=(number:number)=>{const pageSource={path,models,options:{...options,page:number}};return sourceKey(snapshot?.source||source)===sourceKey(pageSource)?history:histories.current.get(sourceKey(pageSource));};
  const batchReady=selectedPages.length>0&&selectedPages.every(number=>!!cachedPage(number)?.present);
  const readyPages=selectedPages.filter(number=>!!cachedPage(number)?.present);
  const context=current&&result?neighborhood(drag.current?.bounds||current.bounds,result.width,result.height):null;
  const pageKey=JSON.stringify([path,options.page,options.dpi,options.python_path]);

  useEffect(()=>()=>{refitToken.current++;},[]);
  useEffect(()=>{if(snapshot){const id=JSON.stringify([snapshot.source.path,snapshot.source.options.page]);histories.current.set(sourceKey(snapshot.source),history);pageHistories.current.set(id,history);}},[history]);
  useEffect(()=>{
    const cached=histories.current.get(key);
    if(cached&&sourceKey(cached.present!.source)!==sourceKey(history.present?.source||source)){
      setHistory(cached);setSelected(cached.present!.result.candidates[0]?.id||"");setEditorRevision(n=>n+1);
    }
  },[key]);
  useEffect(()=>{
    if(!path||step>1)return;
    let canceled=false;
    const initializeSelection=(count:number)=>setPageSelections(old=>old[path]!==undefined?old:{...old,[path]:Array.from({length:count},(_,i)=>i+1)});
    const cached=pages.current.get(pageKey);
    if(cached){setPage(cached);initializeSelection(cached.page_count);setPreviewBusy(false);return;}
    setPreviewBusy(true);setPage(null);setError("");
    void invoke<Page>("inkfont_preview_page",{path,options}).then(next=>{pages.current.set(pageKey,next);if(!canceled){setPage(next);initializeSelection(next.page_count);}})
      .catch(e=>{if(!canceled)setError(String(e));}).finally(()=>{if(!canceled)setPreviewBusy(false);});
    return()=>{canceled=true;};
  },[pageKey,step>1]);
  useEffect(()=>{setThumbs({});setThumbStart(0);},[path,options.python_path]);
  useEffect(()=>{if(!locked||progress?.current==null)return;const started=Date.now();setElapsed(0);const timer=window.setInterval(()=>setElapsed(Math.floor((Date.now()-started)/1000)),1000);return()=>window.clearInterval(timer);},[locked,progress?.current]);
  useEffect(()=>{
    if(!path||!page||step!==0)return;
    let canceled=false;
    void(async()=>{
      for(let number=thumbStart+1;number<=Math.min(page.page_count,thumbStart+12);number++){
        const thumbKey=JSON.stringify([path,number,options.python_path]);
        let image=thumbnails.current.get(thumbKey);
        if(!image){try{const p=await invoke<Page>("inkfont_preview_page",{path,options:{...options,page:number,dpi:72}});image=p.image_data_url;thumbnails.current.set(thumbKey,image);}catch{/* The full-page preview reports errors when this page is selected. */}}
        if(canceled)return;
        if(image)setThumbs(old=>({...old,[number]:image!}));
      }
    })();return()=>{canceled=true;};
  },[path,page?.page_count,thumbStart,options.python_path,step===0]);

  function commit(next:Snapshot){setHistory(h=>recordImport(h,next));}
  function update(id:string,patch:Partial<Candidate>,record=true){setHistory(h=>{
    if(!h.present)return h;
    const next={...h.present,result:{...h.present.result,candidates:h.present.result.candidates.map(c=>c.id===id?{...c,...patch}:c)}};
    return record?recordImport(h,next):{...h,present:next};
  });}
  function restoreSource(s:Source){setPath(s.path);setOptions({...s.options});setModels(s.models);setThumbStart(Math.floor((s.options.page-1)/12)*12);}
  function travel(redo=false){
    if(locked||drag.current)return;
    const next=travelImport(history,redo);if(next===history)return;
    setHistory(next);setError("");restoreSource(next.present!.source);
    if(!next.present!.result.candidates.some(c=>c.id===selected))setSelected(next.present!.result.candidates[0]?.id||"");
    setEditorRevision(n=>n+1);
  }
  async function run(label:string,fn:()=>Promise<void>){if(loading.current)return;loading.current=true;setBusy(label);setError("");try{await fn();}catch(e){setError(String(e));}finally{loading.current=false;setBusy("");}}
  async function leave(){if(!result||await ask("退出将丢弃本次尚未入库的校准结果。",{title:"退出导入",kind:"warning"}))onCancel();}
  function navigate(next:number){if(!locked&&(next<2||matches&&selectedPages.includes(options.page)))setStep(next);}
  function flip(number:number){setOptions(o=>({...o,page:number}));setThumbStart(Math.floor((number-1)/12)*12);}
  function togglePage(number:number){setPageSelections(old=>({...old,[path]:(old[path]||[]).includes(number)?old[path].filter(n=>n!==number):[...(old[path]||[]),number].sort((a,b)=>a-b)}));flip(number);}
  function showProcessedPage(number:number){const cached=cachedPage(number);if(!cached?.present)return;setHistory(cached);setSelected(cached.present.result.candidates[0]?.id||"");setEditorRevision(n=>n+1);flip(number);}
  function cancelDrag(){const before=drag.current?.before;if(before)setHistory(h=>({...h,present:before}));drag.current=null;}
  function bounds(next:Bounds,record=true){
    if(loading.current||!current||!result||!snapshot)return;
    const value=clampCrop(next,result.width,result.height);if(value.every((v,i)=>v===current.bounds[i]))return;
    if(record){void fitCrop(snapshot,current.id,value,false);return;}
    if(drag.current)drag.current.next=value;
    update(current.id,{bounds:value,dirty:true,confirmed:false,needs_review:true},false);
  }
  function pointer(e:PointerEvent<SVGElement>){const m=svg.current?.getScreenCTM();return m?screenToCanvas({x:e.clientX,y:e.clientY},m):null;}
  function startDrag(e:PointerEvent<SVGElement>,corner:boolean){
    if(loading.current||locked||e.button!==0||!current||!snapshot)return;
    const p=pointer(e);if(!p)return;e.preventDefault();svg.current?.focus();svg.current?.setPointerCapture(e.pointerId);
    drag.current={pointer:e.pointerId,...p,bounds:[...current.bounds],next:[...current.bounds],candidate:current.id,corner,before:snapshot};
  }
  function endDrag(){
    const gesture=drag.current;if(!gesture)return;drag.current=null;
    if(gesture.next.every((v,i)=>v===gesture.bounds[i])){setHistory(h=>({...h,present:gesture.before}));return;}
    void fitCrop(gesture.before,gesture.candidate,gesture.next,false);
  }
  async function recognize(){
    if(!selectedPages.length)return;
    if(batchReady){showProcessedPage(selectedPages.includes(options.page)?options.page:selectedPages[0]);setStep(2);return;}
    const changed=selectedPages.filter(number=>!cachedPage(number)?.present&&pageHistories.current.has(JSON.stringify([path,number])));
    if(changed.length&&!await ask(`第 ${changed.join("、")} 页参数已改变，将重新识别；已有校准可撤销恢复。是否继续？`,{title:"更新切字与拟合",kind:"warning"}))return;
    await run("正在批量切字与拟合…",async()=>{
      stopBatch.current=false;
      const state={total:selectedPages.length,done:0,failed:0,current:null as number|null,reused:0};
      const failures:string[]=[],completed=new Map<number,ImportHistory>();
      setProgress({...state});
      for(const number of selectedPages){
        if(stopBatch.current)break;
        const cached=cachedPage(number);
        if(cached?.present){completed.set(number,cached);state.reused++;state.done++;setProgress({...state});continue;}
        state.current=number;setProgress({...state});setSingleProgress({stage:"rasterize",done:0,total:0});
        try{
          const pageSource={path,models,options:{...options,page:number}};
          const token=++progressToken.current;
          const channel=new Channel<{stage:string;done:number;total:number}>(message=>{if(token===progressToken.current)setSingleProgress(message);});
          const next=await invoke<Result>("inkfont_recognize",{path,options:pageSource.options,model_dir:models||null,on_progress:channel});
          const baseline=pageHistories.current.get(JSON.stringify([path,number]));
          const nextHistory=recordImport(baseline||emptyImportHistory(),{source:pageSource,result:next});
          histories.current.set(sourceKey(pageSource),nextHistory);pageHistories.current.set(JSON.stringify([path,number]),nextHistory);
          completed.set(number,nextHistory);setHistory(nextHistory);
        }catch(e){state.failed++;failures.push(`第 ${number} 页：${String(e)}`);}finally{progressToken.current++;}
        state.done++;setProgress({...state});
      }
      state.current=null;setProgress({...state});setSingleProgress(null);
      const displayed=completed.get(options.page)||completed.values().next().value;
      if(displayed?.present){setHistory(displayed);flip(displayed.present.source.options.page);setSelected(displayed.present.result.candidates[0]?.id||"");setEditorRevision(n=>n+1);}
      setStep(1);setPreviewMode("boxes");
      if(failures.length)setError(`部分页面处理失败，已完成结果保留。再次处理只重试未完成页。\n${failures.join("\n")}`);
      else if(stopBatch.current)setError("已停止后续页面，当前页及此前完成结果已保留。可继续处理剩余页面。");
    });
  }
  async function fitCrop(before:Snapshot,id:string,value:Bounds,retry:boolean){
    if(loading.current)return;
    const candidate=before.result.candidates.find(c=>c.id===id);if(!candidate)return;
    const pendingSnapshot:Snapshot={...before,result:{...before.result,candidates:before.result.candidates.map(c=>c.id===id?{...c,bounds:value,dirty:true,confirmed:false,needs_review:true,error:undefined}:c)}};
    const token=++refitToken.current;
    // Crop and its fitted result share one undo entry; a retry replaces that same pending edit.
    setHistory(h=>retry?{...h,present:pendingSnapshot,future:[]}:recordImport({...h,present:before},pendingSnapshot));
    await run("正在自动拟合框内笔迹…",async()=>{
      try{
        const next=await invoke<Partial<Candidate>>("inkfont_refit",{path:before.source.path,options:before.source.options,bounds:value});
        if(token!==refitToken.current)return;
        if(next.error||!next.strokes?.length)throw new Error(next.error||"框内没有可用笔迹，请调整边框后重试。");
        setHistory(h=>h.present!==pendingSnapshot?h:{...h,present:{...pendingSnapshot,result:{...pendingSnapshot.result,candidates:pendingSnapshot.result.candidates.map(c=>c.id===id?{...c,...next,id:c.id,character:c.character,advance_mm:c.advance_mm,bounds:value,error:undefined,dirty:false,confirmed:false,needs_review:true}:c)}}});
        setEditorRevision(n=>n+1);
      }catch(e){
        if(token!==refitToken.current)return;
        setHistory(h=>h.present!==pendingSnapshot?h:{...h,present:{...pendingSnapshot,result:{...pendingSnapshot.result,candidates:pendingSnapshot.result.candidates.map(c=>c.id===id?{...c,error:String(e)}:c)}}});
        throw e;
      }
    });
  }
  async function refit(){if(current&&snapshot)await fitCrop(snapshot,current.id,current.bounds,!!current.dirty);}
  function edited(variant:InkVariant){if(!locked&&current&&!current.dirty)update(current.id,{character:variant.character,advance_mm:variant.advance_mm,canvas:variant.canvas,strokes:variant.strokes,confirmed:false,error:variantError(variant)?current.error:undefined});}
  async function save(){await run("正在追加字形…",async()=>{
    const variants=pending.map(c=>({id:crypto.randomUUID(),character:c.character,width_mm:c.width_mm,height_mm:c.height_mm,advance_mm:c.advance_mm,canvas:inkCanvas(c),strokes:c.strokes}));
    const latest=await invoke<InkPackage>("inkfont_load",{id:pack.id});onSaved(await invoke<InkPackage>("inkfont_save",{package:{...latest,variants:[...latest.variants,...variants]}}));
  });}
  const historyTools=<div className="history-tools" role="group" aria-label="校准历史"><button className="icon-button" title="撤销校准 Ctrl+Z" aria-label="撤销校准" disabled={locked||!history.past.length} onClick={()=>travel()}><Undo2 size={16}/>撤销</button><button className="icon-button" title="重做校准 Ctrl+Shift+Z" aria-label="重做校准" disabled={locked||!history.future.length} onClick={()=>travel(true)}><Redo2 size={16}/>重做</button></div>;
  const numberField=(field:keyof InkImportOptions,label:string,min:number,max:number,increment=1)=><label className="paper-field" key={field}>{label}<DraftNumberInput className="text-input" type="number" value={Number(options[field])} min={min} max={max} step={increment} disabled={locked} onChange={e=>setOptions(o=>({...o,[field]:Number(e.target.value)}))}/></label>;
  const previewPage=matches?result:page?.page===options.page?page:null;
  return <div className={`ink-import${step===2?" ink-import-calibrating":""}`} onKeyDownCapture={e=>{
    if((e.ctrlKey||e.metaKey)&&["z","y"].includes(e.key.toLowerCase())&&step>=2){if((e.target as Element).closest("input,textarea,select"))return;e.preventDefault();e.stopPropagation();travel(e.shiftKey||e.key.toLowerCase()==="y");}
  }}>
    <header><div><h2>向「{pack.name}」新增字形</h2><p className="field-note">步骤间来回查看保留结果；每页分别保留最近 100 次校准操作，可撤销、重做。</p></div><button className="button" disabled={locked} onClick={()=>void leave()}>返回字包</button></header>
    <nav aria-label="入库步骤">{["选择素材","切字与拟合","人工校准","确认入库"].map((label,i)=><button className="button" key={label} aria-current={step===i?"step":undefined} disabled={locked||(i===1&&(!path||!selectedPages.length))||(i>=2&&(!matches||!selectedPages.includes(options.page)))||(i===3&&!pending.length)} onClick={()=>navigate(i)}>{i+1}. {label}</button>)}</nav>
    {error&&<p role="alert" className="ink-import-error">{error}</p>}{busy&&<p role="status">{busy}</p>}
    {progress&&step!==2&&<section className="section ink-batch-progress" aria-label="切字与拟合进度"><label>批量总进度 · 已处理 {progress.done} / {progress.total} 页<progress aria-label="批量总进度" max={progress.total} value={progress.done}/></label><p className="field-note">成功 {progress.done-progress.failed} 页（复用 {progress.reused} 页），失败 {progress.failed} 页。{progress.current!==null?`当前第 ${progress.current} 页 · 已耗时 ${elapsed} 秒`:progress.done===progress.total?"本批处理结束":"尚有页面未处理"}</p>
      {locked&&singleProgress&&progress.current!==null&&<label>单页进度 · {{rasterize:"加载页面",model_load:"加载识别模型",ocr:"OCR 识别文字",trace:"整页 AutoTrace 拟合",split:"按字切分拟合曲线",curves:"整理可编辑曲线",done:"完成"}[singleProgress.stage]||singleProgress.stage}{singleProgress.total>0&&singleProgress.stage!=="trace"?` · ${singleProgress.done} / ${singleProgress.total} ${singleProgress.stage==="model_load"?"个模型":["split","curves"].includes(singleProgress.stage)?"字":"项"}`:" · 正在处理"}<progress aria-label="单页处理进度" max={singleProgress.total||1} value={singleProgress.total>0&&singleProgress.stage!=="trace"?singleProgress.done:undefined}/></label>}
      {locked&&progress.current!==null&&<button className="button" onClick={()=>{stopBatch.current=true;setBusy("将在当前页完成后停止，已完成结果保留…");}}>停止后续页面</button>}
    </section>}
    {step===0&&<>
      <div className="ink-tools"><button className="button" disabled={locked} onClick={()=>void run("选择文件",async()=>{const p=await open({filters:[{name:"PDF 或图片",extensions:["pdf","png","jpg","jpeg","webp","bmp"]}]});if(typeof p==="string"&&p!==path){setPath(p);setOptions(o=>({...o,page:1}));}})}>{path?"重新选择素材":"选择文件"}</button><span className="field-note">{path||"请选择扫描 PDF 或手写照片"}</span></div>
      <div className="ink-source-pages"><aside className="section"><h3>页面多选</h3><p className="field-note">点击缩略图勾选 / 取消；默认全选。单独预览不改变选择。</p><div className="ink-tools"><button className="button" disabled={locked||!page} onClick={()=>setPageSelections(old=>({...old,[path]:Array.from({length:page!.page_count},(_,i)=>i+1)}))}>全选页面</button><button className="button" disabled={locked} onClick={()=>setPageSelections(old=>({...old,[path]:[]}))}>取消全选</button></div><p role="status">已选 {selectedPages.length} / {page?.page_count||"—"} 页</p>
      <div className="ink-page-thumbnails">{Array.from({length:Math.min(12,Math.max(0,(page?.page_count||0)-thumbStart))},(_,i)=>thumbStart+i+1).map(number=><article key={number} className="ink-page-choice"><button className="button" aria-label={`选择第 ${number} 页`} aria-pressed={selectedPages.includes(number)} disabled={locked} onClick={()=>togglePage(number)}>{thumbs[number]?<img src={thumbs[number]} alt={`第 ${number} 页缩略图`}/>:<span>第 {number} 页</span>}<small>{selectedPages.includes(number)?"✓ 已选":"未选"} · 第 {number} 页</small></button><button className="button" aria-label={`预览第 ${number} 页`} disabled={locked} onClick={()=>flip(number)}>{options.page===number?"正在预览":"预览"}</button></article>)}</div>{(page?.page_count||0)>12&&<div className="ink-tools"><button className="button" disabled={thumbStart===0||locked} onClick={()=>setThumbStart(n=>Math.max(0,n-12))}>上一组</button><button className="button" disabled={thumbStart+12>=(page?.page_count||0)||locked} onClick={()=>setThumbStart(n=>n+12)}>下一组</button></div>}</aside>
      <section className="section"><h3>整页素材</h3>{previewBusy?<p role="status">正在载入页面…</p>:page?<img className="ink-source-image" src={page.image_data_url} alt={`素材第 ${page.page} 页整页预览`}/>:<p className="field-note">选择素材后显示整页内容。</p>}<div className="ink-page-navigation"><button className="button" disabled={locked||previewBusy||options.page<=1} onClick={()=>flip(options.page-1)}>上一页</button><label>页码<DraftNumberInput className="text-input" aria-label="素材页码" type="number" value={options.page} min={1} max={page?.page_count||1} disabled={locked||!page} onChange={e=>flip(Math.round(Number(e.target.value)))}/></label><span>/ {page?.page_count||"—"}</span><button className="button" disabled={locked||previewBusy||!page||options.page>=page.page_count} onClick={()=>flip(options.page+1)}>下一页</button></div></section></div>
      <footer><p className="field-note">一次处理所有勾选页面。取消勾选不删除草稿，但该页不参与处理和入库。</p><button className="button primary" disabled={locked||previewBusy||!page||!selectedPages.length} onClick={()=>{if(!selectedPages.includes(options.page))flip(selectedPages[0]);navigate(1);}}>设置切字与拟合</button></footer>
    </>}
    {step===1&&<>
      <div className="ink-fit-layout"><section className="section"><h3>批量转换参数 · 已选 {selectedPages.length} 页</h3><div className="field-grid">{numberField("dpi","分辨率（dpi）",72,600)}{numberField("threshold","二值化阈值",1,254)}{numberField("tolerance_mm","路径展平误差（mm）",0.005,1,0.005)}</div><Toggle label="保守拟合" checked={options.conservative} disabled={locked} onChange={v=>setOptions(o=>({...o,conservative:v}))}/>
      <details><summary>参考参数对照</summary><table><thead><tr><th>参数</th><th>默认</th><th>保守</th></tr></thead><tbody><tr><td>预平滑</td><td>4 次</td><td>0 次</td></tr><tr><td>曲线误差</td><td>2 px</td><td>0.5 px</td></tr><tr><td>直线误差</td><td>1 px</td><td>0.5 px</td></tr></tbody></table><p className="field-note">阈值 180 保留较浅墨迹；128 可减少背景噪声。保守拟合保留更多细节。</p></details>
      <details><summary>高级参数与本地模型</summary><div className="field-grid">{numberField("filter_iterations","预平滑次数",0,20)}{numberField("error_threshold","曲线误差（px）",0.1,20,0.1)}{numberField("line_threshold","直线误差（px）",0.1,20,0.1)}{numberField("despeckle_level","去斑等级",0,20)}</div><label className="paper-field">识别模型目录（留空使用安装目录）<input className="text-input" value={models} disabled={locked} onChange={e=>setModels(e.target.value)}/></label><button className="button" disabled={locked} onClick={()=>void run("选择模型目录",async()=>{const p=await open({directory:true});if(typeof p==="string")setModels(p);})}>选择模型目录</button></details>
      <p className="field-note">已选 {selectedPages.length} 页，已有 {readyPages.length} 页可复用；未完成或参数改变的页面将批量处理。每页编辑和撤销记录分别保留。</p><button className="button primary full" disabled={locked||!selectedPages.length||previewBusy} onClick={()=>void recognize()}>{batchReady?"继续人工校准":`批量切字与拟合（${selectedPages.length} 页）`}</button>{!batchReady&&readyPages.length>0&&<button className="button" disabled={locked} onClick={()=>{showProcessedPage(readyPages[0]);setStep(2);}}>先校准已完成页面</button>}
      <label className="paper-field">查看预览页<select className="text-input" aria-label="预览处理页" value={selectedPages.includes(options.page)?options.page:""} disabled={locked} onChange={e=>{const number=Number(e.target.value);if(cachedPage(number)?.present)showProcessedPage(number);else flip(number);}}><option value="" disabled>请选择页面</option>{selectedPages.map(number=><option key={number} value={number}>第 {number} 页 · {cachedPage(number)?.present?"已完成":"待处理"}</option>)}</select></label></section>
      <section className="section"><div className="ink-tools">{([['boxes','切字效果'],['curves','拟合效果'],['overlay','原图与曲线叠加']] as const).map(([mode,label])=><button className="button" key={mode} aria-pressed={previewMode===mode} onClick={()=>setPreviewMode(mode)}>{label}</button>)}</div>
      {previewPage&&<svg className="ink-fit-preview" viewBox={`0 0 ${previewPage.width} ${previewPage.height}`} aria-label="切字与拟合预览">{(previewMode!=="curves"||!matches)&&<image href={previewPage.image_data_url} width={previewPage.width} height={previewPage.height} opacity={previewMode==="overlay"&&matches?0.35:1}/>}{matches&&result?.candidates.map(c=>previewMode==="boxes"?<rect key={c.id} x={c.bounds[0]} y={c.bounds[1]} width={c.bounds[2]} height={c.bounds[3]} fill="transparent" stroke={c.needs_review?"#c34250":"#6655db"} strokeWidth="1" vectorEffect="non-scaling-stroke"><title>{c.character}</title></rect>:!c.dirty&&<g key={c.id} transform={glyphPageTransform(c.bounds)}>{c.strokes.map((stroke,i)=><polyline key={i} points={stroke.map(p=>`${p.x},${p.y}`).join(" ")} fill="none" stroke="#6655db" strokeWidth="1.2" vectorEffect="non-scaling-stroke"/>)}</g>)}</svg>}{previewBusy&&<p role="status">正在载入页面…</p>}</section></div>
      {matches&&<details className="section"><summary>逐字查看切片与拟合 · {candidates.length} 个</summary><div className="ink-fit-glyphs">{candidates.map(c=><button className="button" key={c.id} onClick={()=>{setSelected(c.id);setStep(2);}}><span>{c.character||"?"}</span><div>{c.crop_data_url&&<img src={c.crop_data_url} alt={`${c.character} 原始切片`}/>}<InkGlyphView variant={c}/></div><small>{c.dirty?"局部拟合待重试":c.error?"待修复":"进入校准"}</small></button>)}</div></details>}
      <footer><button className="button" disabled={locked} onClick={()=>navigate(0)}>重新选择素材 / 页面</button>{historyTools}</footer>
    </>}
    {step===2&&result&&<>
      <label className="paper-field ink-calibration-page">校准页面<select className="text-input" aria-label="校准页面" value={options.page} disabled={locked} onChange={e=>showProcessedPage(Number(e.target.value))}>{readyPages.map(number=><option key={number} value={number}>第 {number} 页 · {cachedPage(number)?.present?.result.candidates.filter(c=>c.confirmed&&!c.excluded).length||0} 个已确认</option>)}</select></label>
      <div className="ink-calibration-layout"><aside className="section"><h3>逐字校准 · {candidates.length}</h3><p className="field-note">待校准优先。已确认 {confirmed.length} 个。</p><div className="ink-import-queue">{candidates.map(c=><button className={`button ${c.id===selected?"primary":""} ${!c.confirmed&&c.needs_review?"ink-import-review-needed":""}`} key={c.id} disabled={locked} onClick={()=>setSelected(c.id)}>{c.character||"?"}<small>{c.excluded?"已排除":c.confirmed?"已确认":c.error?"拟合失败":c.crossing?"跨框":c.touching?"触边":`${Math.round(c.confidence*100)}%`}</small></button>)}</div><button className="button" disabled={locked} onClick={()=>commit({...snapshot!,result:{...result,candidates:result.candidates.map(c=>!c.excluded&&!c.needs_review&&!c.dirty&&!c.error&&!variantError(c)?{...c,confirmed:true}:c)}})}>确认全部高可信字形</button></aside>
      {current&&context?<><section className="section ink-crop-context"><h3>附近原稿与切字边框</h3><p className="field-note">拖动边框或右下角，松手后自动拟合框内笔迹；数字修改在提交后自动拟合。撤销可一起恢复边框与此前编辑。</p><svg className="ink-import-page" ref={svg} viewBox={context.join(" ")} aria-label="单字附近原稿" tabIndex={0} onPointerMove={e=>{const d=drag.current,p=pointer(e);if(!d||!p||d.pointer!==e.pointerId)return;const dx=p.x-d.x,dy=p.y-d.y;bounds(d.corner?[d.bounds[0],d.bounds[1],d.bounds[2]+dx,d.bounds[3]+dy]:[d.bounds[0]+dx,d.bounds[1]+dy,d.bounds[2],d.bounds[3]],false);}} onPointerUp={endDrag} onPointerCancel={cancelDrag} onLostPointerCapture={()=>{if(drag.current)cancelDrag();}} onKeyDown={e=>{if(e.key==="Escape"&&drag.current){e.preventDefault();cancelDrag();}}}>
      <image href={result.image_data_url} width={result.width} height={result.height}/><rect x={current.bounds[0]} y={current.bounds[1]} width={current.bounds[2]} height={current.bounds[3]} fill="transparent" stroke="#6655db" strokeWidth="2" vectorEffect="non-scaling-stroke" onPointerDown={e=>startDrag(e,false)}/><circle cx={current.bounds[0]+current.bounds[2]} cy={current.bounds[1]+current.bounds[3]} r={context[2]/40} fill="#6655db" aria-label="拖动缩放边框" onPointerDown={e=>startDrag(e,true)}/></svg>
      <div className="field-grid">{["左侧 X","顶部 Y","宽度","高度"].map((label,i)=><label className="paper-field" key={label}>{label}<DraftNumberInput className="text-input" type="number" value={current.bounds[i]} min={i<2?0:1} disabled={locked} onChange={e=>bounds(current.bounds.map((v,k)=>k===i?Number(e.target.value):v) as Bounds)}/></label>)}</div>{current.error&&<p role="alert" className="ink-import-error">{current.error}</p>}{current.dirty&&<p className="field-note">{locked?"正在拟合框内笔迹，请稍候。":"局部拟合未完成，可重试或调整边框；撤销可恢复此前边框与笔迹编辑。"}</p>}<button className="button" disabled={locked} onClick={()=>void refit()}>{current.dirty?"重试局部拟合":"重新拟合此字"}</button><button className="button" disabled={locked} onClick={()=>update(current.id,{excluded:!current.excluded,confirmed:false})}>{current.excluded?"恢复此字形":"排除此字形"}</button></section>
      <section className="ink-calibration-editor"><fieldset disabled={locked||current.dirty} className="ink-editor-fieldset"><InkGlyphEditor key={`${selected}-${editorRevision}`} embedded locked={locked||!!current.dirty} variant={current} packName={pack.name} backgroundUrl={current.crop_data_url} onDraftChange={edited} historyToolbar={null} onSave={async()=>{}} onExit={()=>{}}/></fieldset></section></>:<p>没有检测到字符。可返回调整参数或更换素材。</p>}</div>
      <footer>{historyTools}<div className="ink-tools"><button className="button" disabled={locked} onClick={()=>navigate(1)}>查看切字与拟合</button><button className="button primary" disabled={locked||!current||current.dirty||!!current.error||!!variantError(current)} onClick={()=>{if(!current)return;update(current.id,{confirmed:true,excluded:false});const next=candidates.find(c=>c.id!==current.id&&!c.confirmed&&!c.excluded);if(next)setSelected(next.id);}}>确认并查看下一个</button><button className="button primary" disabled={locked||!pending.length} onClick={()=>navigate(3)}>核对入库 · {pending.length} 个字形</button></div></footer>
    </>}
    {step===3&&<section className="section"><h3>追加到 {pack.name}</h3><p>将保存本次各素材页面共 {pending.length} 个已确认字形，包含 {new Set(pending.map(c=>c.character)).size} 个字符。</p>{includedDrafts.map(d=>{const chosen=d.result.candidates.filter(c=>c.confirmed&&!c.excluded);return chosen.length?<p key={JSON.stringify([d.source.path,d.source.options.page])}>{d.source.path.split(/[\\/]/).pop()} · 第 {d.source.options.page} 页 · {chosen.length} 个：{chosen.map(c=>c.character).join(" ")}</p>:null;})}<p className="field-note">未勾选页面、未确认或已排除字形不入库；同一素材同一页仅使用当前保留的一组结果。已完成的编辑与不同写法共同保留。</p><footer><button className="button" disabled={locked} onClick={()=>navigate(2)}>返回校准</button>{historyTools}<button className="button primary" disabled={locked||!pending.length} onClick={()=>void save()}>保存到字包</button></footer></section>}
  </div>;
}
