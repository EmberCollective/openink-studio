import { useEffect, useState } from "react";
import { elapsedSeconds, remainingSeconds, type JobTimingState } from "./jobTimingModel";
function duration(seconds: number | null) {
  if (seconds === null) return "—";
  const rounded = Math.ceil(Math.max(0, seconds));
  return rounded >= 60 ? `${Math.floor(rounded / 60)} 分 ${rounded % 60} 秒` : `${rounded} 秒`;
}
export function JobTiming({ state }: { state: JobTimingState }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (state.phase !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.phase, state.epoch]);
  if (state.phase === "idle") return null;
  const elapsed = elapsedSeconds(state, now), remaining = remainingSeconds(state, now);
  const waiting = state.phase === "running" && (state.ackedAll || remaining === 0);
  return <div className="job-timing" aria-label="任务时间估算">
    <div><span>预计总耗时</span><strong>{duration(state.totalSeconds)}</strong></div>
    <div><span>已用</span><strong>{duration(elapsed)}</strong></div>
    <div><span>预计剩余</span><strong>{state.phase === "cancelled" ? "已取消" : duration(remaining)}</strong></div>
    <p role="status">{state.phase === "pending" ? "等待任务开始" : state.phase === "paused" ? "已暂停，计时冻结" : state.phase === "completed" ? "设备已完成" : state.phase === "cancelled" ? "已取消，计时停止" : waiting ? "等待设备完成；指令确认不代表运动已完成" : "正在书写，剩余时间仅作估算"}</p>
    <small>匀速估算，不含加减速和通信等待；已用时间暂停时冻结。</small>
  </div>;
}
