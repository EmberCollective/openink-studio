import { canvasToMachine, type Registration } from "./coordinateGeometry";
import type { RouteDocument, RoutePoint } from "./useRoutePlan";
import type { RouteComparisonResult } from "./RouteComparison";

export function measureRoute(document: RouteDocument, start: RoutePoint | null, matrix: NonNullable<Registration["matrix"]>) {
  const registration = { scale: 1, rotation_deg: 0, matrix };
  const mapped = (point: RoutePoint) => canvasToMachine(point, [0, 0], registration);
  let previous = start ? mapped(start) : null, draw = 0, travel = 0;
  for (const stroke of document.strokes) {
    if (stroke.length < 2) continue;
    const points = stroke.map(mapped);
    if (previous) travel += Math.hypot(points[0].x - previous.x, points[0].y - previous.y);
    for (let i = 1; i < points.length; i++) draw += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    previous = points.at(-1)!;
  }
  return { draw, travel };
}

export function calibratedRouteComparison(result: RouteComparisonResult, matrix: NonNullable<Registration["matrix"]>, start: RoutePoint | null, feed: number, travelFeed: number, optimize: boolean): RouteComparisonResult {
  const variants = result.variants.map(variant => {
    const { draw, travel } = measureRoute(variant.document, start, matrix);
    // Retain the backend's Z/pen timing and replace only the planar distances.
    const seconds = variant.estimated_seconds + (draw - variant.draw_mm) / feed * 60 + (travel - variant.travel_mm) / travelFeed * 60;
    return { ...variant, draw_mm: draw, travel_mm: travel, estimated_seconds: seconds };
  });
  const baseline = variants.find(v => v.id === (optimize ? "current" : "original"))!;
  for (const variant of variants) variant.savings_percent = baseline.estimated_seconds > 0 ? (baseline.estimated_seconds - variant.estimated_seconds) / baseline.estimated_seconds * 100 : 0;
  const recommended = variants.filter(v => v.eligible && v.coverage_preserved && Number.isFinite(v.estimated_seconds) && v.estimated_seconds >= 0 && baseline.estimated_seconds > 0 && v.estimated_seconds <= baseline.estimated_seconds * .95)
    .sort((a, b) => a.estimated_seconds - b.estimated_seconds)[0]?.id || baseline.id;
  return { ...result, variants, recommended, calibrated: true };
}
