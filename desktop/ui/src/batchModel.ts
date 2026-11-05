import type { Drawing } from "./editorGeometry";
import { ensureStrokeIds } from "./writtenTracking.ts";

export type Batch = { id: string; name: string; color: number };
export type BatchData = { batches?: Batch[]; strokeBatches?: Record<string, string>; writtenStrokeIds?: string[]; reviewBatchIds?: string[] };
export const batchColors = ["#7161b8", "#287c98", "#a46a25", "#a54d83", "#47794c", "#6e708c"];
export function batchesOf(doc: Drawing): Batch[] {
  return doc.batches?.length ? doc.batches : [{ id: "default", name: "本页全部内容", color: 0 }];
}
export function batchOf(doc: Drawing, index: number): string {
  const id = doc.strokeIds?.[index] || "";
  return doc.strokeBatches && Object.hasOwn(doc.strokeBatches, id) ? doc.strokeBatches[id] : (batchesOf(doc).find(b => b.id === "default") || batchesOf(doc)[0]).id;
}
export function batchDocument<T extends Drawing>(doc: T, id: string): T {
  const keep = doc.strokes.flatMap((_, i) => batchOf(doc, i) === id ? [i] : []);
  return { ...doc, strokes: keep.map(i => doc.strokes[i]), strokeIds: keep.map(i => doc.strokeIds?.[i] || ""), strokeOwners: keep.map(i => doc.strokeOwners?.[i] || "") };
}
export function batchStatus(doc: Drawing, id: string, written: ReadonlySet<string>) {
  const ids = doc.strokes.flatMap((s, i) => s.length > 1 && batchOf(doc, i) === id ? [doc.strokeIds?.[i] || ""] : []);
  return !ids.length ? "空批次" : ids.every(id => written.has(id)) ? "已完成" : "待书写";
}
export function assignBatch<T extends Drawing>(doc: T, indices: number[], id: string): T {
  if (!batchesOf(doc).some(b => b.id === id)) throw new Error("目标批次不存在");
  const next = ensureStrokeIds(doc), map = { ...next.strokeBatches };
  for (const i of indices) if (next.strokeIds?.[i]) map[next.strokeIds[i]] = id;
  return { ...next, batches: batchesOf(next), strokeBatches: map };
}
export function cleanBatchData<T extends Drawing>(doc: T): T {
  const ids = new Set(doc.strokeIds || []);
  return { ...doc, ...(doc.strokeBatches ? { strokeBatches: Object.fromEntries(Object.entries(doc.strokeBatches).filter(([id]) => ids.has(id))) } : {}) };
}
/** Preserve every other batch, including its pending strokes, when replacing a route. */
export function replaceBatchRoute<T extends Drawing>(doc: T, id: string, replacement: Drawing, written: ReadonlySet<string>): T {
  const keep = doc.strokes.flatMap((_, i) => batchOf(doc, i) !== id || written.has(doc.strokeIds?.[i] || "") ? [i] : []);
  const next = ensureStrokeIds({ ...replacement, strokeIds: undefined });
  const merged = { ...doc, strokes: [...keep.map(i => doc.strokes[i]), ...next.strokes], strokeIds: [...keep.map(i => doc.strokeIds![i]), ...next.strokeIds!], strokeOwners: [...keep.map(i => doc.strokeOwners?.[i] || ""), ...(next.strokeOwners || next.strokes.map(() => ""))] };
  return cleanBatchData(assignBatch(merged, next.strokes.map((_, i) => keep.length + i), id));
}
export function copyBatchPage<T extends Drawing>(doc: T): T {
  const next = { ...doc, strokeIds: doc.strokes.map(() => crypto.randomUUID()), writtenStrokeIds: [], reviewBatchIds: [] };
  next.strokeBatches = Object.fromEntries(next.strokeIds.map((id, i) => [id, batchOf(doc, i)]));
  return next;
}
/** Older copied pages may share stroke IDs; completion must never cross page boundaries. */
export function uniquePageStrokeIds<T extends Drawing>(pages: T[]): T[] {
  const seen = new Set<string>();
  return pages.map(page => {
    const doc = ensureStrokeIds(page), remap = new Map<string, string>();
    const strokeIds = doc.strokeIds!.map(id => { const next = seen.has(id) ? crypto.randomUUID() : id; seen.add(next); remap.set(id, next); return next; });
    return { ...doc, strokeIds, ...(doc.strokeBatches ? { strokeBatches: Object.fromEntries(Object.entries(doc.strokeBatches).filter(([id]) => remap.has(id)).map(([id,b]) => [remap.get(id)!,b])) } : {}), ...(doc.writtenStrokeIds ? { writtenStrokeIds: doc.writtenStrokeIds.map(id => remap.get(id)!).filter(Boolean) } : {}) };
  });
}
