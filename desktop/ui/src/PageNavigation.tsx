import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Plus, X } from "lucide-react";
import { DraftNumberInput } from "./DraftNumberInput";
import "./paper.css";

export type PageAddition = { kind: "blank"; width: number; height: number } | { kind: "copy"; index: number } | { kind: "pdf" | "image" };
export function PageNavigation({ page, count, width, height, disabled, addOnly = false, onPage, onAdd }: {
  page: number; count: number; width: number; height: number; disabled: boolean; addOnly?: boolean;
  onPage: (index: number) => void; onAdd: (addition: PageAddition) => void;
}) {
  const [popup, setPopup] = useState<"jump" | "add" | null>(null), [kind, setKind] = useState<"blank" | "copy" | null>(null);
  const [jump, setJump] = useState(String(page + 1)), [source, setSource] = useState(page), [size, setSize] = useState("current");
  const [customWidth, setCustomWidth] = useState(width), [customHeight, setCustomHeight] = useState(height), [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState({ left: 8, top: 8 });
  function close() { setPopup(null); trigger.current?.focus(); }
  useEffect(() => { if (disabled) setPopup(null); }, [disabled]);
  useLayoutEffect(() => {
    if (!popup) return;
    const position = () => {
      const button = trigger.current?.getBoundingClientRect(), box = panel.current?.getBoundingClientRect();
      if (!button || !box) return;
      const margin = 8, gap = 9;
      const below = button.bottom + gap;
      const above = button.top - gap - box.height;
      const preferred = addOnly && below + box.height <= window.innerHeight - margin ? below : above;
      setAnchor({
        left: Math.max(margin, Math.min(button.right - box.width, window.innerWidth - box.width - margin)),
        top: Math.max(margin, Math.min(preferred, window.innerHeight - box.height - margin)),
      });
    };
    position();
    const observer = new ResizeObserver(position);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [popup, addOnly, kind, size, error]);
  useEffect(() => {
    if (!popup) return;
    const outside = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node)) setPopup(null);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    window.addEventListener("pointerdown", outside); window.addEventListener("keydown", escape);
    (panel.current?.querySelector<HTMLInputElement>("input") ?? panel.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [popup]);
  function show(value: "jump" | "add", button: HTMLButtonElement) {
    trigger.current = button;
    setError(""); setKind(null); setSource(page); setJump(String(page + 1)); setPopup(p => p === value ? null : value);
  }
  function select(index: number) { onPage(index); setPopup(null); }
  function add() {
    if (kind === "copy") { onAdd({ kind, index: source }); setPopup(null); return; }
    const [w, h] = size === "current" ? [width, height] : size === "a4" ? [210, 297] : size === "a5" ? [148, 210] : [customWidth, customHeight];
    if (![w, h].every(v => Number.isFinite(v) && v >= 20) || w > 210 || h > 297) { setError("页面宽度须为 20–210 mm，高度须为 20–297 mm。"); return; }
    onAdd({ kind: "blank", width: w, height: h }); setPopup(null);
  }
  return <div className={`page-navigation ${addOnly ? "add-only" : ""}`} ref={host} aria-label={addOnly ? "添加画板页面" : "画板页面"}>
    {!addOnly && <><button className="icon-button" title="上一页画板" aria-label="上一页画板" disabled={disabled || page === 0} onClick={() => select(page - 1)}><ArrowLeft size={15} /></button>
      <button className="page-trigger" data-popup-trigger aria-haspopup="dialog" aria-expanded={popup === "jump"} disabled={disabled} onClick={e => show("jump", e.currentTarget)}>{page + 1}<span>/</span>{count} 页</button>
      <button className="icon-button" title="下一页画板" aria-label="下一页画板" disabled={disabled || page + 1 >= count} onClick={() => select(page + 1)}><ArrowRight size={15} /></button></>}
    <button className="icon-button" data-popup-trigger title="添加页面" aria-label="添加页面" aria-haspopup="dialog" aria-expanded={popup === "add"} disabled={disabled || count >= 200} onClick={e => show("add", e.currentTarget)}><Plus size={18} /></button>
    {popup && createPortal(<section ref={panel} style={anchor} className="page-popover" role="dialog" aria-label={popup === "jump" ? "跳转页面" : "添加页面"}>
      <div className="paper-row"><strong>{popup === "jump" ? "跳转页面" : "添加页面"}</strong><button className="icon-button" aria-label="关闭页面窗口" onClick={close}><X size={15} /></button></div>
      {popup === "jump" ? <><form className="paper-row" onSubmit={e => { e.preventDefault(); const value = Number(jump); if (!/^\d+$/.test(jump.trim()) || !Number.isSafeInteger(value) || value < 1 || value > count) setError(`请输入 1–${count} 的整数页码。`); else select(value - 1); }}>
        <label>第 <input className="text-input page-jump-input" aria-label="跳转页码" inputMode="numeric" value={jump} onChange={e => setJump(e.target.value)} /></label><span>/ {count} 页</span><button className="button primary">跳转</button></form>
        <div className="paper-page-list">{Array.from({ length: count }, (_, i) => <button key={i} aria-current={i === page ? "page" : undefined} onClick={() => select(i)}>{i + 1}</button>)}</div></> : !kind ? <div className="page-add-options">
          <button onClick={() => setKind("blank")}><strong>空白页面</strong><small>选择大小，直接开始编辑</small></button>
          <button onClick={() => setKind("copy")}><strong>复制已有页面</strong><small>当前页或指定页，复用背景与横线</small></button>
          <button onClick={() => { onAdd({ kind: "pdf" }); setPopup(null); }}><strong>从 PDF 添加</strong><small>整份导入，自动添加全部页面</small></button>
          <button onClick={() => { onAdd({ kind: "image" }); setPopup(null); }}><strong>从照片添加</strong><small>导入、拉平净化、确认横线、两点定位</small></button>
        </div> : <><button className="text-button" onClick={() => setKind(null)}>← 返回类型选择</button>
          {kind === "copy" ? <label className="paper-field">复制哪一页<select className="text-input" aria-label="复制页面" value={source} onChange={e => setSource(Number(e.target.value))}>{Array.from({ length: count }, (_, i) => <option value={i} key={i}>第 {i + 1} 页{i === page ? " · 当前页" : ""}</option>)}</select></label> : <><label className="paper-field">页面大小<select className="text-input" value={size} onChange={e => setSize(e.target.value)}><option value="current">与当前页相同</option><option value="a4">A4 · 210 × 297 mm</option><option value="a5">A5 · 148 × 210 mm</option><option value="custom">自定义</option></select></label>
          {size === "custom" && <div className="paper-fields"><label>宽 / mm<DraftNumberInput className="text-input" type="number" value={customWidth} min={20} max={210} onChange={e => setCustomWidth(Number(e.target.value))} /></label><label>高 / mm<DraftNumberInput className="text-input" type="number" value={customHeight} min={20} max={297} onChange={e => setCustomHeight(Number(e.target.value))} /></label></div>}</>}
          <button className="button primary full" onClick={add}>{kind === "copy" ? "复制并添加" : "添加空白页"}</button></>}
      {error && <p className="field-note paper-error" role="alert">{error}</p>}
    </section>, document.body)}
  </div>;
}
