import test from 'node:test';
import assert from 'node:assert/strict';
import {machineScene} from './machineScene.ts';
import {canvasToMachine,registrationMatrix} from './coordinateGeometry.ts';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('fixed machine scene supplies different calibration routes for portrait and landscape',()=>{
  for(const [angle,dx,dy] of [[0,0,120],[90,-120,0],[-90,120,0],[180,0,-120],[37,-120*Math.sin(37*Math.PI/180),120*Math.cos(37*Math.PI/180)]]){
    const scene=machineScene(160,240,angle);
    const first=scene.request({type:'begin_registration',canvas_x:20,canvas_y:20});
    const second=scene.request({type:'move_to',canvas_x:20,canvas_y:140});
    near(second.canvas_x-first.canvas_x,dx);near(second.canvas_y-first.canvas_y,dy);
    assert.equal('paper_angle' in first,false);
    const paper=scene.inverse({x:second.canvas_x,y:second.canvas_y});near(paper.x,20);near(paper.y,140);
    const run=scene.request({type:'run',job:{document:{strokes:[[{x:20,y:20},{x:20,y:140}]]}}});
    assert.deepEqual(run.job.document,scene.document({strokes:[[{x:20,y:20},{x:20,y:140}]]}));
    near(run.job.document.strokes[0][1].x,second.canvas_x);
    near(run.job.document.strokes[0][1].y,second.canvas_y);
  }
});
test('alignment maps only between software and real machine, without a second rotation',()=>{
  for(const angle of [0,90,-90,180,37]){
    const scene=machineScene(160,240,angle),real={scale:1.1,rotation_deg:7,matrix:[1.1,.02,-.03,.9]};
    const paper=scene.toPaperMapping(real), restored=scene.toMachineMapping(paper);
    registrationMatrix(restored).forEach((v,i)=>near(v,registrationMatrix(real)[i]));
    const p={x:65,y:180},anchor={x:20,y:20},a=scene.point(anchor);
    const expected=canvasToMachine(scene.point(p),[a.x,a.y],real);
    const actual=canvasToMachine(p,[anchor.x,anchor.y],paper);
    near(actual.x,expected.x);near(actual.y,expected.y);
  }
});
test('saved unequal paper scales remain aligned to the paper after scene placement',()=>{
  const scene=machineScene(160,240,90),request=scene.request({type:'begin_registration',canvas_x:20,canvas_y:20,preserve_scale:[.8,1.2]});
  request.mapping.forEach((v,i)=>near(v,[1.2,0,0,.8][i]));
  const paper=scene.toPaperMapping({scale:1,rotation_deg:0,matrix:request.mapping});
  const [a,b,c,d]=registrationMatrix(paper);near(Math.hypot(a,c),.8);near(Math.hypot(b,d),1.2);
});
