import type { Bounds } from "./editorGeometry";
import { identityRegistration, mapMachineCoordinates, registrationMatrix } from "./coordinateGeometry.ts";
// User-selected A4 planning range; not a measured physical travel limit.
export const AXIS_LIMITS_MM = [210, 297] as const;

// Mirror the fixed-origin and current-tip travel guards used by Rust.
// This is an application planning envelope, not a measured physical limit.
export function writableArea(
  width: number,
  height: number,
  margin: number,
  origin: number[],
  currentWork?: number[] | null,
  registration = identityRegistration,
): Bounds | null {
  if (origin.length < 2 || ![width, height, margin, ...origin].every(Number.isFinite)) return null;
  const angle = registration.rotation_deg * Math.PI / 180;
  const divisor = registration.scale * (Math.abs(Math.cos(angle)) + Math.abs(Math.sin(angle)));
  const rotated = Math.abs(registration.rotation_deg) > 1e-9;
  // A conservative inscribed rectangle makes one-click fit valid after rotation.
  let limits = rotated ? [Math.min(...AXIS_LIMITS_MM) / divisor, Math.min(...AXIS_LIMITS_MM) / divisor] : AXIS_LIMITS_MM.map(v => v / registration.scale);
  if (registration.matrix) {
    const [a, b, c, d] = registrationMatrix(registration);
    if (![a, b, c, d].every(Number.isFinite) || Math.abs(a * d - b * c) < 1e-12) return null;
    if (Math.abs(b) < 1e-12 && Math.abs(c) < 1e-12) limits = [AXIS_LIMITS_MM[0] / Math.abs(a), AXIS_LIMITS_MM[1] / Math.abs(d)];
    else {
      const fit = Math.max((Math.abs(a) * AXIS_LIMITS_MM[0] + Math.abs(b) * AXIS_LIMITS_MM[1]) / AXIS_LIMITS_MM[0], (Math.abs(c) * AXIS_LIMITS_MM[0] + Math.abs(d) * AXIS_LIMITS_MM[1]) / AXIS_LIMITS_MM[1]);
      limits = AXIS_LIMITS_MM.map(limit => limit / fit);
    }
  }
  let left = Math.max(margin, origin[0] - limits[0]);
  let top = Math.max(margin, origin[1] - limits[1]);
  let right = Math.min(width - margin, origin[0] + limits[0]);
  let bottom = Math.min(height - margin, origin[1] + limits[1]);
  if (currentWork) {
    if (currentWork.length < 2 || !currentWork.every(Number.isFinite)) return null;
    const mapped = mapMachineCoordinates(origin, [currentWork[0], currentWork[1], 0], registration)?.pen;
    if (!mapped) return null;
    left = Math.max(left, mapped.x - limits[0]);
    right = Math.min(right, mapped.x + limits[0]);
    top = Math.max(top, mapped.y - limits[1]);
    bottom = Math.min(bottom, mapped.y + limits[1]);
  }
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function boundsWithinArea(bounds: Bounds, area: Bounds | null): boolean {
  return !!area && Object.values(bounds).every(Number.isFinite) &&
    bounds.width >= 0 && bounds.height >= 0 &&
    bounds.x >= area.x && bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width &&
    bounds.y + bounds.height <= area.y + area.height;
}
