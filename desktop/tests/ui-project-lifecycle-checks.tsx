import React, {act, useState} from "react";
import {createRoot} from "react-dom/client";
import assert from "node:assert/strict";
import {useProjectFiles} from "../ui/src/useProjectFiles";
import type {Project} from "../ui/src/projectModel";

export async function projectLifecycleChecks() {
  let picker: string | null = "/first.inkproj", picks = 0, fail = false, opened = 0, reset = 0;
  let hold: (() => void) | null = null, defer = false;
  let openPath = "/opened.inkproj", defaultPath = "";
  const writes: {path:string; value:number}[] = [], errors: string[] = [];
  (globalThis as any).__saveMock = async (options: any) => { picks++; defaultPath = options.defaultPath; return picker; };
  (globalThis as any).__openMock = async (options: any) => { assert.ok(options.filters[0].extensions.includes("kjoy")); return openPath; };
  function Harness() {
    const [value, setValue] = useState(0), [path, setPath] = useState("");
    const files = useProjectFiles({snapshot: {current_page:value} as Project, path, onPath:setPath, blocked:false, desktop:true,
      onSave: async (path, project) => {
        if(fail)throw new Error("write failed");
        if(defer)await new Promise<void>(resolve => {hold=resolve;});
        writes.push({path,value:project.current_page});
      },
      onOpen:async()=>{opened++; if(fail)throw new Error("read failed");setValue(20);},
      onNew:async()=>{reset++;setValue(0);},onMessage:(message,error)=>{if(error)errors.push(message);}});
    return <><output id="project-state">{`${value}|${path}|${files.dirty}`}</output>
      <button onClick={()=>setValue(v=>v+1)}>Edit</button>
      <button onClick={()=>void files.saveProject()}>Save</button>
      <button onClick={()=>void files.saveProject(true)}>Save as</button>
      <button onClick={()=>void files.openProject()}>Open</button>
      <button onClick={()=>void files.newProject()}>New</button>{files.confirmation}</>;
  }
  const root=createRoot(document.getElementById("root")!);
  const click=async(text:string)=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===text);assert.ok(b,text);await act(async()=>b.click());};
  const state=()=>document.getElementById('project-state')!.textContent;
  try {
    await act(async()=>root.render(<Harness/>));assert.equal(state(),'0||false');
    await click('Edit');assert.equal(state(),'1||true');
    await click('Save');assert.equal(picks,1);assert.equal(state(),'1|/first.inkproj|false');assert.equal((globalThis as any).__windowTitle,'first.inkproj · OpenInk Studio');
    await click('Edit');await click('Save');assert.equal(picks,1,'Save overwrites current path without another picker');
    picker='/copy.inkproj';await click('Save as');assert.equal(picks,2);assert.equal(state(),'2|/copy.inkproj|false');
    await click('Edit');picker=null;await click('Save as');assert.equal(state(),'3|/copy.inkproj|true','Canceled Save as retains path and dirty state');
    fail=true;await click('Save');assert.equal(state(),'3|/copy.inkproj|true');assert.ok(errors.includes('Error: write failed'));
    await click('New');await click('保存并继续');assert.equal(reset,0,'Failed save blocks destructive new project');
    fail=false;await click('Open');await click('取消');assert.equal(opened,0);assert.equal(state(),'3|/copy.inkproj|true');
    await click('Open');await click('不保存');assert.equal(opened,1);assert.equal(state(),'20|/opened.inkproj|false');
    fail=true;await click('Open');assert.equal(state(),'20|/opened.inkproj|false','Failed load preserves current path and content');fail=false;
    await click('Edit');await click('New');await click('保存并继续');assert.equal(reset,1);assert.equal(state(),'0||false');assert.equal((globalThis as any).__windowTitle,'OpenInk Studio · 自由书写');
    picker='/deferred.inkproj';await click('Edit');defer=true;await click('Save');await click('Edit');assert.ok(hold);
    await act(async()=>hold!());assert.equal(state(),'2|/deferred.inkproj|true','Concurrent edit cannot be marked saved');
    assert.equal(writes.at(-1)!.value,1);defer=false;
    let prevented=false;await act(async()=>{(globalThis as any).__windowCloseRequest({preventDefault(){prevented=true;}});});
    assert.equal(prevented,true);await click('取消');assert.equal((globalThis as any).__windowCloseCount||0,0);
    await act(async()=>{(globalThis as any).__windowCloseRequest({preventDefault(){}});});await click('保存并继续');
    assert.equal((globalThis as any).__windowCloseCount,1);
    openPath='/legacy.KJOY'; await click('Open');
    const beforeLegacy = writes.length; picker=null; await click('Save');
    assert.equal(defaultPath, '/legacy.inkproj'); assert.equal(writes.length,beforeLegacy);
    assert.equal(state(),'20|/legacy.KJOY|false','Cancel conversion preserves the old project');
    picker='/converted.inkproj'; await click('Save');
    assert.equal(writes.at(-1)!.path,picker); assert.equal(state(),'20|/converted.inkproj|false');
    console.log('PASS: project save/overwrite/Save as, canceled/failed writes, unsaved choices, failed open, exact saved snapshot, native close guard (mock IPC).');
  } finally {await act(async()=>root.unmount());delete (globalThis as any).__saveMock;delete (globalThis as any).__windowCloseCount;delete (globalThis as any).__windowTitle;}
}
