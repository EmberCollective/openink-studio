import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript"), api = {};
const code = ts.transpileModule(readFileSync(new URL("./layoutGeometry.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const geometry = {};
new Function("exports", ts.transpileModule(readFileSync(new URL("./coordinateGeometry.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(geometry);
new Function("exports", "require", code)(api, () => geometry);
const { applyScaleToPages, normalizeLayouts, applyLayoutToPages, virtualTextGuides } = api;
const layout = { id: "layout-1", name: "PDF", description: "", width_mm: 200, height_mm: 300, margin_mm: 10, font_size_mm: 10, letter_spacing_mm: 1, lines: 12, source: "pdf" };
const page = (width = 200, height = 300) => ({ document: { name: "字迹", width_mm: width, height_mm: height, strokes: [[{ x: 10, y: 20 }, { x: 40, y: 50 }]] }, background: null });

test("layout resize scales calibration points and origin, with valid corner fallback", () => {
  const setup = { points: [[200,0],[20,280]], point3: [20,0], show_points: false, selected_profile: "old" };
  const next = { ...layout, width_mm: 180, height_mm: 240 };
  const result = api.resizePositioning(setup, layout, next);
  assert.deepEqual(result.points, [[180,0],[18,224]]);
  assert.deepEqual(result.point3, [18,0]);
  assert.equal(result.show_points, false); assert.equal(result.selected_profile, "");
  assert.deepEqual(api.resizePositioning({ ...setup, points: [[100,100],[101,101]] }, layout, next).points, [[180,0],[0,240]]);
  const two = api.resizePositioning({ ...setup, point3: undefined }, layout, next);
  assert.equal(two.points.length, 2);
  assert.deepEqual(setup.points, [[200,0],[20,280]]);
});

test("page scales preserve original PDF, ink and unselected group members", () => {
  const pages = [page(), page(), page()].map(p => ({ ...p, layout_id: layout.id }));
  pages[0].background = { path: "paper.pdf", page: 1, page_count: 1, data_url: "preview" };
  const result = applyScaleToPages(pages, [layout], [.98, 1.02], [0, 2]);
  assert.notEqual(result.pages[0].layout_id, layout.id);
  assert.equal(result.pages[0].layout_id, result.pages[2].layout_id);
  assert.equal(result.pages[1], pages[1]);
  assert.equal(result.pages[0].document, pages[0].document);
  assert.equal(result.pages[0].background, pages[0].background);
  const target = result.layouts.find(l => l.id === result.pages[0].layout_id);
  assert.deepEqual([target.scale_x, target.scale_y, target.width_mm, target.height_mm], [.98, 1.02, 200, 300]);
  assert.throws(() => applyScaleToPages(pages, [layout], [NaN, 1], [0]), /比例/);
  assert.throws(() => applyScaleToPages(pages, [layout], [1, 1], [3]), /页面/);
});

test("legacy axis scales migrate without baking rotation into page dimensions", () => {
  const registration = geometry.scaledRegistration(.98, 1.02, 27);
  const result = normalizeLayouts([page()], layout, undefined, registration);
  assert.ok(Math.abs(result.layouts[0].scale_x - .98) < 1e-12);
  assert.ok(Math.abs(result.layouts[0].scale_y - 1.02) < 1e-12);
  assert.equal(result.layouts[0].width_mm, 200);
});

test("legacy migration groups equal sizes without changing ink or text", () => {
  const pages = [page(), page(), page(160, 240)];
  const before = structuredClone(pages), result = normalizeLayouts(pages, layout);
  assert.equal(result.layouts.length, 2);
  assert.equal(result.pages[0].layout_id, result.pages[1].layout_id);
  assert.notEqual(result.pages[0].layout_id, result.pages[2].layout_id);
  assert.equal(result.layouts[1].margin_mm, 10);
  assert.deepEqual(pages, before); assert.equal(result.pages[0].document, pages[0].document);
  assert.deepEqual(normalizeLayouts(result.pages, layout, result.layouts), result);
  assert.throws(() => normalizeLayouts([{ ...pages[0], layout_id: "missing" }], layout, result.layouts), /引用/);
  assert.throws(() => normalizeLayouts(result.pages, layout, [result.layouts[0], result.layouts[0]]), /重复/);
  assert.throws(() => normalizeLayouts(result.pages, layout), /缺少/);
  assert.throws(() => normalizeLayouts([page(NaN)], layout), /版面/);
  assert.equal(normalizeLayouts([page(100, 150)], { ...layout, margin_mm: 40 }).layouts[0].margin_mm, 40);
  assert.equal(normalizeLayouts([page(60, 150)], { ...layout, margin_mm: 40 }).layouts[0].margin_mm, 15);
});

test("multi-page application preserves strokes, synchronizes backgrounds and text style", () => {
  const first = page(); first.document.text_settings = { text: "保留", font_size_mm: 8, letter_spacing_mm: 2 };
  first.background = { path: "paper.pdf", page: 1, page_count: 1, data_url: "", width_mm: 200, height_mm: 300,
    guide_lines: [{ id: "line-1", start: [10, 20], end: [190, 20] }] };
  const pages = [first, page()], before = structuredClone(pages);
  const next = applyLayoutToPages(pages, { ...layout, width_mm: 100, height_mm: 150 }, [0]);
  assert.equal(next[0].document.strokes, first.document.strokes); assert.equal(next[1], pages[1]);
  assert.equal(next[0].layout_id, layout.id); assert.equal(next[0].document.text_settings.text, "保留");
  assert.equal(next[0].document.text_settings.font_size_mm, 10);
  assert.deepEqual(next[0].background.guide_lines[0], { id: "line-1", start: [5, 10], end: [95, 10] });
  assert.equal(next[0].background.height_mm, 150); assert.deepEqual(pages, before);
  assert.equal(applyLayoutToPages([{ ...page(), background: { path: "", page: 1, page_count: 1, data_url: "" } }], layout, [0])[0].background.path, "");
});

test("boundary and malformed background rejection is atomic and identifies pages", () => {
  const pages = [page(), page()]; pages[1].document.strokes[0][1].x = 199;
  const before = structuredClone(pages);
  assert.throws(() => applyLayoutToPages(pages, { ...layout, width_mm: 100 }, [0, 1]), /第 2 页/);
  assert.deepEqual(pages, before);
  assert.throws(() => applyLayoutToPages(pages, layout, [2]), /不存在/);
  pages[1].background = { path: "paper.pdf", page: 1, page_count: 1, data_url: "", width_mm: 190, height_mm: 300 };
  assert.equal(applyLayoutToPages(pages, layout, [0, 1])[1].background.width_mm, 200, "legacy target-size copies are ignored");
  pages[1].background.guide_lines = [{ id: "line-1", start: [10, 20], end: [210, 20] }];
  assert.throws(() => applyLayoutToPages(pages, layout, [0, 1]), /第 2 页.*横线/);
});

test("space width travels with the layout and rejects impossible values", () => {
  const pages = [{ ...page(), layout_id: layout.id }];
  pages[0].document.text_settings = { text: "a b", font_mode: "glyph", font_path: "", glyph_path: "", legacy_selection: [], legacy_percent: 100, legacy_baseline: 1, legacy_seed: 1, centerline: false, placement: "lines", start_line: 0, offset: 0, font_size_mm: 10, letter_spacing_mm: 1, space_mm: 3.5 };
  const kept = applyLayoutToPages(pages, { ...layout, space_mm: 3.5 }, [0]);
  assert.equal(kept[0].document.text_settings.space_mm, 3.5);
  const cleared = applyLayoutToPages(pages, { ...layout }, [0]);
  assert.equal("space_mm" in cleared[0].document.text_settings, true, "未设置时不覆盖页面已有值");
  assert.throws(() => applyLayoutToPages(pages, { ...layout, space_mm: -1 }, [0]), /文字参数/);
  assert.throws(() => applyLayoutToPages(pages, { ...layout, space_mm: 60 }, [0]), /文字参数/);
  assert.equal(applyLayoutToPages(pages, { ...layout, space_mm: 0 }, [0])[0].document.text_settings.space_mm, 0);
});

test('virtual guides fill the layout evenly and honour an explicit line gap', () => {
  const template = { width_mm: 210, height_mm: 297, margin_mm: 15, font_size_mm: 7.5, lines: 18 };
  const auto = virtualTextGuides(template, null);
  assert.equal(auto.length, 18);
  assert.deepEqual(auto[0].start, [15, 22.5]);
  assert.equal(auto[0].end[0], 195);
  for (let i = 1; i < auto.length; i++) {
    const gap = auto[i].start[1] - auto[i - 1].start[1];
    assert.ok(Math.abs(gap - (auto[1].start[1] - auto[0].start[1])) < 1e-9, "等距");
  }
  const tight = virtualTextGuides(template, 10);
  assert.equal(tight.length, 15);
  assert.ok(Math.abs((tight[1].start[1] - tight[0].start[1]) - 17.5) < 1e-9);
  assert.ok(tight.at(-1).start[1] <= 297 - 15, "末行不越出下边距");
});
