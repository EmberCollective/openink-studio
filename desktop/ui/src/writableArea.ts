import type { Bounds } from "./editorGeometry";

// Optional fit-to-page geometry, never a machine travel limit.
export function writableArea(width: number, height: number, margin: number): Bounds | null {
  if (![width, height, margin].every(Number.isFinite) || margin < 0 || width <= 2 * margin || height <= 2 * margin) return null;
  return { x: margin, y: margin, width: width - 2 * margin, height: height - 2 * margin };
}

export function boundsWithinArea(bounds: Bounds, area: Bounds | null): boolean {
  return !!area && Object.values(bounds).every(Number.isFinite) &&
    bounds.width >= 0 && bounds.height >= 0 &&
    bounds.x >= area.x && bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width &&
    bounds.y + bounds.height <= area.y + area.height;
}
