import assert from "node:assert/strict";
import fs from "node:fs";
import { createCalibrationMarks } from "../ui/src/calibrationMarks";

export function calibrationChecks() {
  const marks = createCalibrationMarks(210, 297);
  assert.equal(marks.width_mm, 210);
  assert.equal(marks.height_mm, 297);
  const centers = [[15, 15], [195, 15], [195, 282], [15, 282]];
  const expected = centers.flatMap(([x, y]) => [
    [{ x: x - 1, y }, { x: x + 1, y }],
    [{ x, y: y - 1 }, { x, y: y + 1 }],
  ]);
  assert.deepEqual(marks.strokes, expected, "A4 marks retain fixed paper coordinates, including their 15 mm inset");
  assert.deepEqual(createCalibrationMarks(297, 210).strokes[6], [{ x: 14, y: 195 }, { x: 16, y: 195 }]);
  for (const dimension of [NaN, Infinity, -Infinity, 0, 31.99]) {
    assert.throws(() => createCalibrationMarks(dimension, 297));
    assert.throws(() => createCalibrationMarks(210, dimension));
  }
  assert.equal(createCalibrationMarks(32, 32).strokes.length, 8);
  const svg = fs.readFileSync("docs/calibration/a4-four-corners.svg", "utf8");
  assert.match(svg, /width="210mm" height="297mm" viewBox="0 0 210 297"/);
  assert.doesNotMatch(svg, /<text\b/);
  const lines = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)]
    .map(match => [{ x: Number(match[1]), y: Number(match[2]) }, { x: Number(match[3]), y: Number(match[4]) }]);
  assert.deepEqual(lines, marks.strokes, "Printable SVG and machine marks share exact coordinates");
  console.log("PASS: fixed four-corner paper coordinates, 2 mm crosses, dimension validation and SVG parity.");
}
