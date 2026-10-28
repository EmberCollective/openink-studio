import { useEffect, useRef, useState } from "react";
import type { Layout, LayoutPage } from "./layoutGeometry";

export function LayoutPagesDialog({ pages, layout, currentPage, disabled, onClose, onApply }: {
  pages: LayoutPage[]; layout: Layout; currentPage: number; disabled: boolean;
  onClose: () => void; onApply: (selected: number[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState(() => pages.flatMap((p, i) => p.layout_id === layout.id ? [i] : []));
  const [applying, setApplying] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const locked = disabled || applying;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !locked) onClose(); }}>
    <div className="modal" ref={box} role="dialog" aria-modal="true" aria-labelledby="layout-pages-title" onKeyDown={e => {
      if (e.key === "Escape" && !locked) onClose();
      if (e.key !== "Tab") return;
      const items = [...box.current!.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}>
      <div className="modal-heading"><h2 id="layout-pages-title">把版面应用到页面</h2><button className="button" disabled={locked} onClick={onClose}>关闭</button></div>
      <div className="section">
        <p className="field-note">共用当前页面尺寸、边距、行数、字号、字间距和横纵比例。字迹保留；已有内容越界时整批不应用。</p>
        <div className="pen-buttons">
          <button className="button" disabled={locked} onClick={() => setSelected(pages.map((_, i) => i))}>全选</button>
          <button className="button" disabled={locked} onClick={() => setSelected(pages.flatMap((p, i) => p.layout_id !== layout.id ? [i] : []))}>仅未套用</button>
          <button className="button" disabled={locked} onClick={() => setSelected([])}>清空</button>
        </div>
        <fieldset className="panel-fieldset layout-page-choices" disabled={locked}>
          {pages.map((page, index) => <label key={index} className="calibration-confirm">
            <input type="checkbox" checked={selected.includes(index)} onChange={e => setSelected(current => e.target.checked ? [...current, index] : current.filter(i => i !== index))} />
            第 {index + 1} 页{index === currentPage ? " · 当前页" : ""} · {page.layout_id === layout.id ? "已套用" : "未套用"}
          </label>)}
        </fieldset>
        <p className="field-note">本次旋转由所有页面共用，不随工程保存。换纸后对准公共原点，设置当前位置；重连后须重新校准。未勾选页面保留原设置。</p>
        <button className="button primary full" disabled={locked || !selected.length} onClick={async () => { setApplying(true); try { await onApply(selected); } finally { setApplying(false); } }}>应用到 {selected.length} 页</button>
      </div>
    </div>
  </div>;
}
