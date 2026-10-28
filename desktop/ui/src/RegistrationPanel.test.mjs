import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const geometry = {};
new Function("exports", ts.transpileModule(readFileSync(new URL("./coordinateGeometry.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(geometry);

function harness(overrides = {}) {
  const slots = [], effects = [], commands = [], locks = [], saved = [];
  let cursor = 0, dirty = false, tree;
  const hook = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], value => { const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++; if (!slots[i] || deps.some((d, n) => !Object.is(d, slots[i][n]))) { slots[i] = deps; effects.push(effect); } },
  };
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL("./RegistrationPanel.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("require", "exports", code)(name => name === "react" ? hook : name === "./coordinateGeometry" ? geometry : name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "fragment" } : { DraftNumberInput: "draft-number" }, exports);
  const props = { travelFeed: 2300, width: 210, height: 297, origin: null, registration: { scale: 1, rotation_deg: 0 }, profiles: [], ready: true, positioning: false, calibrationVersion: 0, sessionVersion: 0, onCommand: async command => { commands.push(command); return true; }, onLock: value => locks.push(value), onSave: async p => saved.push(p), ...overrides };
  function render(patch = {}) { Object.assign(props, patch); let count = 0; do { dirty = false; cursor = 0; tree = exports.RegistrationPanel(props); effects.splice(0).forEach(f => f()); assert.ok(++count < 20, "render settles"); } while (dirty); return tree; }
  function nodes(node) { if (!node || typeof node !== "object") return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...nodes(node.props?.children)]; }
  function text(node) { if (Array.isArray(node)) return node.map(text).join(""); if (node && typeof node === "object") return text(node.props?.children); return node == null ? "" : String(node); }
  const button = label => nodes(tree).find(n => n.type === "button" && text(n).includes(label));
  render();
  return { props, render, nodes: () => nodes(tree), button, commands, locks, saved };
}

test("untouched defaults track loaded page and origin; custom numbers commit through draft input", () => {
  const h = harness();
  h.render({ width: 300, height: 400, origin: [200, 30] });
  const fields = () => h.nodes().filter(n => n.type === "draft-number");
  assert.deepEqual(fields().map(n => n.props.value), [200, 30, 15, 385]);
  fields()[0].props.onChange({ target: { value: "175" } });
  h.render({ origin: [190, 40] });
  assert.deepEqual(fields().map(n => n.props.value), [175, 30, 15, 385]);
});

test("begin waits for confirmed calibration and idle before moving; finish unlocks only on result", async () => {
  const h = harness();
  await h.button("确认并移向第二点").props.onClick(); h.render();
  assert.equal(h.commands.length, 1);
  h.render({ calibrationVersion: 2, positioning: true, ready: false });
  assert.equal(h.commands.length, 1);
  h.render({ positioning: false, ready: true }); await Promise.resolve(); h.render();
  assert.equal(h.commands[1].type, "move_to"); assert.equal(h.commands[1].feed, 2300);
  await h.button("完成校准").props.onClick(); h.render();
  assert.equal(h.commands[2].type, "finish_registration");
  assert.equal(h.locks.at(-1), true);
  h.render({ calibrationVersion: 3, registration: { scale: 1.02, rotation_deg: 3 } });
  assert.equal(h.locks.at(-1), false);
  assert.equal(h.button("保存校准方案"), undefined);
  assert.equal(h.button("应用方案"), undefined);
  h.render({ calibrationVersion: 4 });
  assert.equal(h.button("保存校准方案"), undefined);
});

test("begin and near-point move rejection unlock; session loss cancels wizard", async () => {
  const begin = harness({ onCommand: async () => false });
  await begin.button("确认并移向第二点").props.onClick(); begin.render();
  assert.equal(begin.locks.at(-1), false);
  let calls = 0;
  const move = harness({ onCommand: async () => ++calls === 1 });
  await move.button("确认并移向第二点").props.onClick(); move.render({ calibrationVersion: 2 });
  await Promise.resolve(); move.render();
  assert.equal(move.locks.at(-1), false);
  const lost = harness();
  await lost.button("确认并移向第二点").props.onClick(); lost.render({ sessionVersion: 1, ready: false });
  assert.equal(lost.locks.at(-1), false);
});

test("reopened project preserves axis scales when starting two-point rotation calibration", async () => {
  const h = harness({ preserveScale: true, registration: { scale: 1, rotation_deg: 0, matrix: [0.8, 0, 0, 1.2] } });
  await h.button("确认并移向第二点").props.onClick();
  assert.deepEqual(h.commands[0].preserve_scale, [0.8, 1.2]);
});

test("legacy setup restores points without profile controls or machine commands", () => {
  const h = harness({ restoreSetup: { version: 1, value: { points: [[190,20],[20,270]], show_points: true, selected_profile: "old" } } });
  assert.equal(h.commands.length, 0);
  assert.deepEqual(h.nodes().filter(n => n.type === "draft-number").map(n => n.props.value), [190,20,20,270]);
  assert.equal(h.button("应用方案"), undefined);
});
