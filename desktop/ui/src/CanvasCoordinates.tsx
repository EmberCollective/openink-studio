import type { Point } from "./editorGeometry";
import { mapMachineCoordinates, outsideDirection, type Registration } from "./coordinateGeometry";
export function CanvasCoordinates({
  registration,
  first,
  origin,
  position,
  width,
  height,
  pixelsPerMm,
  startLabel = "路径起点",
  draftPen,
}: {
  registration?: Registration;
  first: Point | null;
  origin: number[] | null;
  position: number[] | null;
  width: number;
  height: number;
  pixelsPerMm: number;
  startLabel?: string;
  draftPen?: number[] | null;
}) {
  const mapped = origin ? mapMachineCoordinates(origin, position, registration) : null;
  const unit = 1 / Math.max(0.2, pixelsPerMm),
    r = 4 * unit,
    font = 10 * unit;
  function marker(
    kind: string,
    p: Point,
    color: string,
    label: string,
    offset: number,
  ) {
    const dx = p.x > width * 0.7 ? -5 * unit : 6 * unit,
      dy = p.y < 8 * unit ? (offset + 12) * unit : offset * unit;
    const coincide =
      kind === "pen" &&
      !!first &&
      Math.hypot(p.x - first.x, p.y - first.y) < 0.001;
    return (
      <g key={kind} data-coordinate={kind} data-x={p.x} data-y={p.y}>
        <circle
          cx={p.x}
          cy={p.y}
          r={coincide ? r * 1.6 : r}
          fill={coincide || kind.endsWith("-draft") ? "none" : color}
          stroke={coincide || kind.endsWith("-draft") ? color : "white"}
          strokeWidth={unit}
        />
        <text
          x={p.x + dx}
          y={p.y + dy}
          textAnchor={dx < 0 ? "end" : "start"}
          fontSize={font}
          fill={color}
          stroke="white"
          strokeWidth={2.3 * unit}
          paintOrder="stroke"
          strokeLinejoin="round"
        >
          {label}
        </text>
      </g>
    );
  }
  const mappedOrigin = mapped?.origin,
    outside = mappedOrigin ? outsideDirection(mappedOrigin, width, height) : "";
  return (
    <g className="coordinate-overlay" pointerEvents="none">
      <text
        x={8 * unit}
        y={9 * unit}
        fontSize={font}
        fill="#78838f"
        stroke="white"
        strokeWidth={2 * unit}
        paintOrder="stroke"
      >
        画布 (0,0)
      </text>
      {first && marker("start", first, "#cf8e4a", startLabel, -8)}
      {!mapped?.pen && draftPen && marker("pen-draft", { x: draftPen[0], y: draftPen[1] }, "#6494b2", "默认笔尖（末点）", 15)}
      {mappedOrigin && !outside && (
        <g
          data-coordinate="origin"
          data-x={mappedOrigin.x}
          data-y={mappedOrigin.y}
        >
          <path
            d={`M${mappedOrigin.x - 5 * unit},${mappedOrigin.y}h${10 * unit}M${mappedOrigin.x},${mappedOrigin.y - 5 * unit}v${10 * unit}`}
            stroke="#9e7db9"
            strokeWidth={1.4 * unit}
          />
          <circle
            cx={mappedOrigin.x}
            cy={mappedOrigin.y}
            r={6 * unit}
            fill="none"
            stroke="#9e7db9"
            strokeWidth={unit}
          />
          <text
            x={Math.min(
              width - 2 * unit,
              Math.max(2 * unit, mappedOrigin.x + 8 * unit),
            )}
            y={
              mappedOrigin.y < 12 * unit
                ? mappedOrigin.y + 28 * unit
                : mappedOrigin.y - 12 * unit
            }
            fontSize={font}
            textAnchor={mappedOrigin.x > width * 0.65 ? "end" : "start"}
            fill="#9e7db9"
            stroke="white"
            strokeWidth={2.3 * unit}
            paintOrder="stroke"
          >
            工作原点 (0,0)
          </text>
        </g>
      )}
      {mappedOrigin && outside && (
        <g
          data-coordinate="origin"
          data-outside="true"
          data-x={mappedOrigin.x}
          data-y={mappedOrigin.y}
          transform={`translate(${Math.max(4 * unit, Math.min(width - 4 * unit, mappedOrigin.x))},${Math.max(4 * unit, Math.min(height - 4 * unit, mappedOrigin.y))})`}
        >
          <path
            d={`M${-3 * unit},${-3 * unit}L${4 * unit},0L${-3 * unit},${3 * unit}`}
            fill="none"
            stroke="#9e7db9"
            strokeWidth={1.5 * unit}
            transform={`rotate(${(Math.atan2(mappedOrigin.y - height / 2, mappedOrigin.x - width / 2) * 180) / Math.PI})`}
          />
        </g>
      )}
      {mapped?.pen && marker("pen", mapped.pen, "#6494b2", "当前笔尖", 15)}
    </g>
  );
}
