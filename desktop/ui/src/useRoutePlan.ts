import { useEffect, useRef, useState } from "react";
import { measureRoute } from "./routeMetrics";
export type RoutePoint = { x: number; y: number };
export type RouteDocument = { name: string; width_mm: number; height_mm: number; strokes: RoutePoint[][]; materials?: { id: string; name: string; kind: string }[]; strokeOwners?: string[] };
export type RouteRequest = { document: RouteDocument; start: RoutePoint | null; allow_reverse: boolean; travel_feed_mm_min: number; optimize?: boolean; metric_matrix?: [number, number, number, number] };
export type RouteResult = { document: RouteDocument; stroke_order: number[]; before_distance_mm: number; after_distance_mm: number; before_travel_seconds: number; after_travel_seconds: number };
export type RouteSnapshot = RouteResult & { key: string; start: RoutePoint | null };
function originalRoute(request: RouteRequest): RouteResult {
  let previous = request.start, distance = 0;
  for (const stroke of request.document.strokes) {
    if (stroke.length < 2) continue;
    if (previous) distance += Math.hypot(stroke[0].x - previous.x, stroke[0].y - previous.y);
    previous = stroke[stroke.length - 1];
  }
  const seconds = distance / request.travel_feed_mm_min * 60;
  return { document: request.document, stroke_order: request.document.strokes.map((_, index) => index), before_distance_mm: distance, after_distance_mm: distance, before_travel_seconds: seconds, after_travel_seconds: seconds };
}

/** Exact input cache. Failed requests are removed so an explicit retry can recover. */
export function createRoutePlanner(compute: (request: RouteRequest) => Promise<RouteResult>) {
  const pending = new Map<string, Promise<RouteSnapshot>>();
  return (request: RouteRequest): Promise<RouteSnapshot> => {
    const key = JSON.stringify(request);
    const existing = pending.get(key);
    if (existing) return existing;
    const result = (request.optimize === false ? Promise.resolve(originalRoute(request)) : compute(request)).then((result) => {
      if (request.metric_matrix) {
        const before = measureRoute(request.document, request.start, request.metric_matrix).travel;
        const after = measureRoute(result.document, request.start, request.metric_matrix).travel;
        result = { ...result, before_distance_mm: before, after_distance_mm: after, before_travel_seconds: before / request.travel_feed_mm_min * 60, after_travel_seconds: after / request.travel_feed_mm_min * 60 };
      }
      return { ...result, document: { ...result.document, materials: request.document.materials, strokeOwners: result.stroke_order.map((i) => request.document.strokeOwners?.[i] || "") }, key, start: request.start };
    });
    pending.set(key, result);
    result.catch(() => pending.delete(key));
    // Retain only a small number of recent geometries, including in-flight requests.
    if (pending.size > 4) pending.delete(pending.keys().next().value!);
    return result;
  };
}

export function useRoutePlan(request: RouteRequest | null, compute: (request: RouteRequest) => Promise<RouteResult>, frozen: boolean) {
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const planner = useRef<ReturnType<typeof createRoutePlanner>>();
  if (!planner.current) planner.current = createRoutePlanner((input) => computeRef.current(input));
  const key = request ? JSON.stringify(request) : "";
  const latest = useRef(key);
  latest.current = key;
  const [state, setState] = useState<{ status: "idle" | "planning" | "ready" | "error"; snapshot?: RouteSnapshot; error?: string }>({ status: "idle" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (frozen) return;
    if (!request?.document.strokes.some((s) => s.length > 1)) { setState({ status: "idle" }); return; }
    let cancelled = false;
    setState({ status: "planning" });
    const timer = setTimeout(() => {
      planner.current!(request).then((snapshot) => {
        if (!cancelled && latest.current === key) setState({ status: "ready", snapshot });
      }, (error) => {
        if (!cancelled && latest.current === key) setState({ status: "error", error: String(error) });
      });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, frozen, revision]);
  return { ...state, snapshot: state.snapshot?.key === key ? state.snapshot : undefined, ensure: planner.current, recompute: () => setRevision((n) => n + 1) };
}
