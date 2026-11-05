export const rangeFields = [
  ["size", "随机大小", "%", 50, 150, 100], ["spacing", "随机字间距", "%", 0, 200, 100],
  ["rotation", "随机旋转", "°", -180, 180, 0], ["stretch_x", "水平拉伸", "%", 50, 150, 100],
  ["stretch_y", "垂直拉伸", "%", 50, 150, 100], ["vertical", "上下随机偏移", "mm", -20, 20, 0], ["horizontal", "水平随机偏移", "mm", -20, 20, 0],
] as const;
export const scalarFields = [["baseline", "基准线偏移（正值向上）", -20], ["left", "左留白", -20], ["right", "右留白", -20]] as const;
export type CharacterRule = Partial<Record<typeof rangeFields[number][0], [number, number]>> & Partial<Record<typeof scalarFields[number][0], number>>;
export type FontRule = { id: string; name: string; general: CharacterRule; overrides: { characters: string; settings: CharacterRule }[]; first_offset: [number, number]; wave_amplitude: [number, number]; wave_length: [number, number] };
export type FontRuleLibrary = { rules: FontRule[]; selected: string };
export const newFontRule = (id: string, name = "新规则集"): FontRule => ({ id, name, general: {}, overrides: [], first_offset: [0, 0], wave_amplitude: [0, 0], wave_length: [20, 20] });
export function legacyFontRule(jitter: Record<string, number | undefined> | undefined): FontRule | null {
  if (!jitter || Object.values(jitter).every(v => !v)) return null;
  const rule = newFontRule("", "原有抖动");
  for (const [from, to, base] of [["x_mm", "horizontal", 0], ["y_mm", "vertical", 0], ["rotation_deg", "rotation", 0], ["scale_x_percent", "stretch_x", 100], ["scale_y_percent", "stretch_y", 100], ["scale_percent", "size", 100]] as const) {
    const max = jitter[from] || 0;
    rule.general[to] = [(jitter[`${from}_min`] ?? -max) + base, max + base];
  }
  return rule;
}
export function ruleError(rule: FontRule): string {
  if (!rule || typeof rule.id !== "string" || !rule.id || rule.id.length > 100 || typeof rule.name !== "string" || !rule.name.trim() || [...rule.name].length > 80) return "请输入规则名称（最多 80 字）";
  const interval = (v: unknown, min: number, max: number) => Array.isArray(v) && v.length === 2 && v.every(n => Number.isFinite(n) && n >= min && n <= max) && v[0] <= v[1];
  const settings = (v: CharacterRule) => !!v && typeof v === "object" && Object.keys(v).every(k => [...rangeFields.map(f => f[0]), ...scalarFields.map(f => f[0])].includes(k as never)) && rangeFields.every(([key, , , min, max]) => v[key] === undefined || interval(v[key], min, max)) && scalarFields.every(([key, , min]) => v[key] === undefined || (Number.isFinite(v[key]) && v[key]! >= min && v[key]! <= 20));
  if (!settings(rule.general) || !Array.isArray(rule.overrides) || rule.overrides.length > 100) return "通用规则范围或字符规则数量无效";
  const seen = new Set<string>();
  for (const item of rule.overrides) {
    if (!item || typeof item.characters !== "string" || !item.characters || [...item.characters].length > 500 || !settings(item.settings)) return "请填写适用字符并检查范围";
    for (const ch of item.characters) { if (seen.has(ch) || /[\u0000-\u001f\u007f-\u009f]/u.test(ch)) return "字符重复或包含换行，请检查字符规则"; seen.add(ch); }
  }
  return interval(rule.first_offset, 0, 20) && interval(rule.wave_amplitude, 0, 20) && interval(rule.wave_length, 1, 500) ? "" : "整行设置范围无效；下限不能大于上限";
}
export function validRuleLibrary(value: unknown): value is FontRuleLibrary {
  const v = value as FontRuleLibrary;
  return !!v && Array.isArray(v.rules) && v.rules.length <= 50 && v.rules.every(r => !ruleError(r)) && new Set(v.rules.map(r => r.id)).size === v.rules.length && (v.selected === "" || v.rules.some(r => r.id === v.selected));
}
export function scalarSelection(text: string, start: number, end: number): [number, number] | null {
  if (start < 0 || end > text.length || start >= end || !Number.isInteger(start) || !Number.isInteger(end)) return null;
  const splitsSurrogate = (i: number) => i > 0 && i < text.length && /[\uD800-\uDBFF]/u.test(text[i - 1]) && /[\uDC00-\uDFFF]/u.test(text[i]);
  return splitsSurrogate(start) || splitsSurrogate(end) ? null : [[...text.slice(0, start)].length, [...text.slice(0, end)].length];
}
