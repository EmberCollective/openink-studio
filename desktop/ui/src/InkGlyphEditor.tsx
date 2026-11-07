import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ArrowLeft, Hand, MousePointer2, PenTool, Save, ZoomIn, ZoomOut } from "lucide-react";
import { useCanvasEditing } from "./CanvasEditing";
import { boundsOf, transformPaths, type Drawing, type Point } from "./editorGeometry";
import { screenToCanvas } from "./pointerGeometry";
import { DraftNumberInput } from "./DraftNumberInput";
import Toggle from "./Toggle";
import { inkCanvas, inkWritingMetrics, variantError, type InkVariant } from "./inkfont";

export function InkGlyphView({ variant, label, writing = false }: { variant: InkVariant; label?: string; writing?: boolean }) {
  const metrics = writing ? { ...inkWritingMetrics(variant), y: 0 } : variant.canvas ?? { x: 0, y: 0, width: variant.width_mm, height: variant.height_mm };
  return <svg viewBox={`${metrics.x} ${metrics.y} ${metrics.width} ${metrics.height}`} style={writing ? { width: 72 * metrics.width / metrics.height, height: 72, overflow: "visible" } : undefined} aria-label={label || `字形 ${variant.character}`}>
    {variant.strokes.map((stroke, i) => <polyline key={i} points={stroke.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />)}
  </svg>;
}

export function InkConfirm({ title, children, onCancel, onConfirm, confirmText = "确认", busy = false }: { title: string; children: React.ReactNode; onCancel: () => void; onConfirm: () => void; confirmText?: string; busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={dialog} className="modal ink-confirm" aria-label={title} onCancel={e => { e.preventDefault(); if (!busy) onCancel(); }}>
    <h2>{title}</h2>{children}<div className="modal-actions"><button className="button" disabled={busy} onClick={onCancel} autoFocus>取消</button><button className="button primary" disabled={busy} onClick={onConfirm}>{confirmText}</button></div>
  </dialog>;
}

export function InkGlyphEditor({ variant, packName, onSave, onExit, embedded = false, backgroundUrl, saveLabel = "保存字形", onDraftChange, historyToolbar, locked = false }: {
  variant: InkVariant; packName: string; onSave: (variant: InkVariant) => Promise<void>; onExit: () => void;
  embedded?: boolean; backgroundUrl?: string; saveLabel?: string; onDraftChange?: (variant: InkVariant) => void; historyToolbar?: ReactNode; locked?: boolean;
}) {
  const originalSize = useRef({ width: variant.width_mm, height: variant.height_mm }).current;
  const canvas = useRef(inkCanvas(variant)).current;
  const paperSize = canvas.width, paperX = canvas.x, paperY = canvas.y;
  const [drawing, setDrawing] = useState<Drawing>(() => ({ name: variant.character, width_mm: canvas.width, height_mm: canvas.height, strokes: structuredClone(variant.strokes) }));
  const [character, setCharacter] = useState(variant.character);
  const [tool, setTool] = useState<"select" | "pen" | "pan">("select"), [zoom, setZoom] = useState(100), [pan, setPan] = useState({ x: 0, y: 0 });
  const [guides, setGuides] = useState(true), [ghost, setGhost] = useState(false), [skew, setSkew] = useState(0);
  const [baseline, setBaseline] = useState(true);
  const [showBackground, setShowBackground] = useState(true);
  const [ink, setInk] = useState<Point[]>([]), [message, setMessage] = useState(""), [saving, setSaving] = useState(false), [leaving, setLeaving] = useState(false);
  const busy = saving || locked;
  const svg = useRef<SVGSVGElement>(null), gesture = useRef<{ pointer: number; start: Point; pan: Point; points: Point[] } | null>(null);
  const editor = useCanvasEditing({ document: drawing, sourceKey: variant.id, locked: busy || leaving, extracting: false, focusScope: ".ink-editor", canvasBounds: canvas, onChange: setDrawing, onMessage: setMessage });
  const current: InkVariant = { ...variant, character, canvas, strokes: drawing.strokes };
  const draftSnapshot = JSON.stringify({ character, strokes: drawing.strokes });
  const lastDraft = useRef(draftSnapshot), draftListener = useRef(onDraftChange);
  draftListener.current = onDraftChange;
  useEffect(() => {
    if (lastDraft.current === draftSnapshot) return;
    lastDraft.current = draftSnapshot;
    if (!locked) draftListener.current?.(current);
  }, [draftSnapshot]);
  const error = variantError(current), dirty = JSON.stringify(current) !== JSON.stringify({ ...variant, canvas });
  const size = Math.max(drawing.width_mm, drawing.height_mm) * 1.25 * 100 / zoom;
  function point(e: PointerEvent<SVGRectElement>) {
    const matrix = svg.current?.getScreenCTM();
    return matrix ? screenToCanvas({ x: e.clientX, y: e.clientY }, matrix) : null;
  }
  function cancel() { gesture.current = null; setInk([]); }
  useEffect(() => { if (busy) cancel(); }, [busy]);
  function down(e: PointerEvent<SVGRectElement>) {
    if (busy || leaving || e.button !== 0) return;
    const p = point(e); if (!p) return;
    e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { pointer: e.pointerId, start: p, pan: { ...pan }, points: [p] };
    if (tool === "pen") setInk([p]);
  }
  function move(e: PointerEvent<SVGRectElement>) {
    const g = gesture.current, p = point(e); if (!g || !p || g.pointer !== e.pointerId || busy) return;
    if (tool === "pan") { setPan({ x: pan.x - p.x + g.start.x, y: pan.y - p.y + g.start.y }); return; }
    const last = g.points[g.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) > .025 && g.points.length < 10000) { g.points.push(p); setInk([...g.points]); }
  }
  function end(e: PointerEvent<SVGRectElement>) {
    const g = gesture.current; if (!g || g.pointer !== e.pointerId) return;
    if (tool === "pen" && !busy && !leaving && g.points.length > 1) {
      editor.commitAll({ ...drawing, strokes: [...drawing.strokes, g.points] }, [drawing.strokes.length]);
      setMessage("新增一条笔画，可继续书写，或切回选择工具调整。");
    }
    cancel(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }
  async function save() {
    if (error || busy) return;
    setSaving(true); setMessage("");
    try { await onSave(current); } catch (e) { setMessage(String(e)); setSaving(false); setLeaving(false); }
  }
  function leave() { if (!busy) dirty ? setLeaving(true) : onExit(); }
  useEffect(() => {
    if (embedded) return;
    const node = svg.current?.closest("dialog");
    const escape = (e: Event) => { e.preventDefault(); e.stopPropagation(); if (gesture.current) cancel(); else leave(); };
    node?.addEventListener("cancel", escape);
    return () => node?.removeEventListener("cancel", escape);
  });
  function shear() {
    const box = boundsOf(drawing, editor.selection); if (!box || !editor.selection.length) return;
    const factor = Math.tan(skew * Math.PI / 180), center = box.y + box.height / 2;
    editor.commitAll(transformPaths(drawing, editor.selection, p => ({ x: p.x + (p.y - center) * factor, y: p.y })), editor.selection); setSkew(0);
  }
  return <div className={`ink-editor${embedded ? " ink-editor-embedded" : ""}`}>
    {!embedded && <header className="ink-header"><button className="button" disabled={busy} onClick={leave}><ArrowLeft size={16} />返回字形管理</button><div><strong>编辑「{character || "新字形"}」</strong><p className="field-note">{packName} · {dirty ? "有未保存修改" : "当前字形"}</p></div><button className="button primary" disabled={busy || !!error} onClick={() => void save()}><Save size={16} />{busy ? "正在保存…" : saveLabel}</button></header>}
    <div className="ink-editor-body">
      <aside className="section ink-strokes"><h3>笔迹 · {drawing.strokes.length} 条</h3><p className="field-note">点击选择，Shift 多选</p><div className="ink-stroke-list">{drawing.strokes.map((stroke, i) => <button className="button" key={i} aria-label={`选择笔迹 ${i + 1}`} aria-pressed={editor.selection.includes(i)} disabled={busy} onClick={e => { setTool("select"); editor.selectPaths(e.shiftKey ? editor.selection.includes(i) ? editor.selection.filter(n => n !== i) : [...editor.selection, i] : [i]); }}><span>{i + 1}</span><InkGlyphView variant={{ ...current, strokes: [stroke] }} /><span>笔迹 {i + 1}</span></button>)}</div></aside>
      <section className="canvas-panel ink-canvas-panel">
        <div className="canvas-toolbar"><div className="ink-tools">{([['select', MousePointer2, '选择笔迹'], ['pan', Hand, '拖动画布'], ['pen', PenTool, '画笔：新增笔画']] as const).map(([id, Icon, title]) => <button className="icon-button" key={id} aria-label={title} title={title} aria-pressed={tool === id} disabled={busy} onClick={() => { cancel(); setTool(id); setMessage(""); }}><Icon size={17} /></button>)}</div>{editor.toolbar}</div>
        <div className="ink-canvas"><span className="ink-canvas-character" aria-label={`当前对应字符：${character || "未指定"}`}>{character || "?"}</span><svg ref={svg} aria-label="字形编辑画板" viewBox={`${paperX + canvas.width / 2 - size / 2 + pan.x} ${paperY + canvas.height / 2 - size / 2 + pan.y} ${size} ${size}`}>
          <rect x={paperX} y={paperY} width={canvas.width} height={canvas.height} fill="white" stroke="#ddd9e6" vectorEffect="non-scaling-stroke" />
          {showBackground && backgroundUrl && <image href={backgroundUrl} x="0" y="0" width={originalSize.width} height={originalSize.height} preserveAspectRatio="xMidYMid meet" opacity=".3" pointerEvents="none" />}
          {guides && <g transform={`translate(${paperX} ${paperY})`} stroke="#ded9e8" strokeDasharray="4 4" pointerEvents="none"><path d={`M${drawing.width_mm / 2} 0V${drawing.height_mm}M0 ${drawing.height_mm / 2}H${drawing.width_mm}M0 0L${drawing.width_mm} ${drawing.height_mm}M0 ${drawing.height_mm}L${drawing.width_mm} 0`} fill="none" strokeWidth="1" vectorEffect="non-scaling-stroke" /></g>}
          {baseline && <g aria-label="基准线：字面高度的 75%" pointerEvents="none"><path d={`M${paperX} ${variant.height_mm * .75}H${paperX + paperSize}`} stroke="#a392c6" strokeDasharray="6 3" strokeWidth="1" vectorEffect="non-scaling-stroke" /><text x={paperX - size * .012} y={variant.height_mm * .75} textAnchor="end" dominantBaseline="middle" fill="#817398" fontSize={size * .018}>基准线</text></g>}
          {ghost && <g opacity=".18" pointerEvents="none">{variant.strokes.map((s, i) => <polyline key={i} points={s.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}</g>}
          {editor.layer}{tool === "select" && editor.handles}
          {tool !== "select" && <rect x={paperX + canvas.width / 2 - size / 2 + pan.x} y={paperY + canvas.height / 2 - size / 2 + pan.y} width={size} height={size} fill="transparent" style={{ touchAction: "none", cursor: tool === "pen" ? "crosshair" : "grab" }} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={cancel} />}
          {ink.length > 1 && <polyline points={ink.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#7463cc" strokeWidth="2" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
        </svg></div>
        <footer className="ink-canvas-footer">{historyToolbar === undefined ? editor.historyToolbar : historyToolbar}<span>{editor.selection.length ? `已选 ${editor.selection.length} 条` : `共 ${drawing.strokes.length} 条`}</span><div className="ink-tools"><button className="icon-button" aria-label="缩小画布" onClick={() => setZoom(z => Math.max(25, z - 25))}><ZoomOut size={16} /></button><button className="button" onClick={() => { setZoom(100); setPan({ x: 0, y: 0 }); }}>{zoom}%</button><button className="icon-button" aria-label="放大画布" onClick={() => setZoom(z => Math.min(400, z + 25))}><ZoomIn size={16} /></button></div></footer>
      </section>
      <aside className="section ink-properties"><h3>字形属性</h3><label>对应字符<input className="text-input" aria-label="编辑字形对应字符" value={character} disabled={busy} onChange={e => setCharacter(e.target.value)} /></label><p className="field-note">修改只作用于当前字形，同字的其他写法保留。</p>
        <p className="field-note">书写保留字形大小和上下位置。字间距在排版设置中调整；基准线位于字面高度的 75%。</p>
        {editor.inspector || <p className="field-note">先点击或框选笔迹，再拖动、缩放、旋转；可全选后整体变形。</p>}
        <label>倾斜（°）<DraftNumberInput className="text-input" type="number" value={skew} min={-60} max={60} disabled={busy || !editor.selection.length} onChange={e => setSkew(Number(e.target.value))} /></label><button className="button" disabled={busy || !editor.selection.length || skew === 0} onClick={shear}>应用倾斜</button>
        <Toggle label="显示字面辅助线" checked={guides} onChange={setGuides} /><Toggle label="显示基准线（75% 高度）" checked={baseline} onChange={setBaseline} /><Toggle label="对照原始字形" checked={ghost} onChange={setGhost} />
        {backgroundUrl && <Toggle label="叠加原始切片" checked={showBackground} onChange={setShowBackground} />}
        <p className="field-note">选择画笔后，按住拖动新增笔画，松开结束。新增笔画同样可以选择、变形、删除与撤销。</p>
        {error && <p className="ink-error">{error}</p>}<p className="field-note" role="status">{message}</p>
      </aside>
    </div>
    {leaving && <InkConfirm title="放弃未保存的字形修改？" confirmText="放弃并返回" busy={busy} onCancel={() => setLeaving(false)} onConfirm={onExit}><p>尚未保存的字符修改、变形与新增笔画会丢失。取消后可先保存字形。</p></InkConfirm>}
  </div>;
}
