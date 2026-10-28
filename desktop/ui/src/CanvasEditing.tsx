import { DraftNumberInput } from "./DraftNumberInput";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  CheckSquare,
  ClipboardPaste,
  Copy,
  Focus,
  LockKeyhole,
  Redo2,
  RotateCw,
  Scissors,
  Trash2,
  Undo2,
  UnlockKeyhole,
  X,
} from "lucide-react";
import {
  boundsOf,
  copyPaths,
  deletePaths,
  hitStroke,
  movePaths,
  pastePaths,
  rectangle,
  resizePaths,
  rotatePaths,
  resizeHandles,
  handlePoint,
  resizeFromHandle,
  rotationFromPointer,
  selectByRectangle,
  type Bounds,
  type Drawing,
  type Point,
  type ResizeHandle,
} from "./editorGeometry";

function NumericEdit({
  label,
  value,
  onCommit,
  disabled = false,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="edit-numeric">
      <span>{label}</span>
      <DraftNumberInput
        aria-label={`选区${label}`}
        disabled={disabled}
        type="number"
        step="0.5"
        value={value}
        onChange={(e) => onCommit(Number(e.target.value))}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <small>mm</small>
    </label>
  );
}

type Snapshot = { document: Drawing; selection: number[] };
type Drag = {
  start: Point;
  current: Point;
  kind: "move" | "box" | "resize" | "rotate";
  document: Drawing;
  selection: number[];
  append: boolean;
  handle?: ResizeHandle;
  bounds?: Bounds;
  owner: SVGGElement;
  pointerId: number;
};

export function useCanvasEditing({
  document,
  sourceKey,
  locked,
  extracting,
  onChange,
  onMessage,
  writtenIds,
  onResetWritten,
}: {
  document: Drawing | null;
  sourceKey: unknown;
  locked: boolean;
  extracting: boolean;
  writtenIds?: ReadonlySet<string>;
  onResetWritten?: (selection: number[]) => void;
  onChange: (d: Drawing) => void;
  onMessage: (message: string) => void;
}) {
  const [selection, setSelection] = useState<number[]>([]),
    [draft, setDraft] = useState<Drawing | null>(null),
    [marquee, setMarquee] = useState<Bounds | null>(null),
    [history, setHistory] = useState<Snapshot[]>([]),
    [future, setFuture] = useState<Snapshot[]>([]),
    [clipboard, setClipboard] = useState<Point[][]>([]),
    [proportional, setProportional] = useState(true),
    [angle, setAngle] = useState(0);
  const [rotationPreview, setRotationPreview] = useState<{ box: Bounds; angle: number } | null>(null);
  const handlesRef = useRef<SVGGElement | null>(null);
  const [screenUnit, setScreenUnit] = useState(0.5);
  const lockedRef = useRef(locked || extracting);
  lockedRef.current = locked || extracting;
  const drag = useRef<Drag | null>(null),
    canvasFocused = useRef(false);
  function cancelDrag() {
    const previous = drag.current;
    drag.current = null;
    setDraft(null);
    setMarquee(null);
    setRotationPreview(null);
    if (previous?.owner.hasPointerCapture?.(previous.pointerId)) previous.owner.releasePointerCapture(previous.pointerId);
  }
  useEffect(() => {
    setSelection([]);
    setHistory([]);
    setFuture([]);
    cancelDrag();
  }, [sourceKey]);
  useEffect(() => {
    if (locked || extracting) {
      cancelDrag();
    }
  }, [locked, extracting]);
  useEffect(() => {
    if (drag.current && drag.current.document !== document) cancelDrag();
  }, [document]);
  const active = !!document && !locked && !extracting;
  useLayoutEffect(() => {
    const svg = handlesRef.current?.ownerSVGElement;
    if (!svg) return;
    const measure = () => {
      const matrix = svg.getScreenCTM?.();
      const scale = matrix ? Math.hypot(matrix.a, matrix.b) : svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
      if (Number.isFinite(scale) && scale > 0) setScreenUnit((previous) => Math.abs(previous - 1 / scale) > .00001 ? 1 / scale : previous);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  });
  const visible = draft || document;
  const selected = new Set(selection);
  const box = useMemo(
    () => (visible ? boundsOf(visible, selection) : null),
    [visible, selection],
  );
  const safe = (action: () => void) => {
    try {
      action();
    } catch (e) {
      onMessage(String(e));
    }
  };
  function commit(next: Drawing, ids = selection) {
    if (!document || locked || extracting) return;
    setHistory((h) => [...h.slice(-39), { document, selection }]);
    setFuture([]);
    setSelection(ids);
    setDraft(null);
    onChange(next);
  }
  function undo() {
    if (locked || extracting || !document || !history.length) return;
    const previous = history[history.length - 1];
    setHistory(history.slice(0, -1));
    setFuture((f) => [{ document, selection }, ...f]);
    setSelection(previous.selection);
    onChange(previous.document);
  }
  function redo() {
    if (locked || extracting || !document || !future.length) return;
    const next = future[0];
    setHistory((h) => [...h, { document, selection }]);
    setFuture(future.slice(1));
    setSelection(next.selection);
    onChange(next.document);
  }
  function copy() {
    if (document && selection.length) {
      setClipboard(copyPaths(document, selection));
      onMessage(`已复制 ${selection.length} 条完整路径`);
    }
  }
  function remove() {
    if (document && selection.length)
      commit(deletePaths(document, selection), []);
  }
  function cut() {
    if (locked || extracting) return;
    copy();
    remove();
  }
  function paste() {
    if (!document || locked || extracting || !clipboard.length) return;
    const next = pastePaths(document, clipboard);
    commit(next.document, next.selection);
    onMessage(`已粘贴 ${next.selection.length} 条路径，可直接拖动定位`);
  }
  function all() {
    if (document) {
      setSelection(document.strokes.map((_, i) => i));
    }
  }
  useEffect(() => {
    function keyboard(e: KeyboardEvent) {
      if (e.key === "Escape" && drag.current) {
        e.preventDefault();
        cancelDrag();
        return;
      }
      const target = e.target as HTMLElement;
      if (
        target.closest(
          "input,textarea,select,[contenteditable=true],[role=dialog],[data-registration-handle]",
        ) ||
        !canvasFocused.current ||
        locked ||
        extracting ||
        !document
      )
        return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "a") {
        e.preventDefault();
        all();
      } else if (mod && key === "c") {
        e.preventDefault();
        copy();
      } else if (mod && key === "x") {
        e.preventDefault();
        cut();
      } else if (mod && key === "v") {
        e.preventDefault();
        paste();
      } else if (mod && key === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        redo();
      } else if (key === "delete" || key === "backspace") {
        e.preventDefault();
        remove();
      } else if (key === "escape") {
        setSelection([]);
      } else if (
        ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key) &&
        document &&
        selection.length
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 1;
        commit(
          movePaths(
            document,
            selection,
            key === "arrowleft" ? -step : key === "arrowright" ? step : 0,
            key === "arrowup" ? -step : key === "arrowdown" ? step : 0,
          ),
        );
      }
    }
    window.addEventListener("keydown", keyboard);
    const outside = (e: globalThis.PointerEvent) => {
      canvasFocused.current = !!(e.target as Element).closest(".canvas-panel");
    };
    window.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", keyboard);
      window.removeEventListener("pointerdown", outside);
    };
  });
  function point(e: PointerEvent<SVGGElement>): Point {
    const svg = e.currentTarget.ownerSVGElement!;
    const ctm = svg.getScreenCTM?.();
    if (ctm) {
      const p = svg.createSVGPoint();
      p.x = e.clientX;
      p.y = e.clientY;
      return p.matrixTransform(ctm.inverse());
    }
    const r = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * svg.viewBox.baseVal.width,
      y: ((e.clientY - r.top) / r.height) * svg.viewBox.baseVal.height,
    };
  }
  function down(e: PointerEvent<SVGGElement>) {
    if (!active || !document || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    canvasFocused.current = true;
    (window.document.activeElement as HTMLElement)?.blur();
    const p = point(e),
      svg = e.currentTarget.ownerSVGElement!,
      tolerance =
        (4 / svg.getBoundingClientRect().width) * svg.viewBox.baseVal.width;
    const hit = hitStroke(document, p, tolerance);
    const inside =
      box &&
      p.x >= box.x &&
      p.x <= box.x + box.width &&
      p.y >= box.y &&
      p.y <= box.y + box.height;
    let ids = selection;
    let kind: "move" | "box" = "box";
    if (e.shiftKey) {
      if (hit !== null) {
        setSelection(
          selected.has(hit)
            ? selection.filter((i) => i !== hit)
            : [...selection, hit],
        );
        return;
      }
    } else if (inside && selection.length) {
      kind = "move";
    } else if (hit !== null) {
      ids = [hit];
      setSelection(ids);
      kind = "move";
    } else {
      setSelection([]);
      ids = [];
    }
    drag.current = {
      start: p,
      current: p,
      kind,
      document,
      selection: ids,
      append: e.shiftKey,
      owner: e.currentTarget,
      pointerId: e.pointerId,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (kind === "box") setMarquee(rectangle(p, p));
  }
  function move(e: PointerEvent<SVGGElement>) {
    const d = drag.current;
    if (!d || !active) return;
    const p = point(e);
    d.current = p;
    if (d.kind === "resize" && d.handle && d.bounds) {
      const origin = handlePoint(d.bounds, d.handle);
      setDraft(resizeFromHandle(d.document, d.selection, d.handle, { x: origin.x + p.x - d.start.x, y: origin.y + p.y - d.start.y }, proportional));
    }
    else if (d.kind === "rotate" && d.bounds) {
      const degrees = rotationFromPointer(d.bounds, d.start, p, e.shiftKey);
      setDraft(rotatePaths(d.document, d.selection, degrees));
      setRotationPreview({ box: d.bounds, angle: degrees });
    } else if (d.kind === "move")
      setDraft(
        movePaths(d.document, d.selection, p.x - d.start.x, p.y - d.start.y),
      );
    else setMarquee(rectangle(d.start, p));
  }
  function up(e: PointerEvent<SVGGElement>) {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setMarquee(null);
    setRotationPreview(null);
    if (!active) {
      setDraft(null);
      return;
    }
    const p = point(e);
    if ((d.kind === "resize" && d.handle) || (d.kind === "rotate" && d.bounds)) {
      setDraft(null);
      if (!lockedRef.current && Math.hypot(p.x - d.start.x, p.y - d.start.y) > .01) {
        const origin = d.handle && d.bounds ? handlePoint(d.bounds, d.handle) : p;
        commit(d.kind === "resize" ? resizeFromHandle(d.document, d.selection, d.handle!, { x: origin.x + p.x - d.start.x, y: origin.y + p.y - d.start.y }, proportional) : rotatePaths(d.document, d.selection, rotationFromPointer(d.bounds!, d.start, p, e.shiftKey)), d.selection);
      }
    } else if (d.kind === "move") {
      setDraft(null);
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 0.01)
        commit(
          movePaths(d.document, d.selection, p.x - d.start.x, p.y - d.start.y),
          d.selection,
        );
    } else {
      const ids = selectByRectangle(d.document, rectangle(d.start, p));
      setSelection(d.append ? [...new Set([...d.selection, ...ids])] : ids);
    }
    if (d.owner.hasPointerCapture(e.pointerId)) d.owner.releasePointerCapture(e.pointerId);
  }
  function handleDown(e: PointerEvent<SVGGElement>, handle?: ResizeHandle) {
    if (!active || lockedRef.current || !document || !box || e.button !== 0 || drag.current) return;
    e.preventDefault();
    e.stopPropagation();
    canvasFocused.current = true;
    (window.document.activeElement as HTMLElement)?.blur();
    const p = point(e);
    drag.current = { start: p, current: p, kind: handle ? "resize" : "rotate", document, selection: [...selection], append: false, handle, bounds: box, owner: e.currentTarget, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  const lineShapes = useMemo(
    () =>
      visible?.strokes.map((s, i) => (
        <polyline
          key={i}
          points={s.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke={writtenIds?.has(visible.strokeIds?.[i] || "") ? "#159875" : selected.has(i) ? "#6f55df" : "#29324d"}
          strokeWidth={selected.has(i) ? 0.5 : 0.28}
          strokeLinecap="round"
          strokeLinejoin="round"
        >{writtenIds?.has(visible.strokeIds?.[i] || "") && <title>已书写</title>}</polyline>
      )),
    [visible, selection, writtenIds],
  );
  const layer = (
    <g
      className={active ? "canvas-edit-layer active" : "canvas-edit-layer"}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}
      style={{ touchAction: active ? "none" : "auto" }}
    >
      {active && visible && (
        <rect
          x={0}
          y={0}
          width={visible.width_mm}
          height={visible.height_mm}
          fill="transparent"
        />
      )}
      {lineShapes}
      {marquee && (
        <rect
          x={marquee.x}
          y={marquee.y}
          width={marquee.width}
          height={marquee.height}
          fill="#7362da18"
          stroke="#8970e5"
          strokeWidth={0.3}
          strokeDasharray="1 .7"
          pointerEvents="none"
        />
      )}
    </g>
  );
  const frame = rotationPreview?.box || box;
  const handleNames: Record<ResizeHandle, string> = { nw: "左上", n: "上中", ne: "右上", e: "右中", se: "右下", s: "下中", sw: "左下", w: "左中" };
  const handles = active && frame ? <g ref={handlesRef} className="selection-handles" transform={rotationPreview ? `rotate(${rotationPreview.angle} ${frame.x + frame.width / 2} ${frame.y + frame.height / 2})` : undefined} onPointerMove={move} onPointerUp={up} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} style={{ touchAction: "none" }}>
    <rect x={frame.x} y={frame.y} width={Math.max(.05, frame.width)} height={Math.max(.05, frame.height)} fill="none" stroke="#8970e5" strokeWidth={screenUnit} pointerEvents="none" />
    <line x1={frame.x + frame.width / 2} x2={frame.x + frame.width / 2} y1={frame.y} y2={frame.y - 24 * screenUnit} stroke="#8970e5" strokeWidth={screenUnit} pointerEvents="none" />
    {resizeHandles.map((handle) => {
      const p = handlePoint(frame, handle);
      const enabled = ((handle.includes("e") || handle.includes("w")) && frame.width > 0) || ((handle.includes("n") || handle.includes("s")) && frame.height > 0);
      return <g key={handle} role="button" tabIndex={enabled ? 0 : -1} aria-label={`${handleNames[handle]}缩放手柄`} aria-disabled={!enabled} data-resize-handle={handle} className={`selection-handle handle-${handle}`} onPointerDown={(e) => { if (enabled) handleDown(e, handle); }} onKeyDown={(e) => {
        if (!enabled || !document || !box || lockedRef.current || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        const step = e.shiftKey ? 5 : 1;
        const origin = handlePoint(box, handle);
        commit(resizeFromHandle(document, selection, handle, { x: origin.x + (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0), y: origin.y + (e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0) }, proportional));
      }}>
        <title>{handleNames[handle]}缩放；角点遵循比例锁，边中点单轴缩放</title>
        <circle cx={p.x} cy={p.y} r={10 * screenUnit} fill="transparent" />
        <circle cx={p.x} cy={p.y} r={4 * screenUnit} fill="white" stroke="#8164d5" strokeWidth={1.25 * screenUnit} pointerEvents="none" />
      </g>;
    })}
    <g role="button" tabIndex={0} aria-label="旋转选区手柄" className="selection-rotate-handle" onPointerDown={(e) => handleDown(e)} onKeyDown={(e) => {
      if (!document || lockedRef.current || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      commit(rotatePaths(document, selection, (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 15 : 1)));
    }}>
      <title>拖动绕中心旋转，Shift 吸附 15°；方向键旋转</title>
      <circle cx={frame.x + frame.width / 2} cy={frame.y - 24 * screenUnit} r={12 * screenUnit} fill="transparent" />
      <circle cx={frame.x + frame.width / 2} cy={frame.y - 24 * screenUnit} r={8 * screenUnit} fill="white" stroke="#8164d5" strokeWidth={screenUnit} pointerEvents="none" />
      <RotateCw x={frame.x + frame.width / 2 - 5 * screenUnit} y={frame.y - 29 * screenUnit} width={10 * screenUnit} height={10 * screenUnit} color="#7256bd" pointerEvents="none" />
    </g>
  </g> : null;
  const toolbar = (
    <div className="path-edit-toolbar">
      {onResetWritten && selection.some((index) => writtenIds?.has(document?.strokeIds?.[index] || "")) && <button className="button" disabled={locked || extracting} onClick={() => onResetWritten(selection)}>重置选区书写标记</button>}
      {document && (
        <>
          <button
            className="icon-button"
            title="全选路径 Ctrl+A"
            disabled={!document || locked || extracting}
            onClick={all}
          >
            <CheckSquare size={16} />
          </button>
          <button className="icon-button" title="复制 Ctrl+C" disabled={!selection.length || locked || extracting} onClick={copy}><Copy size={16} /></button>
          <button className="icon-button" title="剪切 Ctrl+X" disabled={!selection.length || locked || extracting} onClick={cut}><Scissors size={16} /></button>
          <button className="icon-button" title="粘贴 Ctrl+V" disabled={!clipboard.length || locked || extracting} onClick={paste}><ClipboardPaste size={16} /></button>
          <button className="icon-button danger-icon" title="删除 Delete" disabled={!selection.length || locked || extracting} onClick={remove}><Trash2 size={16} /></button>
          <span className="edit-toolbar-note">
            {extracting
              ? "字形提取中，编辑已暂停"
              : locked
                ? "作业进行中，编辑已锁定"
                : selection.length
                  ? `已选 ${selection.length} 条完整路径`
                  : "直接在白纸拖框选择；拖动选区移动，Shift 追加"}
          </span>
        </>
      )}
    </div>
  );
  const historyToolbar = <div className="history-tools" role="group" aria-label="编辑历史">
    <button className="icon-button" title="撤销 Ctrl+Z" disabled={!history.length || locked || extracting} onClick={undo}><Undo2 size={16} /><span>撤销</span></button>
    <button className="icon-button" title="重做 Ctrl+Shift+Z" disabled={!future.length || locked || extracting} onClick={redo}><Redo2 size={16} /><span>重做</span></button>
  </div>;
  const inspector =
    selection.length > 0 && box && document ? (
      <div className="selection-inspector">
        <div className="selection-inspector-head">
          <strong>
            选区变换 <small>{selection.length} 条路径</small>
          </strong>
          <div>
            <button
              className="icon-button"
              title="取消选择"
              onClick={() => setSelection([])}
            >
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="selection-fields">
          <NumericEdit
            label="X"
            value={box.x}
            disabled={locked || extracting}
            onCommit={(x) =>
              safe(() => commit(movePaths(document, selection, x - box.x, 0)))
            }
          />
          <NumericEdit
            label="Y"
            value={box.y}
            disabled={locked || extracting}
            onCommit={(y) =>
              safe(() => commit(movePaths(document, selection, 0, y - box.y)))
            }
          />
          <NumericEdit
            label="宽"
            value={box.width}
            disabled={locked || extracting || box.width === 0}
            onCommit={(w) =>
              safe(() =>
                commit(
                  resizePaths(
                    document,
                    selection,
                    w,
                    proportional && box.width
                      ? (box.height * w) / box.width
                      : box.height,
                  ),
                ),
              )
            }
          />
          <button
            className={proportional ? "ratio-lock on" : "ratio-lock"}
            title={proportional ? "等比缩放已开启" : "允许独立拉伸宽高"}
            onClick={() => setProportional((v) => !v)}
          >
            {proportional ? (
              <LockKeyhole size={14} />
            ) : (
              <UnlockKeyhole size={14} />
            )}
          </button>
          <NumericEdit
            label="高"
            value={box.height}
            disabled={locked || extracting || box.height === 0}
            onCommit={(h) =>
              safe(() =>
                commit(
                  resizePaths(
                    document,
                    selection,
                    proportional && box.height
                      ? (box.width * h) / box.height
                      : box.width,
                    h,
                  ),
                ),
              )
            }
          />
          <label className="edit-numeric angle">
            <span>旋转</span>
            <DraftNumberInput
              aria-label="选区旋转角度"
              type="number"
              value={angle}
              disabled={locked || extracting}
              onChange={(e) => setAngle(Number(e.target.value) || 0)}
            />
            <small>°</small>
          </label>
          <button
            className="button small"
            disabled={locked || extracting || angle === 0}
            onClick={() =>
              safe(() => {
                commit(rotatePaths(document, selection, angle));
                setAngle(0);
              })
            }
          >
            应用
          </button>
        </div>
        <p>
          框选按完整路径操作，不裁断笔画。首点标为橙色；校准后按固定画布位置实写，Jog
          只移动笔尖。
        </p>
      </div>
    ) : null;
  return {
    selection,
    undo, redo, copy, cut, paste, remove, selectAll: all,
    canUndo: active && history.length > 0,
    canRedo: active && future.length > 0,
    canCopy: active && selection.length > 0,
    canPaste: active && clipboard.length > 0,
    canSelectAll: active && !!document?.strokes.length,
    layer,
    handles,
    toolbar,
    historyToolbar,
    inspector,
    displayDocument: visible,
    clearSelection: () => setSelection([]),
    commitAll: (next: Drawing, selection: number[] = []) => commit(next, selection),
    hasEdits: history.length > 0,
  };
}
