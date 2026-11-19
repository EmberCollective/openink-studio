/**
 * 本机应用设置。
 *
 * 工程文件只保存版面、工艺与书写参数；Python / AutoTrace 路径和转换默认值
 * 属于这台机器，换工程不该丢，因此单独保存在本机 localStorage。
 * 所有读取都做范围校验：损坏或被手改过的数据回落到默认值，不会带进转换流程。
 */

export const APP_SETTINGS_KEY = "openink-app-settings-v1";

export type WritingSettings = {
  feed: number;
  travel_feed: number;
  z_feed: number;
  z_down: number;
  jog_step: number;
};

export type AppSettings = {
  python_path: string;
  autotrace_path: string;
  dpi: number;
  tolerance_mm: number;
  writing: WritingSettings;
  /** 本子横放时，编辑视图保持正向显示；不改变纸张摆放角度。 */
  straighten_edit_view: boolean;
  /** 生成文字时把字包字形底部吸附到基准线。 */
  auto_baseline: boolean;
  /** OpenInk 字包排版：让同一个字每次出现略有不同。 */
  stroke_variation_enabled: boolean;
  /** 逐笔画随机拉伸强度（百分比，0–15）；仅开关打开时生效。 */
  stroke_variation_percent: number;
  /** 笔锋（仅 OpenInk 字包）：靠路径几何模拟起收笔的锋，笔尖宽度本身不变。 */
  stroke_tip_enabled: boolean;
  /** outline = 两端收尖的闭合轮廓；taper = 单线起收笔尖角。 */
  stroke_tip_style: "outline" | "taper";
  stroke_tip_width_mm: number;
  /** 起锋 / 收锋长度占笔画全长的比例 0–0.5。 */
  stroke_tip_start: number;
  stroke_tip_end: number;
};

export type SettingsStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** 与 Rust 侧 ImportOptions::default 及书写面板初值保持一致。 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  python_path: "python",
  autotrace_path: "",
  dpi: 300,
  tolerance_mm: 0.02,
  writing: { feed: 1500, travel_feed: 2500, z_feed: 3000, z_down: 4, jog_step: 1 },
  straighten_edit_view: false,
  auto_baseline: true,
  stroke_variation_enabled: false,
  stroke_variation_percent: 12,
  stroke_tip_enabled: false,
  stroke_tip_style: "outline",
  stroke_tip_width_mm: 0.5,
  stroke_tip_start: 0.18,
  stroke_tip_end: 0.25,
};

const JOG_STEPS = [0.1, 0.5, 1, 5, 10];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** 路径为空表示“用默认”，保留空串以便回落；非字符串一律回落。 */
function path(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const root = record(value), writing = record(root.writing), defaults = DEFAULT_APP_SETTINGS;
  return {
    python_path: path(root.python_path, defaults.python_path),
    autotrace_path: path(root.autotrace_path, defaults.autotrace_path),
    dpi: Math.round(bounded(root.dpi, 36, 1200, defaults.dpi)),
    tolerance_mm: bounded(root.tolerance_mm, 0.005, 1, defaults.tolerance_mm),
    writing: {
      feed: Math.round(bounded(writing.feed, 1, 100000, defaults.writing.feed)),
      travel_feed: Math.round(bounded(writing.travel_feed, 1, 100000, defaults.writing.travel_feed)),
      z_feed: Math.round(bounded(writing.z_feed, 1, 100000, defaults.writing.z_feed)),
      z_down: bounded(writing.z_down, 0.1, 50, defaults.writing.z_down),
      jog_step: JOG_STEPS.includes(bounded(writing.jog_step, -1, 100, defaults.writing.jog_step))
        ? bounded(writing.jog_step, -1, 100, defaults.writing.jog_step)
        : defaults.writing.jog_step,
    },
    straighten_edit_view: typeof root.straighten_edit_view === "boolean"
      ? root.straighten_edit_view : defaults.straighten_edit_view,
    auto_baseline: typeof root.auto_baseline === "boolean"
      ? root.auto_baseline : defaults.auto_baseline,
    stroke_variation_enabled: typeof root.stroke_variation_enabled === "boolean"
      ? root.stroke_variation_enabled : defaults.stroke_variation_enabled,
    stroke_variation_percent: bounded(root.stroke_variation_percent, 0, 15, defaults.stroke_variation_percent),
    stroke_tip_enabled: typeof root.stroke_tip_enabled === "boolean"
      ? root.stroke_tip_enabled : defaults.stroke_tip_enabled,
    stroke_tip_style: root.stroke_tip_style === "taper" ? "taper" : "outline",
    stroke_tip_width_mm: bounded(root.stroke_tip_width_mm, 0.05, 2, defaults.stroke_tip_width_mm),
    stroke_tip_start: bounded(root.stroke_tip_start, 0, 0.5, defaults.stroke_tip_start),
    stroke_tip_end: bounded(root.stroke_tip_end, 0, 0.5, defaults.stroke_tip_end),
  };
}

function defaultStorage(): SettingsStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // 隐私模式或存储被策略禁用时，退化为“不持久化”，不影响主流程。
    return null;
  }
}

export function readAppSettings(storage?: SettingsStorage | null): AppSettings {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return DEFAULT_APP_SETTINGS;
  try {
    const raw = store.getItem(APP_SETTINGS_KEY);
    return raw ? normalizeAppSettings(JSON.parse(raw)) : DEFAULT_APP_SETTINGS;
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function writeAppSettings(settings: AppSettings, storage?: SettingsStorage | null): boolean {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return false;
  try {
    store.setItem(APP_SETTINGS_KEY, JSON.stringify(normalizeAppSettings(settings)));
    return true;
  } catch {
    return false;
  }
}
