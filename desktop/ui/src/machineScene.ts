import type { Point } from "./editorGeometry";
import { registrationMatrix, type Registration } from "./coordinateGeometry.ts";

// Paper geometry is editor data. Every device payload uses the fixed background scene.
export function machineScene(width: number, height: number, degrees: number) {
  const angle = degrees * Math.PI / 180;
  const c = Math.abs(Math.cos(angle)) < 1e-12 ? 0 : Math.cos(angle), s = Math.abs(Math.sin(angle)) < 1e-12 ? 0 : Math.sin(angle);
  const point = (p: Point): Point => ({ x: width / 2 + c * (p.x - width / 2) - s * (p.y - height / 2), y: height / 2 + s * (p.x - width / 2) + c * (p.y - height / 2) });
  const inverse = (p: Point): Point => ({ x: width / 2 + c * (p.x - width / 2) + s * (p.y - height / 2), y: height / 2 - s * (p.x - width / 2) + c * (p.y - height / 2) });
  const mapping = (value: Registration, inverse: boolean): Registration => {
    if (degrees === 0) return value;
    const [a,b,d,e] = registrationMatrix(value), t = inverse ? -s : s;
    const matrix: [number,number,number,number] = [a*c+b*t,-a*t+b*c,d*c+e*t,-d*t+e*c];
    return { scale: value.scale, rotation_deg: Math.atan2(matrix[2],matrix[0])*180/Math.PI, matrix };
  };
  const document = <T extends {strokes: Point[][]}>(value: T): T => degrees === 0 ? value : { ...value, strokes: value.strokes.map(stroke => stroke.map(point)) };
  return { point, inverse,
    toMachineMapping: (value: Registration) => mapping(value, false),
    toPaperMapping: (value: Registration) => mapping(value, true),
    document,
    request(value: Record<string, unknown>) {
      const next = { ...value };
      for (const prefix of ["canvas", "origin"]) {
        if (typeof value[`${prefix}_x`] === "number" && typeof value[`${prefix}_y`] === "number") {
          const p = point({ x: value[`${prefix}_x`] as number, y: value[`${prefix}_y`] as number });
          next[`${prefix}_x`] = p.x; next[`${prefix}_y`] = p.y;
        }
      }
      if (value.type === "begin_registration" && Array.isArray(value.preserve_scale) && degrees !== 0) {
        const [sx,sy] = value.preserve_scale as number[];
        next.mapping = [sx*c*c+sy*s*s,(sy-sx)*c*s,(sy-sx)*c*s,sx*s*s+sy*c*c];
      }
      if (value.type === "run") {
        const job = value.job as {document: {strokes: Point[][]}};
        next.job = { ...job, document: document(job.document) };
      }
      return next;
    },
  };
}
