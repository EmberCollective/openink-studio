import type { Registration } from "./coordinateGeometry";
import { useState, type ReactNode, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { pointerCoordinates, screenToCanvas, type CanvasPointerPoint } from "./pointerGeometry";
import "./CanvasPointerOverlay.css";

const fmt = (n: number) => (Math.abs(n) < .005 ? 0 : n).toFixed(2);
/** Capture observes every editor tool without swallowing selection or dragging events. */
export function CanvasPointerOverlay({ width, height, paperWidth, paperHeight, origin, registration, host, children, onPlaceOrigin }: {
  width: number; height: number; paperWidth: number; paperHeight: number;
  registration?: Registration; origin: number[] | null; host: HTMLElement | null; children: ReactNode;
  onPlaceOrigin?: (point: CanvasPointerPoint) => void;
}) {
  const [pointer, setPointer] = useState<(CanvasPointerPoint & { left: number; top: number }) | null>(null);
  function move(event: PointerEvent<HTMLDivElement>) {
    const svg = event.currentTarget.querySelector<SVGSVGElement>(".paper > svg");
    const matrix = svg?.getScreenCTM?.();
    const p = matrix ? screenToCanvas({ x: event.clientX, y: event.clientY }, matrix) : null;
    const bounds = event.currentTarget.getBoundingClientRect();
    setPointer(p && p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height
      ? { ...p, left: event.clientX - bounds.left, top: event.clientY - bounds.top } : null);
  }
  const coords = pointer ? pointerCoordinates(pointer, origin, registration) : null;
  const readout = <div className="canvas-pointer-readout" aria-label="鼠标坐标">
    <span>画布 X {pointer ? fmt(pointer.x) : "—"} · Y {pointer ? fmt(pointer.y) : "—"} mm</span>
    <span>{coords?.confirmed || (origin?.length === 2 && origin.every(Number.isFinite)) ? "机器 G54" : "机器预览（未定位）"} X {coords ? fmt(coords.work.x) : "—"} · Y {coords ? fmt(coords.work.y) : "—"} mm</span>
  </div>;
  return <div className="canvas-pointer-wrapper" style={{ width: paperWidth, height: paperHeight, cursor: onPlaceOrigin ? "crosshair" : undefined }} onPointerMoveCapture={move} onPointerLeave={() => setPointer(null)}
    onPointerDownCapture={event => {
      if (!onPlaceOrigin || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const matrix = event.currentTarget.querySelector<SVGSVGElement>(".paper > svg")?.getScreenCTM?.();
      const point = matrix ? screenToCanvas({ x: event.clientX, y: event.clientY }, matrix) : null;
      if (point && point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height) onPlaceOrigin(point);
    }}>
    {children}
    {pointer && <div className="canvas-pointer-overlay" aria-hidden="true">
      <div className="canvas-crosshair-x" style={{ top: pointer.top }} />
      <div className="canvas-crosshair-y" style={{ left: pointer.left }} />
    </div>}
    {host && createPortal(readout, host)}
  </div>;
}
