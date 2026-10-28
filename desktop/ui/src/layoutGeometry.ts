import type { Drawing } from "./editorGeometry";
import type { BackgroundPage } from "./paperModel";
import { registrationScales, validRegistrationPoints, type Registration } from "./coordinateGeometry";
import type { RegistrationSetup } from "./RegistrationPanel";

export type Layout = {
  id: string; name: string; description: string;
  width_mm: number; height_mm: number; margin_mm: number;
  font_size_mm: number; letter_spacing_mm: number; lines: number;
  source: "template" | "manual" | "pdf" | "image";
  scale_x?: number; scale_y?: number;
  derivation?: { mode: "two" | "three"; base_width_mm: number; base_height_mm: number; scale_x: number; scale_y: number };
};
export type LayoutPage = { document: Drawing & { route_optimized?: boolean }; background: BackgroundPage | null; layout_id?: string };
type Template = Omit<Layout, "source" | "derivation" | "scale_x" | "scale_y">;
const dimension = (n: number) => Number.isFinite(n) && n > 0 && n <= 1000;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7;

export function resizePositioning(setup: RegistrationSetup, before: Layout, after: Layout) {
  const resize = (point: number[]) => point.map((value, axis) => {
    const oldSize = axis ? before.height_mm : before.width_mm, size = axis ? after.height_mm : after.width_mm;
    return Math.max(0, Math.min(size, Number((value / oldSize * size).toFixed(6))));
  });
  let points = [...setup.points, ...(setup.point3 ? [setup.point3] : [])].map(resize);
  if (!validRegistrationPoints(points, after.width_mm, after.height_mm)) {
    points = [[after.width_mm, 0], [0, after.height_mm], ...(setup.point3 ? [[0, 0]] : [])];
  }
  return { setup: { ...setup, points: points.slice(0, 2), ...(setup.point3 ? { point3: points[2] } : {}), selected_profile: "" }, origin: [...points[0]], pen: [...points[points.length - 1]] };
}

export function validateLayout(layout: Layout): void {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(layout.id) || !layout.name.trim() || typeof layout.description !== "string"
    || !dimension(layout.width_mm) || !dimension(layout.height_mm)
    || !Number.isFinite(layout.margin_mm) || layout.margin_mm < 0 || layout.margin_mm * 2 >= Math.min(layout.width_mm, layout.height_mm)
    || !Number.isFinite(layout.font_size_mm) || layout.font_size_mm <= 0
    || !Number.isFinite(layout.letter_spacing_mm) || layout.letter_spacing_mm < 0
    || !Number.isInteger(layout.lines) || layout.lines < 1 || layout.lines > 1000
    || !["template", "manual", "pdf", "image"].includes(layout.source)) throw new Error("版面尺寸、边距或文字参数无效");
  if ((layout.scale_x !== undefined || layout.scale_y !== undefined)
    && ![layout.scale_x, layout.scale_y].every(n => typeof n === "number" && Number.isFinite(n) && n >= .1 && n <= 10)) throw new Error("书写比例须在 10% 至 1000% 之间");
  const d = layout.derivation;
  if (d && (!["two", "three"].includes(d.mode) || !dimension(d.base_width_mm) || !dimension(d.base_height_mm)
    || ![d.scale_x, d.scale_y].every(n => Number.isFinite(n) && n >= 0.1 && n <= 10))) throw new Error("版面反推数据无效");
}

export function applyScaleToPages(pages: readonly LayoutPage[], layouts: readonly Layout[], scales: [number, number], indices: readonly number[]) {
  if (indices.some(i => !Number.isInteger(i) || i < 0 || i >= pages.length)) throw new Error("选择的页面不存在");
  const selected = new Set(indices), replacements = new Map<string, Layout>();
  const definitions = [...layouts];
  for (const layout of layouts) {
    if (!pages.some((p, i) => p.layout_id === layout.id && selected.has(i))) continue;
    const split = pages.some((p, i) => p.layout_id === layout.id && !selected.has(i));
    const next = { ...layout, id: split ? crypto.randomUUID() : layout.id, scale_x: scales[0], scale_y: scales[1] };
    validateLayout(next); replacements.set(layout.id, next);
    if (split) definitions.push(next); else definitions[definitions.indexOf(layout)] = next;
  }
  return { layouts: definitions, pages: pages.map((page, i) => selected.has(i) ? { ...page, layout_id: replacements.get(page.layout_id!)!.id } : page) };
}

function resizedBackground(page: LayoutPage, width: number, height: number): BackgroundPage | null {
  const bg = page.background;
  if (!bg?.path) return bg;
  const oldWidth = page.document.width_mm, oldHeight = page.document.height_mm;
  const sx = width / oldWidth, sy = height / oldHeight;
  const point = (p: [number, number]): [number, number] => {
    if (p.length !== 2 || !p.every(Number.isFinite) || p[0] < 0 || p[1] < 0 || p[0] > oldWidth || p[1] > oldHeight) throw new Error("背景横线超出页面，请重新处理底稿");
    return [p[0] * sx, p[1] * sy];
  };
  const guide_lines = bg.guide_lines?.map(line => {
    if (line.end[0] <= line.start[0]) throw new Error("背景横线方向无效，请重新处理底稿");
    return { ...line, start: point(line.start), end: point(line.end) };
  });
  return { ...bg, width_mm: width, height_mm: height, ...(guide_lines ? { guide_lines } : {}) };
}

export function applyLayoutToPages(pages: readonly LayoutPage[], layout: Layout, selectedIndices: readonly number[]): LayoutPage[] {
  validateLayout(layout);
  if (selectedIndices.some(i => !Number.isInteger(i) || i < 0 || i >= pages.length)) throw new Error("选择的页面不存在");
  const selected = new Set(selectedIndices), outside: number[] = [];
  pages.forEach((page, i) => {
    if (selected.has(i) && page.document.strokes.some(stroke => stroke.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)
      || p.x < 0 || p.y < 0 || p.x > layout.width_mm || p.y > layout.height_mm))) outside.push(i + 1);
  });
  if (outside.length) throw new Error(`第 ${outside.join("、")} 页字迹超出新版面；请先调整内容或换版面`);
  return pages.map((page, i) => {
    if (!selected.has(i)) return page;
    let background: BackgroundPage | null;
    try { background = resizedBackground(page, layout.width_mm, layout.height_mm); }
    catch (error) { throw new Error(`第 ${i + 1} 页：${error instanceof Error ? error.message : String(error)}`); }
    const text = page.document.text_settings;
    return { ...page, layout_id: layout.id, background, document: { ...page.document, width_mm: layout.width_mm, height_mm: layout.height_mm,
      ...(text ? { text_settings: { ...text, font_size_mm: layout.font_size_mm, letter_spacing_mm: layout.letter_spacing_mm } } : {}) } };
  });
}

export function normalizeLayouts(pages: readonly LayoutPage[], template: Template, layouts?: readonly Layout[], legacyRegistration?: Registration): { pages: LayoutPage[]; layouts: Layout[] } {
  const [scale_x, scale_y] = legacyRegistration ? registrationScales(legacyRegistration) : [1, 1];
  if (!pages.length || pages.length > 200) throw new Error("工程页数无效");
  if (layouts !== undefined) {
    if (!layouts.length || layouts.length > 200 || new Set(layouts.map(l => l.id)).size !== layouts.length) throw new Error("工程版面标识重复或数量无效");
    layouts.forEach(validateLayout);
    const byId = new Map(layouts.map(l => [l.id, l]));
    for (const page of pages) {
      const layout = page.layout_id && byId.get(page.layout_id);
      if (!layout || !close(page.document.width_mm, layout.width_mm) || !close(page.document.height_mm, layout.height_mm)) throw new Error("工程页面与版面引用或尺寸不一致");
      resizedBackground(page, layout.width_mm, layout.height_mm);
    }
    return { pages: [...pages], layouts: layouts.map(layout => ({ scale_x, scale_y, ...layout })) };
  }
  if (pages.some(p => p.layout_id !== undefined)) throw new Error("工程缺少已引用的版面配置");
  const migrated: Layout[] = [];
  const result = pages.map(page => {
    const { width_mm, height_mm } = page.document;
    let layout = migrated.find(l => l.width_mm === width_mm && l.height_mm === height_mm);
    if (!layout) {
      layout = { ...template, id: `layout-${migrated.length + 1}`, width_mm, height_mm, scale_x, scale_y,
        margin_mm: template.margin_mm * 2 < Math.min(width_mm, height_mm) ? template.margin_mm : Math.min(width_mm, height_mm) / 4, source: "template" };
      validateLayout(layout); migrated.push(layout);
    }
    resizedBackground(page, width_mm, height_mm);
    return { ...page, layout_id: layout.id };
  });
  return { pages: result, layouts: migrated };
}
