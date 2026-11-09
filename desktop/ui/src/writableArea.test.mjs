import test from "node:test";
import assert from "node:assert/strict";
import {writableArea,boundsWithinArea} from "./writableArea.ts";
test("fit uses the full chosen page without A4 clipping",()=>{
  assert.deepEqual(writableArea(420,600,10),{x:10,y:10,width:400,height:580});
  assert.equal(boundsWithinArea({x:10,y:10,width:400,height:580},writableArea(420,600,10)),true);
});
test("invalid page geometry cannot produce a fit",()=>{
  for(const args of [[NaN,297,0],[210,297,-1],[20,20,10]])assert.equal(writableArea(...args),null);
  assert.equal(boundsWithinArea({x:0,y:0,width:NaN,height:1},writableArea(210,297,0)),false);
});
