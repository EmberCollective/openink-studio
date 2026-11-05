import { canvasToMachine, identityRegistration } from "./coordinateGeometry.ts";
export type CanvasPointerPoint = { x: number; y: number };
export function rotatedViewSize(width: number, height: number, degrees: number) {
  const angle = degrees * Math.PI / 180, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  return { width: width * c + height * s, height: width * s + height * c };
}
/** Affine inverse screen transform includes scroll, translation and independent X/Y zoom. */
export function screenToCanvas(client: CanvasPointerPoint, matrix: { a: number; b: number; c: number; d: number; e: number; f: number }): CanvasPointerPoint | null {
  const { a, b, c, d, e, f } = matrix;
  const det = a * d - b * c;
  if (![a, b, c, d, e, f, client.x, client.y].every(Number.isFinite) || Math.abs(det) < 1e-12) return null;
  const x = client.x - e, y = client.y - f;
  return { x: (d * x - c * y) / det, y: (-b * x + a * y) / det };
}
export function pointerCoordinates(canvas: CanvasPointerPoint, origin: number[] | null, registration = identityRegistration) {
  const confirmed = !!origin && origin.length === 2 && origin.every(Number.isFinite);
  const [ox, oy] = confirmed ? origin! : [0, 0];
  return { canvas, work: canvasToMachine(canvas, [ox, oy], registration), confirmed };
}
