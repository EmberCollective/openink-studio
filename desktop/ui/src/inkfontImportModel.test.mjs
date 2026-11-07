import test from "node:test";
import assert from "node:assert/strict";
import { emptyImportHistory, recordImport, travelImport, sourceKey, clampCrop, neighborhood, glyphPageTransform } from "./inkfontImportModel.ts";

const options = { page: 1, dpi: 300, threshold: 180, conservative: false, python_path: "python", autotrace_path: "autotrace", tolerance_mm: .05, filter_iterations: 4, error_threshold: 2, line_threshold: 1, despeckle_level: 0 };
const snapshot = (character, page = 1) => ({ source: { path: "notes.pdf", models: "models", options: { ...options, page } }, result: { width: 600, height: 800, page, page_count: 2, image_data_url: "page", candidates: [{ id: "one", character, bounds: [10, 20, 30, 50], strokes: [[{ x: 20, y: 30 }, { x: 90, y: 80 }]], confirmed: false }] } });

test("undo and redo restore the complete calibration snapshot, including its source page", () => {
  const empty = emptyImportHistory(), first = snapshot("字"), corrected = snapshot("永"), anotherPage = snapshot("风", 2);
  assert.equal(travelImport(empty), empty);
  assert.equal(travelImport(empty, true), empty);
  let history = recordImport(recordImport(recordImport(empty, first), corrected), anotherPage);
  history = travelImport(history);
  assert.deepEqual(history.present, corrected);
  assert.equal(history.present.source.options.page, 1);
  assert.deepEqual(history.future, [anotherPage]);
  history = travelImport(history);
  assert.deepEqual(history.present, first);
  assert.equal(travelImport(history), history);
  history = travelImport(travelImport(history, true), true);
  assert.deepEqual(history.present, anotherPage);
  assert.equal(history.present.result.page, 2);
  assert.equal(travelImport(history, true), history);
});

test("a new correction after undo invalidates redo; a no-op preserves it", () => {
  const initial = snapshot("字"), oldCorrection = snapshot("宇"), newCorrection = snapshot("永");
  const undone = travelImport(recordImport(recordImport(emptyImportHistory(), initial), oldCorrection));
  assert.equal(recordImport(undone, initial), undone);
  const branched = recordImport(undone, newCorrection);
  assert.deepEqual(branched.future, []);
  assert.equal(travelImport(branched, true), branched);
  assert.deepEqual(travelImport(branched).present, initial);
  assert.deepEqual(undone.future, [oldCorrection]);
});

test("history retains the latest 100 reversible edits without losing the current result", () => {
  let history = emptyImportHistory();
  for (let i = 0; i <= 120; i++) history = recordImport(history, snapshot(String(i)));
  assert.equal(history.past.length, 100);
  assert.equal(history.present.result.candidates[0].character, "120");
  for (let i = 0; i < 120; i++) history = travelImport(history);
  assert.equal(history.present.result.candidates[0].character, "20");
  assert.equal(history.future.length, 100);
});

test("source identity ignores property order but changes for page, trace settings and model/source paths", () => {
  const original = { path: "notes.pdf", options, models: "models" };
  const reordered = { models: "models", options: Object.fromEntries(Object.entries(options).reverse()), path: "notes.pdf" };
  assert.equal(sourceKey(original), sourceKey(reordered));
  for (const changed of [{ ...original, path: "another.pdf" }, { ...original, models: "other-models" }, { ...original, options: { ...options, page: 2 } }, { ...original, options: { ...options, threshold: 128 } }]) assert.notEqual(sourceKey(original), sourceKey(changed));
});

test("crop clamps oversized and off-page adjustments while retaining valid fractional coordinates", () => {
  assert.deepEqual(clampCrop([-10, -20, 800, 900], 600, 800), [0, 0, 600, 800]);
  assert.deepEqual(clampCrop([700, 900, 50, 60], 600, 800), [599, 799, 1, 1]);
  assert.deepEqual(clampCrop([20, 30, -5, 0], 600, 800), [20, 30, 1, 1]);
  assert.deepEqual(clampCrop([10.25, 20.75, 30.1, 40.2], 600, 800), [10.25, 20.75, 30.1, 40.2]);
  assert.deepEqual(clampCrop([0, 0, 30, 40], 1, 1), [0, 0, 1, 1]);
});

test("context view stays inside the page at all edges and includes the selected glyph", () => {
  for (const crop of [[0, 0, 40, 60], [560, 0, 40, 60], [0, 740, 40, 60], [560, 740, 40, 60], [280, 370, 40, 60]]) {
    const [x, y, w, h] = neighborhood(crop, 600, 800);
    assert.equal(w, 144); assert.equal(h, 144);
    assert.ok(x >= 0 && y >= 0 && x + w <= 600 && y + h <= 800);
    assert.ok(x <= crop[0] && y <= crop[1] && x + w >= crop[0] + crop[2] && y + h >= crop[1] + crop[3]);
  }
  assert.deepEqual(neighborhood([0, 0, 600, 800], 600, 800), [0, 0, 600, 800]);
});

test("glyph overlay reverses six-pixel padding and non-square normalization", () => {
  const project = (bounds, point) => {
    const match = /^translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.e+]+)\)$/.exec(glyphPageTransform(bounds));
    assert.ok(match);
    return [Number(match[1]) + point[0] * Number(match[3]), Number(match[2]) + point[1] * Number(match[3])];
  };
  const close = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `${actual} != ${expected}`));
  assert.equal(glyphPageTransform([10, 20, 30, 50]), "translate(-6 14) scale(0.062)");
  close(project([10, 20, 30, 50], [16000 / 62, 6000 / 62]), [10, 20]);
  close(project([10, 20, 30, 50], [46000 / 62, 56000 / 62]), [40, 70]);
  assert.equal(glyphPageTransform([10.25, 20.75, 30.1, 50.2]), "translate(-6 14) scale(0.063)");
  close(project([10.25, 20.75, 30.1, 50.2], [16250 / 63, 6750 / 63]), [10.25, 20.75]);
  close(project([0, 0, 20, 20], [187.5, 187.5]), [0, 0]);
});
