import type { Drawing } from "./editorGeometry";

export function createCalibrationMarks(widthMm: number, heightMm: number): Drawing {
  if (![widthMm, heightMm].every(value => Number.isFinite(value) && value >= 32)) {
    throw new Error("四角校准标记需要宽、高均不小于 32 mm 的纸张。");
  }
  // A 15 mm inset keeps the marks away from normal printer unprintable margins.
  const centers = [[15, 15], [widthMm - 15, 15], [widthMm - 15, heightMm - 15], [15, heightMm - 15]];
  return {
    name: "四角校准标记",
    width_mm: widthMm,
    height_mm: heightMm,
    strokes: centers.flatMap(([x, y]) => [
      [{ x: x - 1, y }, { x: x + 1, y }],
      [{ x, y: y - 1 }, { x, y: y + 1 }],
    ]),
  };
}
