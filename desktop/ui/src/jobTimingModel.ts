export type JobTimingState = { epoch: number | null; phase: "idle" | "pending" | "running" | "paused" | "completed" | "cancelled"; elapsedMs: number; resumedAt: number | null; totalSeconds: number | null; cumulative: number[]; sent: number; ackedAll: boolean };
export const emptyJobTiming: JobTimingState = { epoch: null, phase: "idle", elapsedMs: 0, resumedAt: null, totalSeconds: null, cumulative: [], sent: 0, ackedAll: false };
export const beginJobTiming = (epoch: number): JobTimingState => ({ ...emptyJobTiming, epoch, phase: "pending" });
export function elapsedSeconds(state: JobTimingState, now: number) {
  return (state.elapsedMs + (state.resumedAt === null ? 0 : Math.max(0, now - state.resumedAt))) / 1000;
}
export function cancelJobTiming(state: JobTimingState, now: number): JobTimingState {
  if (state.phase === "idle" || state.phase === "completed" || state.phase === "cancelled") return state;
  return { ...state, phase: "cancelled", elapsedMs: elapsedSeconds(state, now) * 1000, resumedAt: null };
}
export type TimingEvent = { type: string; total_seconds?: number; cumulative_seconds?: number[]; sent?: number; total?: number; paused?: boolean; running?: boolean };
export function updateJobTiming(state: JobTimingState, event: TimingEvent, now: number, epoch: number): JobTimingState {
  if (state.epoch !== epoch || !["pending", "running", "paused"].includes(state.phase)) return state;
  switch (event.type) {
    case "timing": {
      if (state.phase !== "pending" || state.totalSeconds !== null || !Number.isFinite(event.total_seconds) || event.total_seconds! < 0 || !Array.isArray(event.cumulative_seconds)) return state;
      const cumulative = event.cumulative_seconds;
      if (cumulative.some((value, index) => !Number.isFinite(value) || value < 0 || (index > 0 && value < cumulative[index - 1]) || value > event.total_seconds! + .001)) return state;
      return { ...state, totalSeconds: event.total_seconds!, cumulative: [...cumulative] };
    }
    case "job_started": return state.phase === "pending" ? { ...state, phase: "running", resumedAt: now } : state;
    case "progress": return { ...state, sent: Math.max(state.sent, event.sent || 0), ackedAll: state.ackedAll || (!!event.total && (event.sent || 0) >= event.total) };
    case "paused":
      if (event.paused && state.phase === "running") return { ...state, phase: "paused", elapsedMs: elapsedSeconds(state, now) * 1000, resumedAt: null };
      if (!event.paused && state.phase === "paused") return { ...state, phase: "running", resumedAt: now };
      return state;
    case "completed": return { ...state, phase: "completed", elapsedMs: elapsedSeconds(state, now) * 1000, resumedAt: null };
    case "stopped": case "disconnected": return cancelJobTiming(state, now);
    case "job_rejected": return event.running ? state : cancelJobTiming(state, now);
    default: return state;
  }
}
export function remainingSeconds(state: JobTimingState, now: number): number | null {
  if (state.phase === "completed") return 0;
  if (state.phase === "cancelled" || state.totalSeconds === null) return null;
  const acknowledgedSeconds = state.cumulative[Math.min(state.sent, state.cumulative.length) - 1] || 0;
  return Math.max(0, state.totalSeconds - elapsedSeconds(state, now), state.totalSeconds - acknowledgedSeconds);
}
