import { useEffect, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";

export function dragWindow(event: MouseEvent<HTMLElement>, desktop: boolean, onError: (message: string) => void) {
  if (!desktop || event.button !== 0 || event.target !== event.currentTarget) return;
  event.preventDefault();
  const window = getCurrentWindow();
  void (event.detail === 2 ? window.toggleMaximize() : window.startDragging()).catch(error => onError(String(error)));
}

export function WindowControls({ desktop, onError }: { desktop: boolean; onError: (message: string) => void }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const menus = () => [...document.querySelectorAll<HTMLDetailsElement>(".native-titlebar .workspace-menu[open]")];
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      menus().forEach(menu => { if (!menu.contains(target)) menu.open = false; });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const open = menus();
      if (!open.length) return;
      open.forEach(menu => { menu.open = false; });
      open[0].querySelector("summary")?.focus(); event.preventDefault();
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => {
    if (!desktop) return;
    const window = getCurrentWindow();
    let disposed = false, unlisten: (() => void) | undefined;
    const update = () => { void window.isMaximized().then(value => { if (!disposed) setMaximized(value); }).catch(() => {}); };
    update();
    void window.onResized(update).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);
  const run = (action: "minimize" | "toggleMaximize" | "close") => {
    if (desktop) void getCurrentWindow()[action]().catch(error => onError(String(error)));
  };
  return <div className="window-controls" aria-label="窗口控制">
    <button className="icon-button" disabled={!desktop} aria-label="最小化窗口" title="最小化" onClick={() => run("minimize")}><Minus size={14} /></button>
    <button className="icon-button" disabled={!desktop} aria-label={maximized ? "还原窗口" : "最大化窗口"} title={maximized ? "还原" : "最大化"} onClick={() => run("toggleMaximize")}>{maximized ? <Copy size={12} /> : <Square size={12} />}</button>
    <button className="icon-button window-close" disabled={!desktop} aria-label="关闭窗口" title="关闭" onClick={() => run("close")}><X size={16} /></button>
  </div>;
}
