import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Project } from "./projectModel";

type Choice = "save" | "discard" | "cancel";
const recentKey = "openink-recent-projects";
function setNativeProjectTitle(path: string) {
  const name = path.split(/[\\/]/).pop() || "";
  void getCurrentWindow().setTitle(name ? `${name} · OpenInk Studio` : "OpenInk Studio · 自由书写").catch(() => undefined);
}
function recentProjects(): string[] {
  try { const value = JSON.parse(localStorage.getItem(recentKey) || "[]"); return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string").slice(0, 8) : []; }
  catch { return []; }
}

export function useProjectFiles({ snapshot, path, onPath, blocked, closeBlocked = blocked, closeWarning = "", desktop, onSave, onOpen, onNew, onMessage }: {
  snapshot: Project; path: string; onPath: (path: string) => void; blocked: boolean; desktop: boolean;
  closeBlocked?: boolean; closeWarning?: string;
  onSave: (path: string, project: Project) => Promise<void>;
  onOpen: (path: string) => Promise<void>; onNew: () => Promise<void>;
  onMessage: (message: string, error?: boolean) => void;
}) {
  const key = useMemo(() => JSON.stringify(snapshot), [snapshot]);
  const [clean, setClean] = useState(key), [pending, setPending] = useState(false);
  const [prompt, setPrompt] = useState(false), [recent, setRecent] = useState(recentProjects);
  const [closingPrompt, setClosingPrompt] = useState(false);
  const choice = useRef<((choice: Choice) => void) | null>(null);
  const operation = useRef(false), settleTimer = useRef<number | null>(null);
  const current = useRef({ snapshot, key, path, blocked, closeBlocked, closeWarning, onSave, onOpen, onNew, onMessage });
  current.current = { snapshot, key, path, blocked, closeBlocked, closeWarning, onSave, onOpen, onNew, onMessage };
  // 打开工程后，字体回填、校准面板回写、背景补渲染等异步更新会在“基线落定”
  // 之后继续修改快照。若直接比较快照，刚打开的工程会被误判为“已修改”，于是
  // 下一次打开/新建时又弹“保存当前工程的更改”。这里用“用户是否动过手”作为
  // 闸门：首个指针/键盘/拖放事件之前的变化一律算加载噪音，并在那一刻把基线
  // 对齐到当前快照；用户真正操作之后的变化才计为未保存。
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false); armedRef.current = armed;
  const dirty = armed && clean !== key;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  function disarm() { armedRef.current = false; setArmed(false); }
  useEffect(() => () => {
    choice.current?.("cancel");
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
  }, []);
  useEffect(() => {
    const arm = () => {
      if (armedRef.current) return;
      armedRef.current = true;
      // 把加载阶段积累的异步差异一次性吸收进基线，避免它被当成用户改动。
      setClean(current.current.key);
      setArmed(true);
    };
    window.addEventListener("pointerdown", arm, true);
    window.addEventListener("keydown", arm, true);
    window.addEventListener("drop", arm, true);
    return () => {
      window.removeEventListener("pointerdown", arm, true);
      window.removeEventListener("keydown", arm, true);
      window.removeEventListener("drop", arm, true);
    };
  }, []);
  // 启动期本身就在变：字体默认值、模板列表、最近工程都会改快照。
  // 这些不是用户改动，一并按“稳定后落记干净”处理。
  useEffect(() => { settleClean(); }, []);
  // 恢复工程会连续触发多轮状态更新（校准面板回填、批次选中、背景补渲染等）。
  // 只在第一轮就把快照记为“干净”，后面几轮又会把工程标成未保存，于是刚存完
  // 再打开仍会弹保存提示。这里等快照连续几拍不再变化，再落记为干净。
  function settleClean() {
    disarm();
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    let last = "", stable = 0;
    const tick = () => {
      const value = current.current.key;
      if (value === last) stable += 1; else { last = value; stable = 0; }
      setClean(value);
      settleTimer.current = stable >= 3 ? null : window.setTimeout(tick, 60);
    };
    tick();
  }
  // 空白工程没有可保存的内容：既不该拦路询问，也不该让“保存并继续”
  // 用一个空工程覆盖掉已有的工程文件。
  function hasContent(project: Project) {
    return project.pages.some(page => (page.document.strokes?.length ?? 0) > 0
      || !!page.document.text_settings?.text?.trim()
      || !!page.background?.path);
  }
  function remember(value: string) {
    setRecent(old => {
      const next = [value, ...old.filter(p => p !== value)].slice(0, 8);
      try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch { /* Private storage may be unavailable. */ }
      return next;
    });
  }
  async function write(as = false, closing = false): Promise<boolean> {
    const saved = current.current;
    const legacy = /\.kjoy$/i.test(saved.path);
    const selected = as || !saved.path || legacy ? await save({ defaultPath: saved.path.replace(/\.kjoy$/i, ".inkproj") || "书写工程.inkproj", filters: [{ name: "OpenInk 工程包", extensions: ["inkproj"] }] }) : saved.path;
    if (!selected) return false;
    if (closing ? current.current.closeBlocked : current.current.blocked) return false;
    await saved.onSave(selected, saved.snapshot);
    const settled = current.current.key === saved.key;
    onPath(selected); setNativeProjectTitle(selected); setClean(saved.key);
    if (settled) disarm(); remember(selected);
    saved.onMessage(`已保存完整工程 ${selected.split(/[\\/]/).pop()}`);
    // Edits made while the dialog or write was pending must remain unsaved.
    return settled;
  }
  async function guard(closing = false): Promise<boolean> {
    if (!hasContent(current.current.snapshot)) return true;
    if (!dirtyRef.current && !(closing && current.current.closeWarning)) return true;
    setClosingPrompt(closing);
    const answer = await new Promise<Choice>(resolve => { choice.current = resolve; setPrompt(true); });
    if (answer === "cancel") return false;
    return answer === "discard" || await write(false, closing);
  }
  async function run(action: () => Promise<void>, closing = false) {
    if ((closing ? current.current.closeBlocked : current.current.blocked) || operation.current) return;
    operation.current = true; setPending(true);
    try { await action(); } catch (e) { current.current.onMessage(String(e), true); }
    finally { operation.current = false; setPending(false); }
  }
  const saveProject = (as = false) => run(async () => { await write(as); });
  const openProject = (selected?: string) => run(async () => {
    const value = selected || await open({ multiple: false, filters: [{ name: "OpenInk / 旧版工程包", extensions: ["inkproj", "kjoy"] }] });
    if (typeof value !== "string" || !await guard() || current.current.blocked) return;
    await current.current.onOpen(value);
    onPath(value); setNativeProjectTitle(value); remember(value); settleClean();
  });
  const newProject = () => run(async () => {
    if (!await guard() || current.current.blocked) return;
    await current.current.onNew(); onPath(""); setNativeProjectTitle(""); settleClean();
  });
  const close = useRef(async () => {});
  close.current = async () => {
    if (current.current.closeBlocked) { current.current.onMessage("请先停止当前任务，再关闭工程", true); return; }
    await run(async () => {
      if (!await guard(true) || current.current.closeBlocked) return;
      // The native close request has already been prevented. Only destroy after
      // the unsaved-work guard succeeds, and let run() report native failures.
      await getCurrentWindow().destroy();
    }, true);
  };
  useEffect(() => {
    if (!desktop) return;
    let canceled = false, unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(event => {
      event.preventDefault(); void close.current();
    }).then(stop => { if (canceled) stop(); else unlisten = stop; }).catch(e => current.current.onMessage(`无法监听窗口关闭：${String(e)}`, true));
    return () => { canceled = true; unlisten?.(); };
  }, [desktop]);
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || prompt) return;
      const command = e.key.toLowerCase();
      if (!["s", "o", "n"].includes(command)) return;
      e.preventDefault();
      if (command === "s") void saveProject(e.shiftKey);
      else if (command === "o") void openProject();
      else void newProject();
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  });
  function answer(value: Choice) { const resolve = choice.current; choice.current = null; setPrompt(false); resolve?.(value); }
  const confirmation = prompt ? <div className="modal-overlay" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); answer("cancel"); }
    if (event.key === "Tab") {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault(); buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
    }
  }}><div className="modal project-confirmation" role="dialog" aria-modal="true" aria-labelledby="project-confirm-title">
    <h2 id="project-confirm-title">保存当前工程的更改？</h2>
    <p className="field-note">尚未保存的内容将在离开工程后丢失。</p>
    {closingPrompt && closeWarning && <p className="field-note" role="status">{closeWarning}</p>}
    <div className="project-confirm-actions"><button className="button" autoFocus onClick={() => answer("cancel")}>取消</button><button className="button" onClick={() => answer("discard")}>不保存</button><button className="button primary" onClick={() => answer("save")}>保存并继续</button></div>
  </div></div> : null;
  return { dirty, pending, recent, saveProject, openProject, newProject, confirmation };
}
