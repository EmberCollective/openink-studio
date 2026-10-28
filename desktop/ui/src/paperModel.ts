export type GuideLine = { id: string; start: [number, number]; end: [number, number] };
export function guideLineNumber(line: GuideLine, index: number): number {
  const match = /^line-([1-9]\d*)$/.exec(line.id);
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) ? number : index + 1;
}
export type TextSettings = {
  text: string; font_mode: "regular" | "glyph" | "legacy"; font_path: string; glyph_path: string;
  legacy_selection: { path: string; weight: number }[]; legacy_percent: number; legacy_baseline: number; legacy_seed: number;
  centerline: boolean; placement: "free" | "lines"; start_line: number; offset: number; font_size_mm: number; letter_spacing_mm: number;
};
export function validTextSettings(value: unknown): value is TextSettings {
  if (!value || typeof value !== "object") return false;
  const v = value as TextSettings;
  const range = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi;
  return typeof v.text === "string" && v.text.length <= 1_000_000 && ["regular", "glyph", "legacy"].includes(v.font_mode)
    && typeof v.font_path === "string" && typeof v.glyph_path === "string" && typeof v.centerline === "boolean"
    && ["free", "lines"].includes(v.placement) && Number.isInteger(v.start_line) && range(v.start_line, 0, 10000)
    && range(v.offset, 0, 10) && range(v.font_size_mm, 1, 80) && range(v.letter_spacing_mm, 0, 20)
    && range(v.legacy_percent, 1, 200) && range(v.legacy_baseline, 0, 2) && Number.isInteger(v.legacy_seed) && range(v.legacy_seed, 0, 2147483647)
    && Array.isArray(v.legacy_selection) && v.legacy_selection.length <= 1000 && v.legacy_selection.every(f => f && typeof f.path === "string" && Number.isFinite(f.weight) && f.weight >= 0);
}
export type BackgroundPage = {
  path: string; page: number; page_count: number; data_url: string;
  kind?: "pdf" | "image"; source_path?: string; guide_lines?: GuideLine[];
  corners?: number[][]; processed?: boolean; guides_visible?: boolean;
  width_mm?: number; height_mm?: number;
};
export const blankBackground = (): BackgroundPage => ({ path: "", page: 1, page_count: 1, data_url: "" });
export function backgroundSnapshot(bg: BackgroundPage | undefined): BackgroundPage | null {
  if (!bg?.path) return null;
  return { path: bg.path, page: bg.page, page_count: bg.page_count, data_url: bg.data_url,
    ...(bg.kind ? { kind: bg.kind } : {}), ...(bg.source_path ? { source_path: bg.source_path } : {}),
    ...(bg.guide_lines ? { guide_lines: bg.guide_lines } : {}), ...(bg.corners ? { corners: bg.corners } : {}),
    ...(bg.processed !== undefined ? { processed: bg.processed } : {}), ...(bg.guides_visible !== undefined ? { guides_visible: bg.guides_visible } : {}),
  };
}
