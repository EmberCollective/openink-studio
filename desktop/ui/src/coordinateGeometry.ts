import type { Point } from "./editorGeometry";
export type Registration = { scale: number; rotation_deg: number; matrix?: [number, number, number, number] };
export const identityRegistration: Registration = { scale: 1, rotation_deg: 0 };
export function registrationMatrix(registration: Registration): [number, number, number, number] {
  if (registration.matrix) return registration.matrix;
  const angle = registration.rotation_deg * Math.PI / 180, c = Math.cos(angle) * registration.scale, s = Math.sin(angle) * registration.scale;
  return [c, -s, s, c];
}
export function registrationScales(registration: Registration): [number, number] {
  const [a, b, c, d] = registrationMatrix(registration);
  return [Math.hypot(a, c), Math.hypot(b, d)];
}
export function scaledRegistration(sx: number, sy: number, rotation_deg = 0): Registration {
  const angle = rotation_deg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return { scale: (sx + sy) / 2, rotation_deg, matrix: [sx * c, -sy * s || 0, sx * s || 0, sy * c] };
}
export function validRegistrationPoints(points: number[][], width: number, height: number): boolean {
  if (points.length < 2 || points.length > 3 || points.some(p => p.length !== 2 || !p.every(Number.isFinite) || p[0] < 0 || p[0] > width || p[1] < 0 || p[1] > height)) return false;
  const [a, b, c] = points;
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 100) return false;
  if (!c) return true;
  const first = Math.hypot(b[0] - a[0], b[1] - a[1]), second = Math.hypot(c[0] - a[0], c[1] - a[1]);
  return second >= 100 && Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / (first * second) >= .15;
}
export function canvasToMachine(point: Point, origin: number[], registration = identityRegistration): Point {
  const [a, b, c, d] = registrationMatrix(registration);
  const x = point.x - origin[0], y = origin[1] - point.y;
  return { x: a * x + b * y, y: c * x + d * y };
}
export function mapMachineCoordinates(
  originCoordinates: number[],
  position: number[] | null,
  registration = identityRegistration,
) {
  if (
    originCoordinates.length !== 2 ||
    originCoordinates.some((v) => !Number.isFinite(v))
  )
    return null;
  const origin = { x: originCoordinates[0], y: originCoordinates[1] };
  const [a, b, c, d] = registrationMatrix(registration), determinant = a * d - b * c;
  const pen =
    position?.length === 3 && position.every(Number.isFinite) && [a, b, c, d, determinant].every(Number.isFinite) && Math.abs(determinant) > 1e-12
      ? {
          x: origin.x + (d * position[0] - b * position[1]) / determinant,
          y: origin.y - (-c * position[0] + a * position[1]) / determinant,
        }
      : null;
  return { origin, pen };
}
export function outsideDirection(p: Point, width: number, height: number) {
  const horizontal = p.x < 0 ? "左侧" : p.x > width ? "右侧" : "",
    vertical = p.y < 0 ? "上方" : p.y > height ? "下方" : "";
  return [horizontal, vertical].filter(Boolean).join(" / ");
}
