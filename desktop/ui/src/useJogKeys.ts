import { useEffect, useRef } from "react";

export function useJogKeys(enabled: boolean, step: number, feed: number, command: (request: Record<string, unknown>) => Promise<unknown>) {
  const current = useRef({ enabled, step, feed, command });
  current.current = { enabled, step, feed, command };
  useEffect(() => {
    let focused = true, pending = false;
    const held = new Set<string>();
    const editable = (target: EventTarget | null) => target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
    const down = (event: KeyboardEvent) => {
      const direction: Record<string, [number, number]> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
      const vector = direction[event.key], state = current.current;
      if (!vector || !state.enabled || !focused || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || editable(event.target) || editable(document.activeElement) || document.querySelector('[role="dialog"], .modal-overlay')) return;
      event.preventDefault();
      if (event.repeat || held.has(event.key) || pending) return;
      held.add(event.key); pending = true;
      const distance = state.step * (event.shiftKey ? 2 : 1);
      void state.command({ type: "jog", x: vector[0] * distance, y: vector[1] * distance, feed: state.feed }).finally(() => { pending = false; });
    };
    const up = (event: KeyboardEvent) => { held.delete(event.key); };
    const blur = () => { focused = false; held.clear(); };
    const focus = () => { focused = true; };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    window.addEventListener("blur", blur); window.addEventListener("focus", focus);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); window.removeEventListener("focus", focus); };
  }, []);
}
