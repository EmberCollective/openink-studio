// Offline React/jsdom integration. No browser automation, IPC or hardware.
// Setup: npm --prefix .cache/ui-editor-tests install --package-lock=false jsdom@26
// Run: node desktop/tests/ui-three-point-checks.mjs
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {installPaperImageMock} from './paper-image-mock.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const uiRequire=createRequire(path.join(root,'desktop/ui/package.json'));
const testRequire=createRequire(path.join(root,'.cache/ui-editor-tests/package.json'));
const {JSDOM}=testRequire('jsdom');
const {build,stop}=uiRequire('esbuild');
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'});
installPaperImageMock(dom.window);
for(const key of ['window','document','navigator','HTMLElement','Element','HTMLInputElement','SVGElement','SVGSVGElement','Event','MouseEvent','KeyboardEvent'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=callback=>setTimeout(()=>callback(Date.now()),0);
globalThis.cancelAnimationFrame=handle=>clearTimeout(handle);
window.__TAURI_INTERNALS__={};
Object.defineProperty(window.SVGSVGElement.prototype,'viewBox',{get(){const n=(this.getAttribute('viewBox')||'0 0 160 240').split(/\s+/).map(Number);return {baseVal:{x:n[0],y:n[1],width:n[2],height:n[3]}}}});
window.SVGElement.prototype.getBoundingClientRect=function(){return {left:0,top:0,width:1600,height:2400,right:1600,bottom:2400}};
window.SVGElement.prototype.setPointerCapture=function(){};
window.SVGElement.prototype.hasPointerCapture=function(){return false};
window.SVGElement.prototype.releasePointerCapture=function(){};
const out=path.join(root,'.cache/ui-editor-tests/three-point-checks.cjs');
await build({entryPoints:[path.join(root,'desktop/tests/ui-three-point-checks.tsx')],bundle:true,platform:'node',format:'cjs',outfile:out,jsx:'automatic',nodePaths:[path.join(root,'desktop/ui/node_modules')],plugins:[{name:'offline-ipc',setup(b){b.onResolve({filter:/^@tauri-apps\//},a=>({path:a.path,namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const getCurrentWindow=()=>globalThis.__testNativeWindow||({destroy:async()=>{globalThis.__windowCloseCount=(globalThis.__windowCloseCount||0)+1;},minimize:async()=>{globalThis.__windowMinimizeCount=(globalThis.__windowMinimizeCount||0)+1;},toggleMaximize:async()=>{globalThis.__windowMaximizeCount=(globalThis.__windowMaximizeCount||0)+1;},isMaximized:async()=>false,onResized:async()=>()=>{},startDragging:async()=>{globalThis.__windowDragCount=(globalThis.__windowDragCount||0)+1;},onCloseRequested:async cb=>{globalThis.__windowCloseRequest=cb;return ()=>{if(globalThis.__windowCloseRequest===cb)delete globalThis.__windowCloseRequest;};},close:async()=>{globalThis.__windowCloseCount=(globalThis.__windowCloseCount||0)+1;}});export const invoke=(...a)=>globalThis.__invokeMock(...a);export const open=(...a)=>globalThis.__openMock(...a);export const save=(...a)=>globalThis.__saveMock?globalThis.__saveMock(...a):Promise.resolve("offline.svg");export const ask=(...a)=>globalThis.__askMock?globalThis.__askMock(...a):Promise.resolve(true);',loader:'js'}))}}]});
try{await testRequire(out).threePointChecks();}catch(error){console.error(error);process.exitCode=1;}finally{dom.window.close();stop();}
// React's Node MessageChannel scheduler retains a port after the root unmounts.
process.exit(process.exitCode||0);
