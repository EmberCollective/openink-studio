import { memo } from "react";
import type { RoutePoint, RouteSnapshot } from "./useRoutePlan";
export type RouteInspection = { index: number; kind: string; from: RoutePoint; to: RoutePoint; distance: number };
export function inspectRouteStroke(snapshot: RouteSnapshot, index: number): RouteInspection | null {
  const stroke = snapshot.document.strokes.filter((s) => s.length > 1)[index - 1];
  if (!stroke) return null;
  return { index, kind: "落笔描线", from: stroke[0], to: stroke[stroke.length - 1], distance: stroke.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - stroke[i].x, p.y - stroke[i].y), 0) };
}
export function strokeDirection(stroke: RoutePoint[]) {
  const lengths = stroke.slice(1).map((p, i) => Math.hypot(p.x - stroke[i].x, p.y - stroke[i].y));
  let remaining = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] > 0 && remaining <= lengths[i]) {
      const a = stroke[i], b = stroke[i + 1], ratio = remaining / lengths[i];
      return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio, angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI };
    }
    remaining -= lengths[i];
  }
  return null;
}
export const RouteOverlay = memo(function RouteOverlay({ snapshot, selectedIndex }: { snapshot: RouteSnapshot; selectedIndex?: number }) {
  const strokes = snapshot.document.strokes.filter((s) => s.length > 1);
  const selected = selectedIndex ? strokes[selectedIndex - 1] : null;
  const direction = selected ? strokeDirection(selected) : null;
  if (!selected) return null;
  return <g aria-label="单笔定位" pointerEvents="none">
    <defs><marker id="route-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L6 3 L0 6" fill="none" stroke="#51446d" /></marker></defs>
    {selected && <g aria-label={`已选第${selectedIndex}笔`} pointerEvents="none">
      <polyline points={selected.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
      <polyline points={selected.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#e4408c" strokeWidth=".8" strokeLinejoin="round" markerEnd="url(#route-arrow)" />
      <text x={selected[0].x + 1} y={selected[0].y - 1} fontSize="3" fontWeight="700" fill="#ba155d" stroke="white" strokeWidth=".65" paintOrder="stroke">{selectedIndex}</text>
      {direction && <path aria-label="选中笔画中段书写方向" d="M-1.8 -1.1 L0 0 L-1.8 1.1" transform={`translate(${direction.x} ${direction.y}) rotate(${direction.angle})`} fill="none" stroke="#a40749" strokeWidth=".65" strokeLinecap="round" strokeLinejoin="round" />}
    </g>}
  </g>;
});
