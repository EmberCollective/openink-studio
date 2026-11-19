import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const ts = createRequire(import.meta.url)("typescript"), api = {};
new Function("exports", ts.transpileModule(readFileSync(new URL("./appSettings.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(api);

function memory(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
  };
}

test("falls back to defaults when storage is empty, unusable or corrupted", () => {
  assert.deepEqual(api.readAppSettings(memory()), api.DEFAULT_APP_SETTINGS);
  assert.deepEqual(api.readAppSettings(memory({ [api.APP_SETTINGS_KEY]: "{not json" })), api.DEFAULT_APP_SETTINGS);
  assert.deepEqual(api.readAppSettings(null), api.DEFAULT_APP_SETTINGS);
  assert.equal(api.writeAppSettings(api.DEFAULT_APP_SETTINGS, null), false);
});

test("round-trips edited paths and writing parameters", () => {
  const store = memory();
  const edited = {
    python_path: "D:/py/python.exe",
    autotrace_path: "D:/tools/autotrace.exe",
    dpi: 600,
    tolerance_mm: 0.05,
    writing: { feed: 900, travel_feed: 3000, z_feed: 2500, z_down: 3.5, jog_step: 5 },
    straighten_edit_view: true,
    auto_baseline: false,
    stroke_variation_enabled: true,
    stroke_variation_percent: 10,
    stroke_tip_enabled: true,
    stroke_tip_style: "taper",
    stroke_tip_width_mm: 0.8,
    stroke_tip_start: 0.1,
    stroke_tip_end: 0.3,
  };
  assert.equal(api.writeAppSettings(edited, store), true);
  assert.deepEqual(api.readAppSettings(store), edited);
});

test("keeps an empty autotrace path so the runtime default still applies", () => {
  const settings = api.normalizeAppSettings({ python_path: "python", autotrace_path: "", dpi: 300, tolerance_mm: 0.02 });
  assert.equal(settings.autotrace_path, "");
  assert.equal(settings.python_path, "python");
});

test("clamps out-of-range numbers and drops values of the wrong type", () => {
  const settings = api.normalizeAppSettings({
    python_path: 42,
    autotrace_path: null,
    dpi: 9999,
    tolerance_mm: "0.5",
    writing: { feed: -5, travel_feed: "1200", z_feed: "abc", z_down: 99, jog_step: 2 },
    unknown_field: "ignored",
    straighten_edit_view: "yes",
  });
  assert.equal(settings.python_path, api.DEFAULT_APP_SETTINGS.python_path);
  assert.equal(settings.autotrace_path, api.DEFAULT_APP_SETTINGS.autotrace_path);
  assert.equal(settings.dpi, api.DEFAULT_APP_SETTINGS.dpi);
  assert.equal(settings.tolerance_mm, 0.5);
  assert.equal(settings.writing.feed, api.DEFAULT_APP_SETTINGS.writing.feed);
  assert.equal(settings.writing.travel_feed, 1200);
  assert.equal(settings.writing.z_feed, api.DEFAULT_APP_SETTINGS.writing.z_feed);
  assert.equal(settings.writing.z_down, api.DEFAULT_APP_SETTINGS.writing.z_down);
  assert.equal(settings.writing.jog_step, api.DEFAULT_APP_SETTINGS.writing.jog_step);
  assert.equal(settings.straighten_edit_view, false, "非布尔值回落默认");
});

test("jog step only accepts the values offered by the panel", () => {
  for (const step of [0.1, 0.5, 1, 5, 10]) {
    assert.equal(api.normalizeAppSettings({ writing: { jog_step: step } }).writing.jog_step, step);
  }
  assert.equal(api.normalizeAppSettings({ writing: { jog_step: 3 } }).writing.jog_step, 1);
});

test("stroke variation strength is clamped to the safe 0-15% range", () => {
  assert.equal(api.DEFAULT_APP_SETTINGS.stroke_variation_enabled, false);
  assert.equal(api.DEFAULT_APP_SETTINGS.stroke_variation_percent, 12);
  assert.equal(api.normalizeAppSettings({ stroke_variation_percent: 40 }).stroke_variation_percent, 12);
  assert.equal(api.normalizeAppSettings({ stroke_variation_percent: -3 }).stroke_variation_percent, 12);
  assert.equal(api.normalizeAppSettings({ stroke_variation_percent: 8 }).stroke_variation_percent, 8);
  assert.equal(api.normalizeAppSettings({ stroke_variation_enabled: "yes" }).stroke_variation_enabled, false);
});

test("stroke tip settings fall back to safe defaults", () => {
  assert.equal(api.DEFAULT_APP_SETTINGS.stroke_tip_enabled, false);
  assert.equal(api.DEFAULT_APP_SETTINGS.stroke_tip_style, "outline");
  assert.equal(api.normalizeAppSettings({ stroke_tip_style: "weird" }).stroke_tip_style, "outline");
  assert.equal(api.normalizeAppSettings({ stroke_tip_style: "taper" }).stroke_tip_style, "taper");
  assert.equal(api.normalizeAppSettings({ stroke_tip_width_mm: 9 }).stroke_tip_width_mm, 0.5);
  assert.equal(api.normalizeAppSettings({ stroke_tip_start: 0.9 }).stroke_tip_start, 0.18);
  assert.equal(api.normalizeAppSettings({ stroke_tip_end: -1 }).stroke_tip_end, 0.25);
});

test("a throwing storage never breaks startup or saving", () => {
  const hostile = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.deepEqual(api.readAppSettings(hostile), api.DEFAULT_APP_SETTINGS);
  assert.equal(api.writeAppSettings(api.DEFAULT_APP_SETTINGS, hostile), false);
});

test("editing view preference survives a restart and accepts only booleans", () => {
  const store = memory();
  assert.equal(api.writeAppSettings({ ...api.DEFAULT_APP_SETTINGS, straighten_edit_view: true }, store), true);
  assert.equal(api.readAppSettings(store).straighten_edit_view, true);
  assert.equal(api.normalizeAppSettings({ straighten_edit_view: true }).straighten_edit_view, true);
  assert.equal(api.normalizeAppSettings({ straighten_edit_view: 1 }).straighten_edit_view, false);
  assert.equal(api.normalizeAppSettings({ auto_baseline: "yes" }).auto_baseline, true, "非布尔值回落默认");
  assert.equal(api.DEFAULT_APP_SETTINGS.straighten_edit_view, false);
  assert.equal(api.DEFAULT_APP_SETTINGS.auto_baseline, true, "默认自动对齐基准线");
});
