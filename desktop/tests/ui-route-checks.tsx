import React, { act } from "react";
import { createRoot } from "react-dom/client";
import assert from "node:assert/strict";
import { useRoutePlan, type RouteRequest, type RouteResult } from "../ui/src/useRoutePlan";
import { RouteOverlay, strokeDirection } from "../ui/src/RouteOverlay";
import { canApplyRouteVariant, type RouteVariant } from "../ui/src/RouteComparison";

export async function routeHookChecks() {
  const eligible = { id: "aggressive", eligible: true, coverage_preserved: true, savings_percent: 5 } as RouteVariant;
  assert.equal(canApplyRouteVariant(eligible),true);
  assert.equal(canApplyRouteVariant({...eligible,savings_percent:0}),true);
  assert.equal(canApplyRouteVariant({...eligible,savings_percent:-10}),true);
  assert.equal(canApplyRouteVariant({...eligible,savings_percent:4.99}),true);
  assert.equal(canApplyRouteVariant({...eligible,coverage_preserved:false}),false);
  assert.equal(canApplyRouteVariant({...eligible,eligible:false}),false);
  assert.equal(canApplyRouteVariant({...eligible,id:"current"}),false);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const pending: { input: RouteRequest; resolve: (r: RouteResult) => void; reject: (e: Error) => void }[] = [];
  const compute = (input: RouteRequest) => new Promise<RouteResult>((resolve, reject) => pending.push({input,resolve,reject}));
  const base: RouteRequest = {document:{name:"route",width_mm:100,height_mm:100,strokes:[[{x:10,y:10},{x:20,y:20}],[{x:30,y:30},{x:40,y:40}]]},start:null,allow_reverse:true,travel_feed_mm_min:1500};
  let latest: ReturnType<typeof useRoutePlan>;
  function Harness({input}: {input: RouteRequest}) {
    latest = useRoutePlan(input,compute,false);
    return <><span data-state>{latest.status}</span>{latest.snapshot && <svg><RouteOverlay snapshot={latest.snapshot} selectedIndex={1} /></svg>}</>;
  }
  const render = async (input: RouteRequest) => act(async()=>root.render(<Harness input={input}/>));
  const wait = async () => act(async()=>{await new Promise(r=>setTimeout(r,210));});
  const result = (input: RouteRequest): RouteResult => ({document:{...input.document,strokes:[...input.document.strokes].reverse().map(s=>[...s].reverse())},stroke_order:[1,0],before_distance_mm:30,after_distance_mm:10,before_travel_seconds:1,after_travel_seconds:.4});
  await render(base);
  await render({...base,travel_feed_mm_min:1200});
  assert.equal(pending.length,0,"Debounce must not start transient geometries");
  await wait(); assert.equal(pending.length,1);
  const newer={...base,travel_feed_mm_min:900};await render(newer);await wait();assert.equal(pending.length,2);
  await act(async()=>pending[1].resolve(result(newer)));
  assert.equal(latest!.status,"ready");assert.equal(JSON.parse(latest!.snapshot!.key).travel_feed_mm_min,900);
  await act(async()=>pending[0].resolve(result(base)));
  assert.equal(JSON.parse(latest!.snapshot!.key).travel_feed_mm_min,900,"Late result must never replace current route");
  assert.equal(host.querySelectorAll('line').length,0,"Single-stroke inspection never displays travel for the full document");
  const stroke=host.querySelector('polyline[marker-end]')!;assert.equal(stroke.getAttribute('points'),'40,40 30,30');
  assert.equal(host.querySelectorAll('polyline').length,2,"Only selected stroke plus its contrast outline are rendered");
  assert.ok(host.querySelector('g[aria-label="已选第1笔"]'),'Selected route stroke has a separate high-contrast overlay');
  assert.ok(host.querySelector('path[aria-label="选中笔画中段书写方向"]'),'Selected stroke carries a midpoint direction arrow');
  const closed=[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:0}];assert.ok(strokeDirection(closed),'Closed strokes retain an unambiguous intermediate direction');
  assert.notDeepEqual(strokeDirection(closed),strokeDirection([...closed].reverse()),'Reversing a closed stroke changes arrow direction');
  const fixed={...newer,start:{x:0,y:0}};await render(fixed);await wait();
  assert.equal(latest!.snapshot,undefined,"New input immediately hides stale route");
  await act(async()=>pending[2].reject(Error("offline failure")));
  assert.equal(latest!.status,"error");assert.equal(latest!.snapshot,undefined);
  await act(async()=>latest!.recompute());await wait();await act(async()=>pending[3].resolve(result(fixed)));
  assert.equal(host.querySelectorAll('line').length,0,"Known fixed pen must not add travel to the single-stroke overlay");
  await act(async()=>root.unmount());host.remove();
  console.log("PASS: real async route hook debounce, latest geometry, out-of-order rejection, error/retry; only selected stroke and direction displayed.");
}
