import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent, type FocusEvent } from "react";

type Drag = { id: number; owner: Element; viewport: HTMLDivElement; x: number; y: number; left: number; top: number };

function textTarget(target: EventTarget | null) {
  return target instanceof window.Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

/** Bind to the scrolling canvas viewport; only scroll offsets are changed. */
export function useCanvasPan(selected: boolean, blocked = false) {
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const drag = useRef<Drag | null>(null);
  const pointer = useRef<number | null>(null);
  const finish = () => {
    const previous = drag.current;
    drag.current = null;
    pointer.current = null;
    setPanning(false);
    if (previous?.owner.hasPointerCapture(previous.id)) previous.owner.releasePointerCapture(previous.id);
  };
  useEffect(() => {
    const cancel = () => { setSpace(false); finish(); };
    window.addEventListener("blur", cancel);
    return () => { window.removeEventListener("blur", cancel); finish(); };
  }, []);
  useEffect(() => { finish(); }, [selected, blocked]);

  const panActive = !blocked && (selected || space);
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current && drag.current.id === event.pointerId) { event.stopPropagation(); finish(); }
    else if (pointer.current === event.pointerId) pointer.current = null;
  };
  return {
    panActive,
    panning,
    bind: {
      onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
        if (drag.current) { event.preventDefault(); event.stopPropagation(); return; }
        if (pointer.current !== null || textTarget(event.target)) return;
        pointer.current = event.pointerId;
        if (blocked || !(panActive && event.button === 0 || event.button === 1)) return;
        const viewport = event.currentTarget;
        // Capturing inside the overlay keeps its coordinate readout observing moves.
        const owner = (event.target instanceof window.Element && event.target.closest(".canvas-pointer-wrapper")) || viewport;
        viewport.focus({ preventScroll: true });
        owner.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, owner, viewport, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
        setPanning(true);
        event.preventDefault();
        event.stopPropagation();
      },
      onPointerMoveCapture(event: PointerEvent<HTMLDivElement>) {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        current.viewport.scrollLeft = current.left + current.x - event.clientX;
        current.viewport.scrollTop = current.top + current.y - event.clientY;
        // Hover overlays keep receiving moves; editor never received this drag's down.
        event.preventDefault();
      },
      onPointerUpCapture: end,
      onPointerCancelCapture: end,
      onLostPointerCapture: end,
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.code === "Escape") { setSpace(false); finish(); }
        if (event.code !== "Space" || textTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        if (!blocked && pointer.current === null) setSpace(true);
      },
      onKeyUp(event: KeyboardEvent<HTMLDivElement>) {
        if (event.code !== "Space" || textTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        setSpace(false);
        if (!selected) finish();
      },
      onBlur(event: FocusEvent<HTMLDivElement>) {
        if (!event.currentTarget.contains(event.relatedTarget)) { setSpace(false); finish(); }
      },
    },
  };
}
