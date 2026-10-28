import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { validRegistrationPoints } from "./coordinateGeometry";

type Props = {
  points: number[][];
  width: number;
  height: number;
  pixelsPerMm: number;
  disabled: boolean;
  onCommit(index: number, point: number[]): void;
  onMessage(message: string): void;
  previewHost?: HTMLElement | null;
  mode?: "registration" | "paper";
  previewContentId?: string;
  onDraft?(draft: { index: number; point: number[] } | null): void;
};
type Drag = { id: number; index: number; owner: SVGGElement; offset: number[]; point: number[] };

export default function RegistrationHandles({ points, width, height, pixelsPerMm, disabled, onCommit, onMessage, previewHost, mode = "registration", previewContentId = "registration-preview-content", onDraft }: Props) {
  const drag = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<{ index: number; point: number[] } | null>(null);
  const pointsKey = JSON.stringify(points);
  const unit = 1 / Math.max(mode === "paper" ? .001 : .2, pixelsPerMm);
  const draftCallback = useRef(onDraft); draftCallback.current = onDraft;
  function updateDraft(value: { index: number; point: number[] } | null) {
    setDraft(value); draftCallback.current?.(value);
  }
  function cancel() {
    const previous = drag.current;
    drag.current = null;
    updateDraft(null);
    if (previous?.owner.hasPointerCapture(previous.id)) previous.owner.releasePointerCapture(previous.id);
  }
  useEffect(() => { cancel(); }, [disabled, pointsKey, width, height]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", cancel);
    return () => { window.removeEventListener("keydown", escape); window.removeEventListener("blur", cancel); cancel(); };
  }, []);
  function position(event: PointerEvent<SVGGElement>) {
    const svg = event.currentTarget.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    try {
      const point = svg.createSVGPoint();
      point.x = event.clientX; point.y = event.clientY;
      const mapped = point.matrixTransform(matrix.inverse());
      return Number.isFinite(mapped.x) && Number.isFinite(mapped.y) ? [mapped.x, mapped.y] : null;
    } catch { return null; }
  }
  function clamp(point: number[]) {
    return [Math.max(0, Math.min(width, point[0])), Math.max(0, Math.min(height, point[1]))];
  }
  function distance(index: number, point: number[]) {
    const other = points[index === 0 ? 1 : 0];
    return other ? Math.hypot(point[0] - other[0], point[1] - other[1]) : NaN;
  }
  function commit(index: number, point: number[]) {
    if (disabled) return;
    if (mode !== "paper" && points.length === 3 && !validRegistrationPoints(points.map((saved, i) => i === index ? point : saved), width, height)) { onMessage("第 2、3 点须距第 1 点至少 100 mm，夹角不能接近共线。"); return; }
    if (mode !== "paper" && points.length !== 3 && !(distance(index, point) >= 100)) { onMessage("两个校准点至少相距 100 mm，本次移动已取消。"); return; }
    if (point[0] !== points[index][0] || point[1] !== points[index][1]) onCommit(index, point);
  }
  return <g data-registration-handles="true">
    {points.slice(0, mode === "paper" ? 4 : 3).map((saved, index) => {
      const point = draft?.index === index ? draft.point : saved;
      return <g key={index} className="registration-handle" data-registration-handle={index} data-x={point[0]} data-y={point[1]}
        role="button" aria-label={mode === "paper" ? `${["左上", "右上", "右下", "左下"][index]}纸张角` : `页面校准点 ${index + 1}`} aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
        style={{ cursor: disabled ? "default" : "grab", touchAction: "none" }}
        onPointerDown={event => {
          event.stopPropagation();
          if (disabled || event.defaultPrevented || event.button !== 0 || drag.current) return;
          const mapped = position(event); if (!mapped) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, index, owner: event.currentTarget, offset: [saved[0] - mapped[0], saved[1] - mapped[1]], point: saved };
          updateDraft({ index, point: saved });
        }}
        onPointerMove={event => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          event.stopPropagation();
          const mapped = position(event); if (!mapped) return;
          current.point = clamp([mapped[0] + current.offset[0], mapped[1] + current.offset[1]]);
          updateDraft({ index, point: current.point });
        }}
        onPointerUp={event => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          event.stopPropagation(); cancel(); commit(index, current.point);
        }}
        onPointerCancel={event => { if (drag.current?.id === event.pointerId) cancel(); }}
        onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) cancel(); }}
        onKeyDown={event => {
          const directions: Record<string, number[]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
          const direction = directions[event.key];
          if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
          event.preventDefault(); event.stopPropagation();
          if (disabled || drag.current) return;
          const step = event.shiftKey ? 5 : 1;
          commit(index, clamp([saved[0] + direction[0] * step, saved[1] + direction[1] * step]));
        }}>
        <circle cx={point[0]} cy={point[1]} r={12 * unit} fill="transparent" />
        <circle className="registration-target" cx={point[0]} cy={point[1]} r={7 * unit} fill="none" stroke="#a36d22" strokeWidth={unit} pointerEvents="none" />
        <path d={`M ${point[0] - 11 * unit} ${point[1]} h ${9 * unit} M ${point[0] + 2 * unit} ${point[1]} h ${9 * unit} M ${point[0]} ${point[1] - 11 * unit} v ${9 * unit} M ${point[0]} ${point[1] + 2 * unit} v ${9 * unit}`} fill="none" stroke="#a36d22" strokeWidth={unit} pointerEvents="none" />
        <text x={point[0] + (point[0] > width / 2 ? -14 : 14) * unit} y={point[1] + 17 * unit} textAnchor="middle" fontSize={10 * unit} fill="#825217" pointerEvents="none">{index + 1}</text>
        {draft?.index === index && <text x={Math.max(2 * unit, Math.min(width - 2 * unit, point[0]))} y={point[1] < 22 * unit ? point[1] + 24 * unit : point[1] - 16 * unit} textAnchor={point[0] > width / 2 ? "end" : "start"} fontSize={11 * unit} fill="#825217" stroke="white" strokeWidth={3 * unit} paintOrder="stroke" pointerEvents="none">{point[0].toFixed(1)}, {point[1].toFixed(1)} {mode === "paper" ? "px" : `mm · 间距 ${distance(index, point).toFixed(1)} mm`}</text>}
      </g>;
    })}
    {draft && previewHost && createPortal(<div className="registration-loupe" style={draft.point[0] > width / 2 ? { left: 16, right: "auto" } : undefined} aria-label="定位点局部放大图">
      <div className="registration-loupe-heading"><strong>{mode === "paper" ? "纸张角" : "定位点"} {draft.index + 1}</strong><span>4× 放大</span></div>
      <svg viewBox={`${draft.point[0] - 25 * unit} ${draft.point[1] - 25 * unit} ${50 * unit} ${50 * unit}`} width="200" height="200" aria-label="底稿与笔画局部预览">
        <rect x={0} y={0} width={width} height={height} fill="white" />
        <use href={`#${previewContentId}`} />
        <path d={`M ${draft.point[0] - 7 * unit} ${draft.point[1]} h ${6 * unit} M ${draft.point[0] + unit} ${draft.point[1]} h ${6 * unit} M ${draft.point[0]} ${draft.point[1] - 7 * unit} v ${6 * unit} M ${draft.point[0]} ${draft.point[1] + unit} v ${6 * unit}`} fill="none" stroke="#a36d22" strokeWidth={0.25 * unit} />
      </svg>
      <div className="registration-loupe-caption">X {draft.point[0].toFixed(2)} · Y {draft.point[1].toFixed(2)} {mode === "paper" ? "px" : "mm"}</div>
    </div>, previewHost)}
  </g>;
}
