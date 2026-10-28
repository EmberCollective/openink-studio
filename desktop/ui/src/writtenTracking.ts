import type { Drawing } from "./editorGeometry";

/** Identities belong to editable strokes; geometry and route order may change. */
export function ensureStrokeIds<T extends Drawing>(document: T): T {
  if (document.strokeIds?.length === document.strokes.length && document.strokeIds.every(Boolean)) return document;
  return { ...document, strokeIds: document.strokes.map((_, index) => document.strokeIds?.[index] || crypto.randomUUID()) };
}

export function unwrittenDocument<T extends Drawing>(document: T, written: ReadonlySet<string>): T {
  const keep = document.strokes.map((_, index) => !written.has(document.strokeIds?.[index] || ""));
  return {
    ...document,
    strokes: document.strokes.filter((_, index) => keep[index]),
    ...(document.strokeIds ? { strokeIds: document.strokeIds.filter((_, index) => keep[index]) } : {}),
    ...(document.strokeOwners ? { strokeOwners: document.strokeOwners.filter((_, index) => keep[index]) } : {}),
  };
}

/** Call only for the submitted source snapshot after the controller's completed event. */
export function completedStrokeIds(document: Drawing): string[] {
  return document.strokes.flatMap((stroke, index) => stroke.length > 1 && document.strokeIds?.[index] ? [document.strokeIds[index]] : []);
}

export function markCompletedStroke(written: ReadonlySet<string>, orderedIds: readonly string[], index: number): Set<string> {
  const next = new Set(written);
  if (Number.isInteger(index) && index >= 0 && orderedIds[index]) next.add(orderedIds[index]);
  return next;
}

export function replacePendingStrokes<T extends Drawing>(document: T, replacement: Drawing, written: ReadonlySet<string>): T {
  const completed = document.strokes.flatMap((_, index) => written.has(document.strokeIds?.[index] || "") ? [index] : []);
  const pending = ensureStrokeIds(replacement);
  return { ...document, strokes: [...completed.map((index) => document.strokes[index]), ...pending.strokes], strokeIds: [...completed.map((index) => document.strokeIds![index]), ...pending.strokeIds!], strokeOwners: [...completed.map((index) => document.strokeOwners?.[index] || ""), ...(pending.strokeOwners || pending.strokes.map(() => ""))] };
}

export function resetWrittenSelection(written: ReadonlySet<string>, document: Drawing, selection: number[]): Set<string> {
  const next = new Set(written);
  for (const index of selection) {
    const id = document.strokeIds?.[index];
    if (id) next.delete(id);
  }
  return next;
}
