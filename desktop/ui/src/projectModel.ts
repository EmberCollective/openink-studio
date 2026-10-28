import type { Drawing } from "./editorGeometry";
import type { RegistrationProfile, RegistrationSetup } from "./RegistrationPanel";
import type { Registration } from "./coordinateGeometry";
import { backgroundSnapshot, type BackgroundPage } from "./paperModel";
import type { Layout } from "./layoutGeometry";

export type Project = {
  pages: { document: Drawing & { route_optimized?: boolean }; background: BackgroundPage | null; layout_id?: string }[];
  layouts?: Layout[];
  current_page: number;
  template: { id: string; name: string; description: string; width_mm: number; height_mm: number; margin_mm: number; font_size_mm: number; letter_spacing_mm: number; lines: number };
  writing: { feed: number; travel_feed: number; z_feed: number; z_down: number; jog_step: number };
  routing: { optimize: boolean; allow_reverse: boolean; allow_gap: boolean; max_gap: number; deduplicate: boolean };
  calibration: RegistrationSetup & { origin: number[] | null; registration: Registration; profiles: RegistrationProfile[] };
  conversion: { dpi: number; threshold: number; conservative: boolean; tolerance_mm: number; filter_iterations: number; error_threshold: number; line_threshold: number; despeckle_level: number };
  background_visible: boolean;
  show_margins: boolean;
};

export function emptyPage(width: number, height: number): Drawing {
  return { name: "组合画布", width_mm: width, height_mm: height, strokes: [], materials: [], strokeOwners: [] };
}

export function projectPages(current: Drawing, index: number, saved: ReadonlyMap<number, Drawing>, backgrounds: (Project["pages"][number]["background"] | undefined)[], width: number, height: number): Project["pages"] {
  const count = Math.max(1, index + 1, backgrounds.length, ...[...saved.keys()].map(i => i + 1));
  return Array.from({ length: count }, (_, i) => {
    const bg = backgrounds[i];
    return {
      document: i === index ? current : saved.get(i) || emptyPage(width, height),
      // PDF rendering also returns dimensions; only protocol fields belong in the archive.
      background: backgroundSnapshot(bg || undefined),
    };
  });
}
