/** 「整理选区」：对画布上选中的笔画做书写顺序排序、拼接近端点、删除重复笔画。
 *  全部在纯函数里完成，并行数组（strokeIds / strokeOwners / strokeGroups）严格同步，
 *  批次映射与已书写集合都按 strokeId 关联，不受重排影响。 */
import type { Drawing, Point } from "./editorGeometry";
import { ensureStrokeIds } from "./writtenTracking.ts";

type Box = { cx: number; cy: number; x0: number; height: number };

function boxOf(stroke: Point[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of stroke) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, x0, height: y1 - y0 };
}

/** 选区槽位上的并行数组值按 order 重排：槽位保持不变，值按新顺序落位，选区外不受影响。 */
function reorderParallel<T extends Drawing>(doc: T, slots: number[], order: number[]): T {
  const position = new Map<number, number>();
  slots.forEach((slot, k) => position.set(slot, k));
  const mapIndex = <V,>(arr: V[] | undefined) => arr && arr.map((v, i) => {
    const k = position.get(i);
    return k === undefined ? v : arr[slots[order[k]]];
  });
  return {
    ...doc,
    strokes: mapIndex(doc.strokes)!,
    ...(doc.strokeIds ? { strokeIds: mapIndex(doc.strokeIds) } : {}),
    ...(doc.strokeOwners ? { strokeOwners: mapIndex(doc.strokeOwners) } : {}),
    ...(doc.strokeGroups ? { strokeGroups: mapIndex(doc.strokeGroups) } : {}),
  };
}

/** 删除 dropped 槽位；replacement 里的几何替换保留槽位的内容。返回 kept（旧下标）与 newIndexOf（旧→新映射）。 */
function dropSlots<T extends Drawing>(doc: T, dropped: Set<number>, replacement: Map<number, Point[]>): { doc: T; kept: number[]; newIndexOf: Map<number, number> } {
  const kept = doc.strokes.map((_, i) => i).filter(i => !dropped.has(i));
  const newIndexOf = new Map<number, number>();
  kept.forEach((old, index) => newIndexOf.set(old, index));
  return {
    doc: {
      ...doc,
      strokes: kept.map(i => replacement.get(i) ?? doc.strokes[i]),
      ...(doc.strokeIds ? { strokeIds: kept.map(i => doc.strokeIds![i]) } : {}),
      ...(doc.strokeOwners ? { strokeOwners: kept.map(i => doc.strokeOwners![i]) } : {}),
      ...(doc.strokeGroups ? { strokeGroups: kept.map(i => doc.strokeGroups![i] ?? 0) } : {}),
    },
    kept,
    newIndexOf,
  };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 书写顺序：笔画中心 y 聚成行（相邻中心差超过行容差就换行；行容差取选区笔画高度中位数的 60%，至少 2mm），行内按左端点从左到右。 */
export function sortSelectionForWriting<T extends Drawing>(doc: T, selection: number[]): { doc: T; selection: number[] } {
  if (selection.length < 2) return { doc, selection };
  const items = selection.map((slot, k) => ({ slot, box: boxOf(doc.strokes[slot]), k }))
    .sort((a, b) => a.box.cy - b.box.cy);
  const heights = items.map(i => i.box.height).filter(Number.isFinite).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 0;
  const rowTolerance = Math.max(2, median * 0.6);
  const rows: { k: number; x0: number }[][] = [];
  let current: { k: number; x0: number }[] = [];
  let rowY = NaN;
  for (const item of items) {
    if (!current.length || Math.abs(item.box.cy - rowY) > rowTolerance) {
      if (current.length) rows.push(current);
      current = [];
      rowY = item.box.cy;
    }
    current.push({ k: item.k, x0: item.box.x0 });
  }
  if (current.length) rows.push(current);
  // order[k] = 「原选区第几个」要落在槽位 k 上。
  const order = rows.flatMap(row => row.sort((a, b) => a.x0 - b.x0)).map(item => item.k);
  if (order.every((k, i) => k === i)) return { doc, selection };
  return { doc: reorderParallel(doc, selection, order), selection };
}

/** 拼接近端点：从选区笔画出发，把端点距离不超过 tolerance 的笔画接到链尾（方向不符时反转对方），
 *  只允许未书写笔画参与。返回 merged 为被吸收（消失）的笔画数。 */
export function mergeNearbyEnds<T extends Drawing>(doc: T, selection: number[], tolerance: number, written: ReadonlySet<string>):
  { doc: T; selection: number[]; merged: number } {
  if (selection.length < 2) return { doc, selection, merged: 0 };
  const safe = ensureStrokeIds(doc);
  for (const i of selection) {
    if (written.has(safe.strokeIds?.[i] || "")) throw new Error("选区包含已书写笔画，不能拼接；请先重置书写标记");
  }
  const remaining = new Set(selection);
  const replacement = new Map<number, Point[]>();
  const dropped = new Set<number>();
  while (remaining.size) {
    const seed = Math.min(...remaining);
    remaining.delete(seed);
    const chain = [...safe.strokes[seed].map(p => ({ ...p }))];
    for (;;) {
      const tail = chain[chain.length - 1];
      let nextSlot = -1, nextPoints: Point[] | null = null;
      for (const slot of remaining) {
        const pts = safe.strokes[slot];
        if (pts.length < 1) continue;
        if (dist(tail, pts[0]) <= tolerance) { nextSlot = slot; nextPoints = pts; break; }
        if (dist(tail, pts[pts.length - 1]) <= tolerance) { nextSlot = slot; nextPoints = [...pts].reverse(); break; }
      }
      if (nextSlot < 0 || !nextPoints) break;
      chain.push(...nextPoints.map(p => ({ ...p })));
      remaining.delete(nextSlot);
      dropped.add(nextSlot);
    }
    replacement.set(seed, chain);
  }
  if (!dropped.size) return { doc, selection, merged: 0 };
  const { doc: next, newIndexOf } = dropSlots(safe, dropped, replacement);
  return { doc: next, selection: selection.filter(i => !dropped.has(i)).map(i => newIndexOf.get(i)!), merged: dropped.size };
}

/** 删除重复笔画：选区内点数相同、逐点距离都不超过 tolerance（默认同向）的，保留先出现的一条。 */
export function dedupeSelection<T extends Drawing>(doc: T, selection: number[], tolerance = 0.05): { doc: T; selection: number[]; removed: number } {
  const dropped = new Set<number>();
  for (let a = 0; a < selection.length; a++) {
    const i = selection[a];
    if (dropped.has(i)) continue;
    for (let b = a + 1; b < selection.length; b++) {
      const j = selection[b];
      if (dropped.has(j)) continue;
      const A = doc.strokes[i], B = doc.strokes[j];
      if (A.length !== B.length) continue;
      let same = true;
      for (let k = 0; k < A.length; k++) {
        if (dist(A[k], B[k]) > tolerance) { same = false; break; }
      }
      if (same) dropped.add(j);
    }
  }
  if (!dropped.size) return { doc, selection, removed: 0 };
  const { doc: next, newIndexOf } = dropSlots(doc, dropped, new Map());
  return { doc: next, selection: selection.filter(i => !dropped.has(i)).map(i => newIndexOf.get(i)!), removed: dropped.size };
}
