import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import { DraftNumberInput } from "./DraftNumberInput";
import { DocumentEditLock } from "./documentEditPolicy";
import Toggle from "./Toggle";
import { PaperCornerEditor, validPaperCorners } from "./PaperCornerEditor";
import { guideLineNumber } from "./paperModel";
import type { BackgroundPage, GuideLine } from "./paperModel";
import "./paper.css";

export type GuideEditorState = { lines: GuideLine[]; maxNumber: number; locked: boolean; onChange(lines: GuideLine[]): void };
export function PaperBackgroundWizard({ kind, width, height, python, locked, calibrated, canvasHost, onStageChange, onGuideEditor, onPreview, onCalibration, onApply, onCancel, onSizeChange }: {
  kind: "pdf" | "image"; width: number; height: number; python: string; locked: boolean; calibrated: boolean; onSizeChange(width: number, height: number): void;
  onPreview: (background: BackgroundPage | null) => void;
  onCalibration: () => Promise<boolean>; onApply: (background: BackgroundPage) => void; onCancel: () => void;
  canvasHost: HTMLElement | null; onStageChange(step: number): void; onGuideEditor(state: GuideEditorState | null): void;
}) {
  const [step, setStep] = useState(0), [source, setSource] = useState(""), [page, setPage] = useState(1);
  const [preview, setPreview] = useState<BackgroundPage | null>(null), [processed, setProcessed] = useState<BackgroundPage | null>(null);
  const [corners, setCorners] = useState<number[][]>([[0, 0], [1, 0], [1, 1], [0, 1]]);
  const [cornersReady, setCornersReady] = useState(false);
  const [removeShadow, setRemoveShadow] = useState(true), [visible, setVisible] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set()), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; }, []);
  const disabled = locked || busy;
  useEffect(() => { onStageChange(step); }, [step, onStageChange]);
  useEffect(() => () => { onGuideEditor(null); onStageChange(0); }, [onGuideEditor, onStageChange]);
  useEffect(() => {
    if (!processed || step < 2) { onGuideEditor(null); return; }
    const lines = (processed.guide_lines || []).filter(line => selected.has(line.id));
    onPreview({ ...processed, guide_lines: lines, guides_visible: visible });
    onGuideEditor(step === 2 ? { lines, maxNumber: Math.max(0, ...(processed.guide_lines || []).map(guideLineNumber)), locked: disabled || !visible, onChange(next) {
      const excluded = (processed.guide_lines || []).filter(line => !selected.has(line.id));
      setProcessed({ ...processed, guide_lines: [...excluded, ...next].sort((a, b) => guideLineNumber(a, 0) - guideLineNumber(b, 0)) });
      setSelected(new Set(next.map(line => line.id)));
    } } : null);
  }, [step, processed, selected, visible, disabled, onPreview, onGuideEditor]);
  async function load(path = source, selectedPage = page, process = false) {
    const ticket = ++epoch.current; setBusy(true); setError("");
    try {
      const result = await invoke<BackgroundPage>("paper_background", { path, page: selectedPage, width_mm: width, height_mm: height, corners: process ? corners : null, remove_shadow: removeShadow, process, python_path: python });
      if (ticket !== epoch.current) return;
      if (process) {
        setProcessed(result); setSelected(new Set((result.guide_lines || []).map(line => line.id))); setStep(2);
        onPreview({ ...result, guides_visible: true });
      } else { setSource(path); setPage(selectedPage); setPreview(result); setCorners(result.corners || [[0, 0], [1, 0], [1, 1], [0, 1]]); setCornersReady(false); onPreview(result); }
    } catch (e) { if (ticket === epoch.current) setError(String(e)); }
    finally { if (ticket === epoch.current) setBusy(false); }
  }
  async function choose() {
    const ticket = ++epoch.current; setBusy(true); setError("");
    try {
      const path = await open({ multiple: false, filters: [{ name: kind === "pdf" ? "PDF 背景" : "照片背景", extensions: kind === "pdf" ? ["pdf"] : ["png", "jpg", "jpeg"] }] });
      if (ticket === epoch.current && typeof path === "string") await load(path, 1);
    } catch (e) { if (ticket === epoch.current) setError(String(e)); }
    finally { if (ticket === epoch.current) setBusy(false); }
  }
  function toggleLine(id: string) {
    const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); setSelected(next);
    if (processed) onPreview({ ...processed, guide_lines: processed.guide_lines?.filter(line => next.has(line.id)), guides_visible: visible });
  }
  function selectAll(all: boolean) { const next = new Set(all ? processed?.guide_lines?.map(line => line.id) : []); setSelected(next); if (processed) onPreview({ ...processed, guide_lines: all ? processed.guide_lines : [], guides_visible: visible }); }
  async function next() {
    if (disabled) return;
    if (step === 0 && preview) setStep(1);
    else if (step === 1 && cornersReady && validPaperCorners(corners)) await load(source, page, true);
    else if (step === 2 && selected.size) {
      const ticket = ++epoch.current; setBusy(true);
      try { if (await onCalibration() && ticket === epoch.current) setStep(3); }
      catch (e) { if (ticket === epoch.current) setError(String(e)); }
      finally { if (ticket === epoch.current) setBusy(false); }
    }
    else if (step === 3 && calibrated && processed) onApply({ ...processed, guide_lines: processed.guide_lines?.filter(line => selected.has(line.id)), guides_visible: visible, processed: true });
  }
  return <section className="section paper-workflow" aria-label="纸张背景设置">
    <div className="paper-row"><strong>设置纸张背景</strong><button className="icon-button" aria-label="取消背景设置" disabled={locked} onClick={() => { epoch.current++; onCancel(); }}><X size={15} /></button></div>
    <ol className="paper-steps">{["导入背景", "拉平与净化", "确认横线", "纸面定位"].map((label, i) => <li key={label} className={step === i ? "active" : step > i ? "done" : ""}>{i + 1}. {label}</li>)}</ol>
    {step === 0 && <>{kind === "image" && <DocumentEditLock.Provider value={false}><div className="paper-fields"><label>大致宽度 / mm<DraftNumberInput className="text-input" aria-label="照片大致宽度" type="number" min={1} max={210} value={width} disabled={disabled} onChange={e => onSizeChange(Math.min(210, Math.max(1, Number(e.target.value))), height)} /></label><label>大致高度 / mm<DraftNumberInput className="text-input" aria-label="照片大致高度" type="number" min={1} max={297} value={height} disabled={disabled} onChange={e => onSizeChange(width, Math.min(297, Math.max(1, Number(e.target.value))))} /></label></div></DocumentEditLock.Provider>}<button className="button full" disabled={disabled} onClick={choose}>{kind === "pdf" ? "选择 PDF 背景" : "选择照片背景"}</button>{source && <div className="paper-source">{source.split(/[\\/]/).pop()}</div>}
      {preview && preview.page_count > 1 && <label className="paper-field">PDF 页码<DraftNumberInput className="text-input" aria-label="背景 PDF 页码" type="number" min={1} max={preview.page_count} value={page} disabled={disabled} onChange={e => void load(source, Number(e.target.value))} /></label>}
      <p className="field-note">只作为纸张底稿，不转换为书写轨迹。完成四步后才应用，取消不改原页面。</p></>}
    {step === 1 && <><p className="field-note">直接在画布中拖动四个角到纸张边缘，拖动时显示定位放大镜。调整后点击“应用并继续”拉平。</p>{!validPaperCorners(corners) && <p className="field-note paper-error">四角不能交叉、重叠或围成过小的区域。</p>}
      <Toggle label="去除纸面阴影" checked={removeShadow} onChange={setRemoveShadow} disabled={disabled} /><p className="field-note">纸张比例沿用当前画板，实际尺度与位置通过纸面定位确认。四角校正不能消除卷曲，建议摊平重拍。</p></>}
    {step === 1 && preview && canvasHost && createPortal(<PaperCornerEditor source={preview.data_url} corners={corners} onChange={setCorners} onReady={setCornersReady} disabled={disabled} onMessage={setError} />, canvasHost)}
    {step === 2 && <><div className="paper-row"><span>已选 {selected.size} / {processed?.guide_lines?.length || 0} 条</span><button className="text-button" disabled={disabled} onClick={() => selectAll(true)}>全选</button><button className="text-button" disabled={disabled} onClick={() => selectAll(false)}>清空</button></div>
      <Toggle label="显示全部定位横线" checked={visible} onChange={value => { setVisible(value); if (processed) onPreview({ ...processed, guide_lines: processed.guide_lines?.filter(line => selected.has(line.id)), guides_visible: value }); }} disabled={disabled} />
      <div className="paper-line-choice">{processed?.guide_lines?.map((line, i) => <button key={line.id} disabled={disabled} aria-pressed={selected.has(line.id)} onClick={() => toggleLine(line.id)}>{guideLineNumber(line, i)}</button>)}</div>
      <p className="field-note">使用画布选择工具框选横线，可拖动、删除或撤销。红色编号对应左侧选项，调整后一次确认。</p>{!processed?.guide_lines?.length && <p className="field-note paper-error">未识别到可用横线，请返回调整四角、阴影或换一张清晰图片。</p>}</>}
    {step === 3 && <><p className="field-note">请在左侧画板的“纸面定位”完成两点或三点校准。逐点确认、抬笔移向预计位置，再在设备控制中点动微调。</p><p className="field-note">{calibrated ? "已收到设备校准完成回报，可以应用背景。" : "等待纸面校准完成；未连接设备时不能跳过。"}</p></>}
    {error && <p className="field-note paper-error" role="alert">{error}</p>}{busy && <p className="field-note" role="status">{step === 1 ? "正在拉平、净化并识别横线…" : "正在读取背景…"}</p>}
    <div className="paper-row"><button className="text-button" disabled={disabled || step === 0 || step === 3} onClick={() => { setStep(s => s - 1); if (step === 2) { setProcessed(null); onPreview(preview); } }}>上一步</button>
      <button className="button primary" disabled={disabled || (step === 0 && !preview) || (step === 1 && (!cornersReady || !validPaperCorners(corners))) || (step === 2 && !selected.size) || (step === 3 && !calibrated)} onClick={next}>{step === 3 ? "完成并应用" : step === 2 ? `确认 ${selected.size} 条并继续` : step === 1 ? "应用并继续" : "下一步"}</button></div>
  </section>;
}
