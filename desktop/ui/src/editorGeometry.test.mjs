import test from "node:test";
import assert from "node:assert/strict";
import {
  boundsOf,
  selectByRectangle,
  movePaths,
  rotatePaths,
  resizePaths,
  copyPaths,
  pastePaths,
  deletePaths,
  resizeHandles,
  handlePoint,
  resizeFromHandle,
  rotationFromPointer,
} from "./editorGeometry.ts";
test("all eight handles keep opposite anchors fixed; edge midpoints change one axis", () => {
  const doc={name:"handles",width_mm:100,height_mm:100,strokes:[[{x:10,y:20},{x:30,y:40}],[{x:70,y:70},{x:80,y:80}]]};
  const box=boundsOf(doc,[0]);
  for(const handle of resizeHandles){
    const start=handlePoint(box,handle);
    const dx=handle.includes('w')?-5:handle.includes('e')?5:0,dy=handle.includes('n')?-5:handle.includes('s')?5:0;
    const next=resizeFromHandle(doc,[0],handle,{x:start.x+dx,y:start.y+dy},false);
    const resized=boundsOf(next,[0]);
    if(handle.includes('w'))assert.equal(resized.x+resized.width,30);else assert.equal(resized.x,10);
    if(handle.includes('n'))assert.equal(resized.y+resized.height,40);else assert.equal(resized.y,20);
    assert.equal(resized.width,dx?25:20);assert.equal(resized.height,dy?25:20);assert.deepEqual(next.strokes[1],doc.strokes[1]);
  }
});
test("corner ratio lock, crossing clamp and zero-width strokes stay finite",()=>{
  const doc={name:"handles",width_mm:100,height_mm:100,strokes:[[{x:10,y:10},{x:30,y:20}]]};
  const corner=boundsOf(resizeFromHandle(doc,[0],'se',{x:50,y:22},true));assert.equal(corner.width/corner.height,2);
  const side=boundsOf(resizeFromHandle(doc,[0],'e',{x:50,y:99},true));assert.equal(side.width,40);assert.equal(side.height,10);
  const crossed=boundsOf(resizeFromHandle(doc,[0],'w',{x:100,y:10},false));assert.ok(crossed.width>0);assert.equal(crossed.x+crossed.width,30);
  const vertical={...doc,strokes:[[{x:10,y:10},{x:10,y:30}]]};const zero=boundsOf(resizeFromHandle(vertical,[0],'ne',{x:20,y:0},true));assert.equal(zero.width,0);assert.equal(zero.height,30);
  assert.equal(rotationFromPointer({x:0,y:0,width:20,height:20},{x:10,y:0},{x:20,y:10},false),90);
  const snapped=rotationFromPointer({x:0,y:0,width:20,height:20},{x:10,y:0},{x:18,y:2},true);assert.equal(snapped,45);
});
const drawing = {
  name: "test",
  width_mm: 160,
  height_mm: 240,
  strokes: [
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    [
      { x: 20, y: 20 },
      { x: 30, y: 30 },
    ],
  ],
};
test("crossing a selection rectangle selects whole stroke, including endpoints outside it", () => {
  assert.deepEqual(
    selectByRectangle(drawing, { x: 4, y: -1, width: 2, height: 2 }),
    [0],
  );
  assert.equal(drawing.strokes[0][0].x, 0);
});
test("moving all paths preserves requested page translation instead of renormalizing", () => {
  const next = movePaths(drawing, [0, 1], 7, -3);
  assert.deepEqual(boundsOf(next), { x: 7, y: -3, width: 30, height: 30 });
  assert.deepEqual(drawing.strokes[1][0], { x: 20, y: 20 });
});
test("moving leftmost selected path leaves unselected paths unchanged", () => {
  const next = movePaths(drawing, [0], 5, 6);
  assert.strictEqual(next.strokes[1], drawing.strokes[1]);
  assert.deepEqual(next.strokes[0][0], { x: 5, y: 6 });
});
test("resize and rotation keep all original points and order", () => {
  const next = rotatePaths(resizePaths(drawing, [1], 20, 10), [1], 90);
  const b = boundsOf(next, [1]);
  assert.ok(Math.abs(b.width - 10) < 1e-9);
  assert.ok(Math.abs(b.height - 20) < 1e-9);
  assert.equal(next.strokes[1].length, 2);
  assert.deepEqual(next.strokes[0], drawing.strokes[0]);
});
test("cut and paste preserve exact full strokes and provide new selection indices", () => {
  const clip = copyPaths(drawing, [1]);
  const cut = deletePaths(drawing, [1]);
  const pasted = pastePaths(cut, clip, { x: 0, y: 0 });
  assert.deepEqual(pasted.document, drawing);
  assert.deepEqual(pasted.selection, [1]);
  clip[0][0].x = 999;
  assert.equal(pasted.document.strokes[1][0].x, 20);
});
test("finite geometry validation rejects invalid transforms", () =>
  assert.throws(() => movePaths(drawing, [0], Infinity, 0), /有限/));

test("pasted composition paths get independent material identities and remain deletable", () => {
  const composed = { ...drawing, materials: [{ id: "original", name: "Original", kind: "file" }], strokeOwners: ["original", "original"] };
  const clip = copyPaths(composed, [1]);
  const first = pastePaths(composed, clip).document;
  const second = pastePaths(first, clip).document;
  const firstId = first.materials.at(-1).id, secondId = second.materials.at(-1).id;
  assert.notEqual(firstId, "original");assert.notEqual(firstId, secondId);
  assert.deepEqual(second.strokeOwners, ["original", "original", firstId, secondId]);
  assert.deepEqual(second.materials.map(m => m.id), ["original", firstId, secondId]);
  const removed = deletePaths(second, second.strokeOwners.flatMap((id, i) => id === firstId ? [i] : []));
  assert.deepEqual(removed.strokeOwners, ["original", "original", secondId]);
  assert.equal(removed.strokes.length, 3);
  assert.deepEqual(composed.strokeOwners, ["original", "original"], "Copy/paste must not mutate source ownership");
});
