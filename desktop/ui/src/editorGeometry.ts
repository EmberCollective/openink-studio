export type Point = { x: number; y: number };
export type Drawing = {
  text_settings?: import("./paperModel").TextSettings;
  name: string;
  width_mm: number;
  height_mm: number;
  strokes: Point[][];
  materials?: { id: string; name: string; kind: string }[];
  strokeOwners?: string[];
  strokeIds?: string[];
};
export type Bounds = { x: number; y: number; width: number; height: number };
export const resizeHandles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type ResizeHandle = typeof resizeHandles[number];
export function handlePoint(box: Bounds, handle: ResizeHandle): Point {
  return { x: box.x + (handle.includes("w") ? 0 : handle.includes("e") ? box.width : box.width / 2), y: box.y + (handle.includes("n") ? 0 : handle.includes("s") ? box.height : box.height / 2) };
}
/** Resize from the opposite fixed anchor; midpoint handles change one axis only. */
export function resizeFromHandle(doc: Drawing, ids: number[], handle: ResizeHandle, point: Point, proportional: boolean): Drawing {
  const box = boundsOf(doc, ids);
  if (!box) return doc;
  const dx = handle.includes("w") ? -1 : handle.includes("e") ? 1 : 0;
  const dy = handle.includes("n") ? -1 : handle.includes("s") ? 1 : 0;
  const anchor = { x: box.x + (dx < 0 ? box.width : dx > 0 ? 0 : box.width / 2), y: box.y + (dy < 0 ? box.height : dy > 0 ? 0 : box.height / 2) };
  let sx = dx && box.width ? Math.max(.05 / box.width, dx * (point.x - anchor.x) / box.width) : 1;
  let sy = dy && box.height ? Math.max(.05 / box.height, dy * (point.y - anchor.y) / box.height) : 1;
  if (proportional && dx && dy && box.width && box.height) {
    const factor = Math.max(.05 / box.width, .05 / box.height, Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy);
    sx = factor; sy = factor;
  }
  return transformPaths(doc, ids, (p) => ({ x: anchor.x + (p.x - anchor.x) * sx, y: anchor.y + (p.y - anchor.y) * sy }));
}
export function rotationFromPointer(box: Bounds, start: Point, current: Point, snap: boolean): number {
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const angle = (Math.atan2(current.y - center.y, current.x - center.x) - Math.atan2(start.y - center.y, start.x - center.x)) * 180 / Math.PI;
  const normalized = ((angle + 540) % 360) - 180;
  return snap ? Math.round(normalized / 15) * 15 : normalized;
}
export const rectangle = (a: Point, b: Point): Bounds => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});
export function boundsOf(doc: Drawing, ids?: number[]): Bounds | null {
  const wanted = ids ? new Set(ids) : null;
  let x = Infinity,
    y = Infinity,
    r = -Infinity,
    b = -Infinity;
  doc.strokes.forEach((s, i) => {
    if (wanted && !wanted.has(i)) return;
    for (const p of s) {
      x = Math.min(x, p.x);
      y = Math.min(y, p.y);
      r = Math.max(r, p.x);
      b = Math.max(b, p.y);
    }
  });
  return Number.isFinite(x) ? { x, y, width: r - x, height: b - y } : null;
}
function intersects(a: Point, b: Point, r: Bounds): boolean {
  let low = 0,
    high = 1;
  const dx = b.x - a.x,
    dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - r.x],
    [dx, r.x + r.width - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.height - a.y],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) low = Math.max(low, t);
      else high = Math.min(high, t);
      if (low > high) return false;
    }
  }
  return true;
}
export function selectByRectangle(doc: Drawing, r: Bounds): number[] {
  return doc.strokes.flatMap((s, i) =>
    s.some(
      (p) =>
        p.x >= r.x &&
        p.x <= r.x + r.width &&
        p.y >= r.y &&
        p.y <= r.y + r.height,
    ) || s.some((p, k) => k > 0 && intersects(s[k - 1], p, r))
      ? [i]
      : [],
  );
}
function distance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length
    ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length))
    : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function hitStroke(
  doc: Drawing,
  p: Point,
  tolerance: number,
): number | null {
  let nearest: number | null = null,
    best = tolerance;
  doc.strokes.forEach((s, i) => {
    for (let k = 1; k < s.length; k++) {
      const d = distance(p, s[k - 1], s[k]);
      if (d <= best) {
        best = d;
        nearest = i;
      }
    }
  });
  return nearest;
}
export function transformPaths(
  doc: Drawing,
  ids: number[],
  map: (p: Point) => Point,
): Drawing {
  const selected = new Set(ids);
  return {
    ...doc,
    strokes: doc.strokes.map((s, i) =>
      selected.has(i)
        ? s.map((p) => {
            const q = map(p);
            if (!Number.isFinite(q.x) || !Number.isFinite(q.y))
              throw new Error("变换坐标必须为有限数值");
            return q;
          })
        : s,
    ),
  };
}
export const movePaths = (
  doc: Drawing,
  ids: number[],
  dx: number,
  dy: number,
) => transformPaths(doc, ids, (p) => ({ x: p.x + dx, y: p.y + dy }));
export function resizePaths(
  doc: Drawing,
  ids: number[],
  width: number,
  height: number,
): Drawing {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 0 ||
    height < 0
  )
    throw new Error("宽高必须为非负有限数值");
  const b = boundsOf(doc, ids);
  if (!b) return doc;
  const sx = b.width ? width / b.width : 1,
    sy = b.height ? height / b.height : 1;
  if ((b.width > 0 && width <= 0) || (b.height > 0 && height <= 0))
    throw new Error("不能把非零路径尺寸压缩为零");
  return transformPaths(doc, ids, (p) => ({
    x: b.x + (p.x - b.x) * sx,
    y: b.y + (p.y - b.y) * sy,
  }));
}
export function rotatePaths(
  doc: Drawing,
  ids: number[],
  degrees: number,
): Drawing {
  const b = boundsOf(doc, ids);
  if (!b) return doc;
  const x = b.x + b.width / 2,
    y = b.y + b.height / 2,
    a = (degrees * Math.PI) / 180;
  return transformPaths(doc, ids, (p) => ({
    x: x + (p.x - x) * Math.cos(a) - (p.y - y) * Math.sin(a),
    y: y + (p.x - x) * Math.sin(a) + (p.y - y) * Math.cos(a),
  }));
}
export function deletePaths(doc: Drawing, ids: number[]): Drawing {
  const removed = new Set(ids);
  return { ...doc, strokes: doc.strokes.filter((_, i) => !removed.has(i)), ...(doc.strokeOwners ? { strokeOwners: doc.strokeOwners.filter((_, i) => !removed.has(i)) } : {}), ...(doc.strokeIds ? { strokeIds: doc.strokeIds.filter((_, i) => !removed.has(i)) } : {}) };
}
export function copyPaths(doc: Drawing, ids: number[]): Point[][] {
  const selected = new Set(ids);
  return doc.strokes
    .filter((_, i) => selected.has(i))
    .map((s) => s.map((p) => ({ ...p })));
}
export function pastePaths(
  doc: Drawing,
  clipboard: Point[][],
  offset: Point = { x: 2, y: 2 },
): { document: Drawing; selection: number[] } {
  const start = doc.strokes.length;
  const materialId = doc.materials && clipboard.length ? crypto.randomUUID() : null;
  return {
    document: {
      ...doc,
      ...(doc.strokeIds ? { strokeIds: [...doc.strokeIds, ...clipboard.map(() => crypto.randomUUID())] } : {}),
      ...(materialId ? {
        materials: [...doc.materials!, { id: materialId, name: "复制的笔画", kind: "copy" }],
        strokeOwners: [...(doc.strokeOwners || doc.strokes.map(() => "")), ...clipboard.map(() => materialId)],
      } : {}),
      strokes: [
        ...doc.strokes,
        ...clipboard.map((s) =>
          s.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })),
        ),
      ],
    },
    selection: clipboard.map((_, i) => start + i),
  };
}
