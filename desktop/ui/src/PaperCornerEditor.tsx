import { useEffect, useId, useRef, useState } from "react";
import RegistrationHandles from "./RegistrationHandles";
import "./paperCornerEditor.css";

export function validPaperCorners(points: number[][]) {
  if (points.length !== 4 || points.some(p => p.length !== 2 || p.some(n => !Number.isFinite(n) || n < 0 || n > 1))) return false;
  const crosses = points.map((a, i) => {
    const b = points[(i + 1) % 4], c = points[(i + 2) % 4];
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  });
  const area = points.reduce((sum, p, i) => sum + p[0] * points[(i + 1) % 4][1] - p[1] * points[(i + 1) % 4][0], 0) / 2;
  return crosses.every(n => n > 0) && area > .01;
}

export function PaperCornerEditor({ source, corners, onChange, disabled = false, onMessage, onReady }: {
  source: string; corners: number[][]; onChange: (points: number[][]) => void;
  disabled?: boolean; onMessage?: (message: string) => void;
  onReady?: (ready: boolean) => void;
}) {
  const [size, setSize] = useState<[number, number] | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<{ index: number; point: number[] } | null>(null);
  const [scale, setScale] = useState(1);
  const host = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null);
  const readyCallback = useRef(onReady); readyCallback.current = onReady;
  const previewId = `paper-preview-${useId().replace(/:/g, "")}`;
  useEffect(() => {
    let canceled = false;
    readyCallback.current?.(false);
    setSize(null); setError(""); setDraft(null);
    const image = new Image();
    image.onload = () => {
      if (!canceled && image.naturalWidth > 0 && image.naturalHeight > 0) { setSize([image.naturalWidth, image.naturalHeight]); readyCallback.current?.(true); }
    };
    image.onerror = () => { if (!canceled) setError("图片预览加载失败，请重新选择照片"); };
    image.src = source;
    return () => { canceled = true; readyCallback.current?.(false); };
  }, [source]);
  useEffect(() => {
    const element = svg.current;
    if (!element || !size) return;
    const update = () => {
      const matrix = element.getScreenCTM();
      if (matrix) setScale(Math.hypot(matrix.a, matrix.b));
    };
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, [size]);
  const points = size ? corners.map(p => [p[0] * size[0], p[1] * size[1]]) : [];
  const shown = points.map((point, index) => draft?.index === index ? draft.point : point);
  return <div className="paper-corner-stage" ref={host}>
    {size ? <svg ref={svg} viewBox={`0 0 ${size[0]} ${size[1]}`} preserveAspectRatio="xMidYMid meet" aria-label="背景四角调整">
      <g id={previewId}><image href={source} width={size[0]} height={size[1]} /></g>
      <path className="paper-corner-mask" fillRule="evenodd" d={`M0 0H${size[0]}V${size[1]}H0Z M${shown.map(p => `${p[0]},${p[1]}`).join("L")}Z`} />
      <polygon className="paper-corner-outline" points={shown.map(p => p.join(",")).join(" ")} />
      <RegistrationHandles mode="paper" points={points} width={size[0]} height={size[1]} pixelsPerMm={scale} disabled={disabled}
        previewHost={host.current} previewContentId={previewId} onDraft={setDraft} onMessage={onMessage || (() => {})}
        onCommit={(index, point) => onChange(corners.map((saved, i) => i === index ? [point[0] / size[0], point[1] / size[1]] : [...saved]))} />
    </svg> : <p className="field-note" role="status">{error || "正在载入原图…"}</p>}
  </div>;
}
