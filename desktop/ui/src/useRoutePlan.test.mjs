import test from "node:test";
import assert from "node:assert/strict";
import { createRoutePlanner } from "./useRoutePlan.ts";
const document = { name: "test", width_mm: 100, height_mm: 100, strokes: [[{x:1,y:2},{x:3,y:4}], [{x:5,y:6},{x:7,y:8}]], materials:[{id:"a",name:"A",kind:"svg"}], strokeOwners:["a","b"] };
const request = {document, start:null, allow_reverse:true, travel_feed_mm_min:1500};
test("trajectory OFF preserves order/direction without computing, ON has a distinct optimized snapshot", async () => {
  let calls=0;
  const plan=createRoutePlanner(async()=>{calls++;return result;});
  const original=await plan({...request,optimize:false});
  assert.equal(calls,0);assert.deepEqual(original.document.strokes,document.strokes);assert.deepEqual(original.stroke_order,[0,1]);assert.deepEqual(original.document.strokeOwners,document.strokeOwners);
  const optimized=await plan({...request,optimize:true});
  assert.equal(calls,1);assert.deepEqual(optimized.document.strokes,result.document.strokes);assert.notEqual(original.key,optimized.key);
  assert.equal(await plan({...request,optimize:false}),original);
});
const result = {document:{...document,strokes:[document.strokes[1],document.strokes[0]]}, stroke_order:[1,0],before_distance_mm:10,after_distance_mm:2,before_travel_seconds:1,after_travel_seconds:.2};
test("same exact geometry shares the pending route for start and export", async () => {
  let calls=0, resolve;
  const plan=createRoutePlanner(()=>{calls++;return new Promise(r=>resolve=r);});
  const first=plan(request), start=plan(structuredClone(request));
  assert.equal(first,start); assert.equal(calls,1);
  resolve(result);
  const snapshot=await start;
  assert.deepEqual(snapshot.document.strokeOwners,["b","a"]);
  assert.deepEqual(document.strokeOwners,["a","b"]);
  assert.equal(await plan(request),snapshot);
});
test("geometry, direction, travel feed and known fixed start each invalidate route", async () => {
  let calls=0;
  const plan=createRoutePlanner(async()=>{calls++;return result;});
  await plan(request);
  await plan({...request,allow_reverse:false});
  await plan({...request,travel_feed_mm_min:1200});
  await plan({...request,start:{x:9,y:10}});
  await plan({...request,document:{...document,strokes:document.strokes.slice(1)}});
  assert.equal(calls,5);
});
test("failed route cannot fall back to old geometry and explicit retry recovers", async () => {
  let calls=0;
  const plan=createRoutePlanner(async()=>{if(++calls===1)throw Error("planner unavailable");return result;});
  await assert.rejects(plan(request),/unavailable/);
  assert.deepEqual((await plan(request)).document.strokes,result.document.strokes);
  assert.equal(calls,2);
});
test("out of order completion retains exact result keys", async () => {
  const resolvers=[];
  const plan=createRoutePlanner(()=>new Promise(r=>resolvers.push(r)));
  const old=plan(request), latest=plan({...request,allow_reverse:false});
  resolvers[1](result); const newer=await latest;
  resolvers[0](result); const older=await old;
  assert.notEqual(newer.key,older.key);
  assert.equal(JSON.parse(newer.key).allow_reverse,false);
});
