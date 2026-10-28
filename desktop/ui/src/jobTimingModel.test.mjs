import test from "node:test";
import assert from "node:assert/strict";
import { beginJobTiming, updateJobTiming, elapsedSeconds, remainingSeconds, cancelJobTiming } from "./jobTimingModel.ts";
const event = (state, payload, now=1000, epoch=1) => updateJobTiming(state,payload,now,epoch);
function running() {
  let state=beginJobTiming(1);
  state=event(state,{type:"timing",total_seconds:100,cumulative_seconds:[10,90,100]});
  return event(state,{type:"job_started"});
}
test("remaining time uses duration weights and ACK completion never means physical completion",()=>{
  let state=running();state=event(state,{type:"progress",sent:1,total:3},21000);
  assert.equal(elapsedSeconds(state,21000),20);assert.equal(remainingSeconds(state,21000),90);
  state=event(state,{type:"progress",sent:3,total:3},22000);
  assert.equal(state.ackedAll,true);assert.equal(state.phase,"running");assert.equal(remainingSeconds(state,22000),79);
  assert.equal(remainingSeconds(state,200000),0);assert.equal(state.phase,"running");
});
test("pause freezes elapsed and resume excludes paused wall time",()=>{
  let state=event(running(),{type:"paused",paused:true},16000);
  assert.equal(elapsedSeconds(state,100000),15);
  state=event(state,{type:"paused",paused:false},100000);
  assert.equal(elapsedSeconds(state,105000),20);
});
test("stop freezes elapsed, late task events are ignored and next start clears old estimates",()=>{
  const state=cancelJobTiming(running(),16000);
  assert.equal(elapsedSeconds(state,500000),15);assert.equal(remainingSeconds(state,500000),null);
  assert.equal(event(state,{type:"job_started"},20000),state);assert.equal(event(state,{type:"timing",total_seconds:9,cumulative_seconds:[9]},20000),state);
  const next=beginJobTiming(2);assert.equal(next.totalSeconds,null);assert.equal(next.sent,0);assert.equal(next.elapsedMs,0);
  assert.equal(event(next,{type:"progress",sent:3,total:3},20000,1),next);
});
test("only actual completed event ends remaining time; malformed estimates stay unknown",()=>{
  const state=event(running(),{type:"completed"},31000);
  assert.equal(remainingSeconds(state,500000),0);assert.equal(elapsedSeconds(state,500000),30);
  const pending=beginJobTiming(1);
  assert.equal(event(pending,{type:"timing",total_seconds:100,cumulative_seconds:[90,10]}),pending);
  assert.equal(event(pending,{type:"timing",total_seconds:NaN,cumulative_seconds:[1]}),pending);
  assert.equal(remainingSeconds(event(pending,{type:"job_started"}),12000),null);
});
