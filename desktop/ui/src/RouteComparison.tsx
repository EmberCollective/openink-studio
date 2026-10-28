import { useState } from "react";
import type { RouteDocument } from "./useRoutePlan";
import { DraftNumberInput } from "./DraftNumberInput";

export type RouteVariant = { id: "original" | "current" | "merged" | "aggressive"; label: string; document: RouteDocument; stroke_owners: string[]; strokes: number; draw_mm: number; travel_mm: number; z_mm: number; estimated_seconds: number; compute_ms: number; geometry_preserved: boolean; savings_percent: number; eligible: boolean; added_bridges: { x: number; y: number }[][]; removed_overlap_mm: number; coverage_preserved: boolean };
export type RouteComparisonResult = { variants: RouteVariant[]; recommended: string; calibrated?: boolean };
export function canApplyRouteVariant(variant: RouteVariant) {
  return (variant.id === "merged" || variant.id === "aggressive") && variant.eligible && variant.coverage_preserved;
}
type Options = { trajectoryEnabled: boolean; allowGap: boolean; maxGap: number; deduplicate: boolean; onAllowGap: (enabled: boolean) => void; onMaxGap: (value: number) => void; onDeduplicate: (enabled: boolean) => void };
export function RouteComparison({ result, pending, error, stale, locked, onRefresh, onApply, options }: { result: RouteComparisonResult | null; pending: boolean; error: string; stale: boolean; locked: boolean; onRefresh: () => void; onApply: (variant: RouteVariant) => void; options: Options }) {
  const [selected, setSelected] = useState("current");
  const original = result?.variants.find((variant) => variant.id === "original");
  const candidate = result?.variants.find((variant) => variant.id === selected) || result?.variants.find((variant) => variant.id === result.recommended);
  return <div className="route-comparison">
    <p className="modal-description">按当前描线、空移、Z 速率及下探深度估算完整作业时间，与当前实际使用方案比较。灰色为原线，紫色为候选，红色为额外连笔；不显示全页空移连线。</p>
    <p className="field-note">完整用时为匀速估算，不含加减速和通信等待，不是实测时间。可自行选择通过字迹校验的方案。原始方案与当前轨迹仅作对照，轨迹选择由“优化轨迹”开关控制。</p>
    {result?.calibrated && <p className="field-note">路线按画布坐标优化；描线、空移及用时按校准后各段距离估算。连接阈值、额外连笔和删除重叠长度仍以画布毫米计。</p>}
    <p className="field-note">节省基准：{options.trajectoryEnabled ? "当前已开启的轨迹优化方案" : "当前使用的原笔顺方案"}。</p>
    <fieldset className="route-writing-options panel-fieldset" disabled={locked}>
      <label className="toggle-row"><span>允许跨小间隙连笔</span><input type="checkbox" aria-label="允许跨小间隙连笔" checked={options.allowGap} onChange={(e) => options.onAllowGap(e.target.checked)} /></label>
      <label className="field"><span className="field-label">最大连接距离 · mm</span><DraftNumberInput aria-label="最大连接距离" type="number" min={0} max={1} step={0.05} value={options.maxGap} disabled={!options.allowGap} onChange={(e) => options.onMaxGap(Number(e.target.value))} /></label>
      <label className="toggle-row"><span>删除重叠笔路</span><input type="checkbox" aria-label="删除重叠笔路" checked={options.deduplicate} onChange={(e) => options.onDeduplicate(e.target.checked)} /></label>
      <p className="field-note">两项默认关闭。精确合并仅在原线段相接处连接，保留全部原线段；启用跨间隙会增加红色连线，删除重叠仅保留重复墨迹的一次覆盖。</p>
    </fieldset>
    <button className="button" disabled={pending || locked} onClick={onRefresh}><span>{pending ? "正在计算对照…" : "重新计算对照"}</span></button>
    {error && <p role="alert">{error}</p>}
    {stale && <p role="status">画布或作业参数已改变，旧对照不可应用，请重新计算。</p>}
    {result && <>
      <div className="route-comparison-table"><table>
        <thead><tr><th>方案</th><th>笔数</th><th>描线 mm</th><th>空移 mm</th><th>Z 行程 mm</th><th>完整用时</th><th>节省</th><th>额外连笔 mm</th><th>删除重叠 mm</th><th>计算耗时</th><th>字迹校验</th><th>应用</th></tr></thead>
        <tbody>{result.variants.map((variant) => <tr key={variant.id} aria-selected={candidate?.id === variant.id}>
          <td><button className="text-button" onClick={() => setSelected(variant.id)}>{variant.label}{result.recommended === variant.id ? " · 推荐" : ""}</button></td>
          <td>{variant.strokes}</td><td>{variant.draw_mm.toFixed(1)}</td><td>{variant.travel_mm.toFixed(1)}</td><td>{variant.z_mm.toFixed(1)}</td><td>{variant.estimated_seconds.toFixed(1)} 秒</td><td>{variant.savings_percent.toFixed(2)}%</td><td>{variant.added_bridges.reduce((sum, stroke) => sum + stroke.slice(1).reduce((length, p, i) => length + Math.hypot(p.x - stroke[i].x, p.y - stroke[i].y), 0), 0).toFixed(2)}</td><td>{variant.removed_overlap_mm.toFixed(2)}</td><td>{variant.compute_ms.toFixed(1)} ms</td><td title="比对原墨迹覆盖与新增连线">{!variant.coverage_preserved ? "不通过：原墨迹缺失" : variant.added_bridges.length ? "保留原墨迹，有新增连线" : variant.removed_overlap_mm > 0 ? "保留原墨迹，已去除重叠" : variant.geometry_preserved ? "通过：原线段一致" : "保留原墨迹"}</td>
          <td>{(variant.id === "merged" || variant.id === "aggressive") && <button className="button" disabled={pending || locked || stale || !canApplyRouteVariant(variant)} onClick={() => onApply(variant)}>应用{variant.id === "merged" ? "合并方案" : "连写方案"}</button>}</td>
        </tr>)}</tbody>
      </table></div>
      {candidate && <div className="route-comparison-canvas"><svg viewBox={`0 0 ${candidate.document.width_mm} ${candidate.document.height_mm}`} aria-label="优化方案墨迹对照">
        <g fill="none" stroke="#c4c4cb" strokeWidth=".7">{original?.document.strokes.map((stroke, index) => <polyline key={index} points={stroke.map((p) => `${p.x},${p.y}`).join(" ")} />)}</g>
        <g fill="none" stroke="#7752b6" strokeWidth=".3">{candidate.document.strokes.map((stroke, index) => <polyline key={index} points={stroke.map((p) => `${p.x},${p.y}`).join(" ")} />)}</g>
        <g aria-label="新增连笔" fill="none" stroke="#e22f46" strokeWidth=".8">{candidate.added_bridges.map((stroke, index) => <polyline key={index} points={stroke.map((p) => `${p.x},${p.y}`).join(" ")} />)}</g>
      </svg></div>}
    </>}
  </div>;
}
