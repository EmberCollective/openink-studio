import test from "node:test";
import assert from "node:assert/strict";
import { inkCanvas, inkWritingMetrics, newInkPackage, newInkVariant, previewInkText, replaceVariant, variantError } from "./inkfont.ts";

const glyph = (character, x = 1) => ({ ...newInkVariant(character), strokes: [[{ x, y: 1 }, { x: x + 1, y: 2 }]] });
test("saved canvas accepts its whole area independently of original writing dimensions", () => {
  const narrow = { ...glyph('"'), width_mm: 3, height_mm: 20, advance_mm: 3 };
  const canvas = inkCanvas(narrow);
  assert.deepEqual(canvas, { x: -8.5, y: 0, width: 20, height: 20 });
  assert.deepEqual(inkWritingMetrics({ ...narrow, canvas }), inkWritingMetrics(narrow));
  const expanded = { ...narrow, canvas, strokes: [[{ x: -8.5, y: 0 }, { x: 11.5, y: 20 }]] };
  assert.equal(variantError(expanded), "");
  assert.equal(variantError(JSON.parse(JSON.stringify(expanded))), "");
  assert.ok(variantError({ ...expanded, strokes: [[{ x: -8.6, y: 0 }, { x: 11.5, y: 20 }]] }));
  assert.ok(variantError({ ...expanded, canvas: { ...canvas, x: Infinity } }));
  assert.deepEqual(inkCanvas(expanded), canvas);
});
test("writing metrics retain left bearing, em height and punctuation size without mutating source", () => {
  const letter = { ...glyph("字"), strokes: [[{ x: 2, y: 2 }, { x: 18, y: 18 }]] };
  const punctuation = { ...glyph("。"), strokes: [[{ x: 2, y: 15 }, { x: 4, y: 17 }]] };
  const source = structuredClone([letter, punctuation]);
  assert.deepEqual(inkWritingMetrics(letter), { x: 0, width: 18, height: 20 });
  assert.deepEqual(inkWritingMetrics(punctuation), { x: 0, width: 4, height: 20 });
  assert.equal(inkWritingMetrics(letter).width / inkWritingMetrics(punctuation).width, 4.5);
  assert.deepEqual([letter, punctuation], source);
  assert.deepEqual(inkWritingMetrics({ ...letter, strokes: [[{ x: -2, y: 3 }, { x: 8, y: 7 }]] }), { x: -2, width: 10, height: 20 });
  assert.deepEqual(inkWritingMetrics({ ...letter, strokes: [[{ x: 0, y: 3 }, { x: 0, y: 7 }]] }), { x: 0, width: 2, height: 20 });
});
test("save edits one identity, retaining same-character variants and allowing remapping", () => {
  const a = glyph("字"), b = glyph("字", 5), pack = { ...newInkPackage("测试"), variants: [a, b] };
  const next = replaceVariant(pack, { ...a, character: "永" });
  assert.equal(next.variants.length, 2);
  assert.equal(next.variants[0].character, "永");
  assert.deepEqual(next.variants[1], b);
  assert.equal(pack.variants[0].character, "字");
  assert.equal(replaceVariant(pack, glyph("字")).variants.length, 3);
});
test("random selection occurs per occurrence and freezes chosen geometry", () => {
  const a = glyph("字"), b = glyph("字", 5), pack = { ...newInkPackage("测试"), variants: [a, b] };
  const sequence = [0, .99, 0, .5];
  const result = previewInkText(pack, "字字字缺", () => sequence.shift());
  assert.deepEqual(result.map(v => v.variant?.id), [a.id, b.id, a.id, undefined]);
  assert.deepEqual(result.map(v => v.ordinal), [1, 2, 1, 1]);
  a.strokes[0][0].x = 900;
  assert.equal(result[0].variant.strokes[0][0].x, 1);
  pack.variants.length = 0;
  assert.equal(result[1].variant.id, b.id);
});
test("empty, whitespace, multiple characters and malformed strokes cannot save", () => {
  for (const character of ["", " ", "两个", "\u0000"]) assert.ok(variantError(glyph(character)));
  assert.ok(variantError(newInkVariant("字")));
  assert.ok(variantError({ ...glyph("字"), advance_mm: Infinity }));
  assert.ok(variantError({ ...glyph("字"), strokes: [[{ x: NaN, y: 0 }, { x: 1, y: 2 }]] }));
  assert.match(variantError({ ...glyph("字"), strokes: [[{ x: -1, y: 0 }, { x: 1, y: 2 }]] }), /超出画布/);
  assert.equal(variantError(glyph("𠮷")), "");
});
