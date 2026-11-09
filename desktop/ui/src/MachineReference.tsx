import { useId } from "react";
import { referenceViewSize } from "./pointerGeometry";

/** Fixed software machine axes; the outline does not represent physical travel. */
export function MachineReference({ angle, ghost, paperWidth, paperHeight }: { angle: number; ghost: boolean; paperWidth: number; paperHeight: number }) {
  const id = useId(), rotation = 0;
  const size = referenceViewSize(paperWidth, paperHeight, angle);
  const width = paperWidth + 24, height = paperHeight + 24;
  const transform = `translate(${size.width / 2} ${size.height / 2}) rotate(${rotation}) translate(${-paperWidth / 2} ${-paperHeight / 2})`;
  return <>
    {ghost && <svg className="machine-reference" viewBox={`0 0 ${size.width} ${size.height}`} width="100%" height="100%" aria-hidden="true"><g transform={transform}><rect data-reference="ghost" x="-12" y="-12" width={width} height={height} fill="#e8e9ef" fillOpacity=".45" stroke="#ccd0dc" strokeWidth="1" /></g></svg>}
    <svg className="machine-reference" style={{ zIndex: 1 }} viewBox={`0 0 ${size.width} ${size.height}`} width="100%" height="100%" aria-label="机器方向参考（不表示实际尺寸、位置或可书写范围）">
    <defs>
      <marker id={`${id}-x`} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 0L5 2.5L0 5" fill="#b45756" /></marker>
      <marker id={`${id}-y`} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 0L5 2.5L0 5" fill="#518379" /></marker>
    </defs>
    <g data-reference="direction" transform={transform}>
      <path d="M0 0H38" stroke="#b45756" strokeWidth="1.2" markerEnd={`url(#${id}-x)`} />
      <path d="M0 0V38" stroke="#518379" strokeWidth="1.2" markerEnd={`url(#${id}-y)`} />
      <circle r="2" fill="white" stroke="#8b7d9b" strokeWidth=".8" />
      <text transform={`translate(12 -15) rotate(${-rotation})`} fontSize="10" fill="#8a90a1">机器方向参考</text>
      <text transform={`translate(48 0) rotate(${-rotation})`} fontSize="10" fill="#a34848" dominantBaseline="middle">X</text>
      <text transform={`translate(0 50) rotate(${-rotation})`} fontSize="10" fill="#39766a" textAnchor="middle">+Y</text>
    </g>
  </svg></>;
}
