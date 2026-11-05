import { useState } from "react";
import type { Drawing } from "./editorGeometry";
import { batchesOf, batchOf, batchColors, batchStatus, type Batch } from "./batchModel";

export function BatchAssignment({ document, selection, disabled, onAssign }: { document: Drawing; selection: number[]; disabled: boolean; onAssign: (id: string) => void }) {
  const values = new Set(selection.map(i => batchOf(document, i)));
  return <div className="batch-assignment"><label className="field-label" htmlFor="selection-batch">所属批次</label>
    <select id="selection-batch" disabled={disabled} value={values.size === 1 ? [...values][0] : ""} onChange={e => onAssign(e.target.value)}>
      <option value="" disabled>多个批次</option>{batchesOf(document).map((b, i) => <option key={b.id} value={b.id}>{i + 1} · {b.name}</option>)}<option value="__new">新建批次并移入</option>
    </select><p className="field-note">只调整选中笔画的归属，不复制内容；可撤销。</p></div>;
}
export function BatchPanel({ document, current, written, disabled, selection, review, onSelect, onAssign, onChange, onReview }: {
  document: Drawing; current: string; written: ReadonlySet<string>; disabled: boolean; selection: number[]; review: boolean;
  onSelect: (id: string) => void; onAssign: (id: string) => void; onChange: (batches: Batch[], removed?: string, target?: string) => void; onReview: () => void;
}) {
  const batches = batchesOf(document), selected = batches.find(b => b.id === current)!;
  const [removeTo, setRemoveTo] = useState("");
  return <div className="batch-panel"><div className="batch-list">{batches.map((b, i) => <button className="button batch-item" key={b.id} aria-pressed={b.id === current} disabled={disabled} onClick={() => onSelect(b.id)}>
    <span className="batch-dot" style={{ background: batchColors[b.color % batchColors.length] }} /><span>{i + 1} · {b.name}</span><small>{batchStatus(document, b.id, written)}</small>
  </button>)}</div><button className="button full" disabled={disabled || batches.length >= 200} onClick={() => onAssign("__new")}>{selection.length ? "将选中内容移入新批次" : "新建批次"}</button>
    <details key={current}><summary>当前批次设置</summary><label className="field-label" htmlFor="batch-name">批次名称</label><input id="batch-name" className="text-input" disabled={disabled} defaultValue={selected.name} maxLength={80} onBlur={e => { const name = e.target.value.trim(); if (name) onChange(batches.map(b => b.id === current ? { ...b, name } : b)); else e.target.value = selected.name; }} />
      <div className="batch-order">{[-1, 1].map(delta => <button key={delta} className="button" disabled={disabled || !batches[batches.indexOf(selected) + delta]} onClick={() => { const next = [...batches], i = next.indexOf(selected); [next[i], next[i + delta]] = [next[i + delta], next[i]]; onChange(next); }}>{delta < 0 ? "上移" : "下移"}</button>)}</div>
      {batches.length > 1 && <><label className="field-label" htmlFor="batch-remove-target">移除批次时，将内容移入</label><select id="batch-remove-target" disabled={disabled} value={batches.some(b => b.id === removeTo && b.id !== current) ? removeTo : ""} onChange={e => setRemoveTo(e.target.value)}><option value="">选择接收批次</option>{batches.filter(b => b.id !== current).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select><button className="button" disabled={disabled || !batches.some(b => b.id === removeTo && b.id !== current)} onClick={() => onChange(batches.filter(b => b.id !== current), current, removeTo)}>移除批次，保留内容</button></>}
    </details><p className="field-note">仅规划当前批次。完成后抬笔停下，由任务控制手动开始下一批。</p>
    {review && <div className="run-readiness"><span>本批曾中断，请核对纸面；重新开始可能重描未确认的笔画。</span><button disabled={disabled} onClick={onReview}>已核对，允许重新开始本批</button></div>}
  </div>;
}
