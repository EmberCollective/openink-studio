import test from "node:test";
import assert from "node:assert/strict";
import { batchesOf, batchOf, batchDocument, batchStatus, assignBatch, replaceBatchRoute, copyBatchPage, cleanBatchData, uniquePageStrokeIds } from "./batchModel.ts";
import { ensureStrokeIds, unwrittenDocument } from "./writtenTracking.ts";
const fixture = () => ensureStrokeIds({ name:"page", width_mm:210, height_mm:297, strokes: [0,10,20].map(x => [{x,y:1},{x:x+1,y:2}]), strokeOwners:["a","b","c"] });
test("legacy page stays one batch; selection moves without duplicating paths", () => {
 const d=fixture(), before=structuredClone(d);
 assert.equal(batchesOf(d).length,1);
 const split=assignBatch({...d,batches:[...batchesOf(d),{id:"second",name:"second",color:1}]},[1,2],"second");
 assert.deepEqual(d,before);
 assert.equal(batchOf(split,0),"default");
 assert.deepEqual(batchDocument(split,"second").strokes,d.strokes.slice(1));
 assert.deepEqual(batchDocument(split,"default").strokeOwners,["a"]);
 assert.deepEqual(split.strokes,d.strokes);
 assert.throws(()=>assignBatch(d,[0],"missing"));
});
test("route replacement cannot delete other batch pending or completed paths", () => {
 let d=fixture();d=assignBatch({...d,batches:[...batchesOf(d),{id:"b",name:"B",color:2}]},[1,2],"b");
 const written=new Set([d.strokeIds[1]]), replacement={...fixture(),strokes:[[{x:40,y:1},{x:41,y:2}]],strokeOwners:["new"]};
 const result=replaceBatchRoute(d,"b",replacement,written);
 assert.deepEqual(result.strokes.slice(0,2),d.strokes.slice(0,2));
 assert.deepEqual(result.strokeIds.slice(0,2),d.strokeIds.slice(0,2));
 assert.equal(batchOf(result,2),"b");
 assert.equal(batchStatus(result,"b",written),"待书写");
 assert.deepEqual(unwrittenDocument(batchDocument(result,"b"),written).strokes,replacement.strokes);
 assert.equal(batchStatus(d,"b",new Set(d.strokeIds.slice(1))),"已完成");
});
test("copy page remaps ownership, clears completion and review, stale map keys cleaned",()=>{
 let d=fixture();d=assignBatch({...d,batches:[...batchesOf(d),{id:"b",name:"B",color:2}]},[2],"b");
 d.writtenStrokeIds=[d.strokeIds[2]];d.reviewBatchIds=["b"];
 const copy=copyBatchPage(d);
 assert.equal(batchOf(copy,2),"b");assert.equal(batchOf(copy,0),"default");
 assert.ok(copy.strokeIds.every(id=>!d.strokeIds.includes(id)));
 assert.deepEqual(copy.writtenStrokeIds,[]);assert.deepEqual(copy.reviewBatchIds,[]);
 const removed={...d,strokes:d.strokes.slice(0,2),strokeIds:d.strokeIds.slice(0,2)};
 assert.deepEqual(cleanBatchData(removed).strokeBatches,{});
});
test("legacy duplicate IDs are remapped across pages with ownership and completion intact",()=>{
 let d=fixture();d=assignBatch({...d,batches:[...batchesOf(d),{id:"b",name:"B",color:2}]},[2],"b");
 const original=structuredClone(d), copy=structuredClone(d);copy.writtenStrokeIds=[copy.strokeIds[2]];
 const pages=uniquePageStrokeIds([original,copy]);
 assert.equal(new Set(pages.flatMap(d=>d.strokeIds)).size,6);
 assert.equal(batchOf(pages[1],2),"b");
 assert.deepEqual(pages[1].writtenStrokeIds,[pages[1].strokeIds[2]]);
 assert.equal(batchStatus(pages[0],"b",new Set(pages[1].writtenStrokeIds)),"待书写");
 const reordered={...d,batches:[...d.batches].reverse()};
 assert.equal(batchOf(reordered,0),"default","reordering cannot move implicit default ownership");
});
