import test from 'node:test';
import assert from 'node:assert/strict';
import { screenToCanvas, pointerCoordinates, rotatedViewSize } from './pointerGeometry.ts';

test('rotated view fits all corners and pointer inverse preserves paper coordinates', () => {
  const width=210,height=297,scale=2.5;
  for(const degrees of [0,90,-90,180,37,-150]) {
    const size=rotatedViewSize(width,height,degrees),angle=degrees*Math.PI/180;
    const a=scale*Math.cos(angle),b=scale*Math.sin(angle),c=-b,d=a;
    const matrix={a,b,c,d,e:100+scale*size.width/2-a*width/2-c*height/2,f:70+scale*size.height/2-b*width/2-d*height/2};
    for(const point of [{x:0,y:0},{x:width,y:0},{x:0,y:height},{x:width,y:height},{x:45,y:180}]) {
      const screen={x:a*point.x+c*point.y+matrix.e,y:b*point.x+d*point.y+matrix.f};
      assert.ok(screen.x>=100-1e-8&&screen.x<=100+scale*size.width+1e-8);
      assert.ok(screen.y>=70-1e-8&&screen.y<=70+scale*size.height+1e-8);
      const restored=screenToCanvas(screen,matrix);
      assert.ok(Math.abs(restored.x-point.x)<1e-8&&Math.abs(restored.y-point.y)<1e-8);
    }
  }
});
test('pointer follows zoom and scroll translation with independent scale', () => {
  assert.deepEqual(screenToCanvas({ x: 145, y: 164 }, { a: 3, b: 0, c: 0, d: 4, e: -5, f: 84 }), { x: 50, y: 20 });
  assert.deepEqual(screenToCanvas({ x: 120, y: 110 }, { a: 2, b: 0, c: 0, d: 2, e: 20, f: 70 }), { x: 50, y: 20 });
});
test('hover converts confirmed origin with exactly one Y inversion', () => {
  assert.deepEqual(pointerCoordinates({ x: 50, y: 20 }, [10, 35]), { canvas: { x: 50, y: 20 }, work: { x: 40, y: 15 }, confirmed: true });
});
test('unpositioned coordinates explicitly remain preview', () => {
  for (const origin of [null, [], [NaN, 2]]) {
    const value = pointerCoordinates({ x: 5, y: 10 }, origin);
    assert.equal(value.confirmed, false);
    assert.deepEqual(value.work, { x: 5, y: -10 });
  }
});
test('singular transforms do not create pointer coordinates', () => {
  assert.equal(screenToCanvas({ x: 1, y: 2 }, { a: 0, b: 0, c: 0, d: 1, e: 0, f: 0 }), null);
});
