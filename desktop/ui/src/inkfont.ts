import { invoke } from "@tauri-apps/api/core";
import type { Point } from "./editorGeometry";
import { boundsOf } from "./editorGeometry.ts";

export type InkVariant = { id: string; character: string; width_mm: number; height_mm: number; advance_mm: number; strokes: Point[][]; canvas?: { x: number; y: number; width: number; height: number } };
export type InkPackage = { format: "openink-font"; version: 1; id: string; name: string; revision: number; variants: InkVariant[] };
export type InkSummary = { id: string; name: string; path: string; characters: string[]; variant_count: number; revision: number };
export const inkfontList = () => invoke<InkSummary[]>("inkfont_list");
export const inkfontLoad = (id: string) => invoke<InkPackage>("inkfont_load", { id });
export const inkfontSave = (pack: InkPackage) => invoke<InkPackage>("inkfont_save", { package: pack });
export const inkfontImport = (path: string) => invoke<InkPackage>("inkfont_import", { path });
export const inkfontExport = (id: string, path: string) => invoke<void>("inkfont_export", { id, path });
export const inkfontDelete = (id: string, revision: number) => invoke<void>("inkfont_delete", { id, revision });
export type BaselineNormalizeResult = { revision: number; adjusted: number; skipped: number; total: number; limit_mm: number; max_shift_mm: number; mean_shift_mm: number; backup: string };
export const inkfontNormalizeBaseline = (id: string, maxShiftMm?: number) => invoke<BaselineNormalizeResult>("inkfont_normalize_baseline", { id, max_shift_mm: maxShiftMm ?? null });
export const newInkPackage = (name: string): InkPackage => ({ format: "openink-font", version: 1, id: "", name: name.trim(), revision: 0, variants: [] });
export const newInkVariant = (character = ""): InkVariant => ({ id: crypto.randomUUID(), character, width_mm: 20, height_mm: 20, advance_mm: 20, strokes: [] });

export function inkCanvas(variant: InkVariant) {
  const side = Math.max(variant.width_mm, variant.height_mm);
  return variant.canvas ?? { x: (variant.width_mm - side) / 2, y: (variant.height_mm - side) / 2, width: side, height: side };
}

/** Match gfont writing: retain positive left bearing and original em height. */
export function inkWritingMetrics(variant: InkVariant) {
  const bounds = boundsOf({ ...variant, name: variant.character });
  const width = bounds ? bounds.width + Math.max(bounds.x, 0) : 0;
  return { x: Math.min(bounds?.x ?? 0, 0), width: width || variant.height_mm * .1, height: variant.height_mm };
}

/** 字形只能对应一个字符：把常见的省略号连打（... / 。。。 / ……）归一成单个 …。 */
export function normalizeGlyphCharacter(input: string): string {
  const compact = input.replace(/[\s\u3000]+/g, "");
  if (compact.length > 1 && /^[.。…·]{2,}$/u.test(compact)) return "…";
  return compact.length === 1 ? compact : input;
}

/** 新建字形默认占满 20mm 画布。若保存时字距仍是这个默认值，把墨迹平移到起笔处、
 *  并按墨迹实际宽度收拢字距——避免没调整过字距的字形（如斜杠）在排版里留出大片空白。 */
export function applyWritingAdvance(variant: InkVariant): InkVariant {
  if (variant.advance_mm !== 20 || variant.width_mm !== 20 || variant.height_mm !== 20 || !variant.strokes.length) return variant;
  const xs = variant.strokes.flatMap(s => s.map(p => p.x));
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return variant;
  const strokes = variant.strokes.map(s => s.map(p => ({ ...p, x: p.x - minX + 0.1 })));
  const advance = Math.max(2, Math.min(20, maxX - minX + 0.5));
  return { ...variant, strokes, advance_mm: advance };
}

export function variantError(variant: InkVariant): string {
  if (Array.from(variant.character).length !== 1 || /[\s\p{Cc}]/u.test(variant.character)) return "请填写一个非空白、非控制字符。";
  if (![variant.width_mm, variant.height_mm, variant.advance_mm].every(n => Number.isFinite(n) && n > 0)) return "字面宽高和字距须为正数。";
  if (!variant.strokes.length || variant.strokes.some(s => s.length < 2 || s.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) return "至少保留一条有效笔画。";
  const canvas = variant.canvas ?? { x: 0, y: 0, width: variant.width_mm, height: variant.height_mm };
  if (![canvas.x, canvas.y, canvas.width, canvas.height, canvas.x + canvas.width, canvas.y + canvas.height].every(Number.isFinite) || canvas.width <= 0 || canvas.height <= 0) return "编辑画布范围无效。";
  if (variant.strokes.some(s => s.some(p => p.x < canvas.x || p.y < canvas.y || p.x > canvas.x + canvas.width || p.y > canvas.y + canvas.height))) return "笔迹超出画布，请将笔迹移回白色边框内后再保存。";
  return "";
}

export function replaceVariant(pack: InkPackage, variant: InkVariant): InkPackage {
  const error = variantError(variant);
  if (error) throw new Error(error);
  const exists = pack.variants.some(v => v.id === variant.id);
  return { ...pack, variants: exists ? pack.variants.map(v => v.id === variant.id ? variant : v) : [...pack.variants, variant] };
}

export function previewInkText(pack: InkPackage, text: string, random = Math.random) {
  const byChar = new Map<string, InkVariant[]>();
  for (const variant of pack.variants) {
    const variants = byChar.get(variant.character) || [];
    variants.push(variant); byChar.set(variant.character, variants);
  }
  return Array.from(text).map(character => {
    const variants = byChar.get(character) || [];
    const index = Math.floor(random() * variants.length);
    return { character, ordinal: index + 1, variant: variants[index] ? structuredClone(variants[index]) : null };
  });
}
