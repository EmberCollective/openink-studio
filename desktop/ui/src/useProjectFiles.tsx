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

export function useProjectFiles({ snapshot, path, onPath, blocked, desktop, onSave, onOpen, onNew, onMessage }: {
  snapshot: Project; path: string; onPath: (path: string) => void; blocked: boolean; desktop: boolean;
  onSave: (path: string, project: Project) => Promise<void>;
  onOpen: (path: string) => Promise<void>; onNew: () => Promise<void>;
  onMessage: (message: string, error?: boolean) => void;
}) {
  const key = useMemo(() => JSON.stringify(snapshot), [snapshot]);
  const [clean, setClean] = useState(key), [pending, setPending] = useState(false);
  const [prompt, setPrompt] = useState(false), [recent, setRecent] = useState(recentProjects);
  const choice = useRef<((choice: Choice) => void) | null>(null);
  const operation = useRef(false), cleanAfterRestore = useRef(false);
  const current = useRef({ snapshot, key, path, blocked, onSave, onOpen, onNew, onMessage });
  current.current = { snapshot, key, path, blocked, onSave, onOpen, onNew, onMessage };
  const dirty = clean !== key;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  useEffect(() => {
    if (cleanAfterRestore.current) { cleanAfterRestore.current = false; setClean(key); }
  }, [key, pending]);
  useEffect(() => () => { choice.current?.("cancel"); }, []);
  function remember(value: string) {
    setRecent(old => {
      const next = [value, ...old.filter(p => p !== value)].slice(0, 8);
      try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch { /* Private storage may be unavailable. */ }
      return next;
    });
  }
  async function write(as = false): Promise<boolean> {
    const saved = current.current;
    const legacy = /\.kjoy$/i.test(saved.path);
    const selected = as || !saved.path || legacy ? await save({ defaultPath: saved.path.replace(/\.kjoy$/i, ".inkproj") || "书写工程.inkproj", filters: [{ name: "OpenInk 工程包", extensions: ["inkproj"] }] }) : saved.path;
    if (!selected) return false;
    if (current.current.blocked) return false;
    await saved.onSave(selected, saved.snapshot);
    onPath(selected); setNativeProjectTitle(selected); setClean(saved.key); remember(selected);
    saved.onMessage(`已保存完整工程 ${selected.split(/[\\/]/).pop()}`);
    // Edits made while the dialog or write was pending must remain unsaved.
    return current.current.key === saved.key;
  }
  async function guard(): Promise<boolean> {
    if (!dirtyRef.current) return true;
    const answer = await new Promise<Choice>(resolve => { choice.current = resolve; setPrompt(true); });
    if (answer === "cancel") return false;
    return answer === "discard" || await write();
  }
  async function run(action: () => Promise<void>) {
    if (current.current.blocked || operation.current) return;
    operation.current = true; setPending(true);
    try { await action(); } catch (e) { current.current.onMessage(String(e), true); }
    finally { operation.current = false; setPending(false); }
  }
  const saveProject = (as = false) => run(async () => { await write(as); });
  const openProject = (selected?: string) => run(async () => {
    const value = selected || await open({ multiple: false, filters: [{ name: "OpenInk / 旧版工程包", extensions: ["inkproj", "kjoy"] }] });
    if (typeof value !== "string" || !await guard() || current.current.blocked) return;
    await current.current.onOpen(value);
    onPath(value); setNativeProjectTitle(value); remember(value); cleanAfterRestore.current = true;
  });
  const newProject = () => run(async () => {
    if (!await guard() || current.current.blocked) return;
    await current.current.onNew(); onPath(""); setNativeProjectTitle(""); cleanAfterRestore.current = true;
  });
  const close = useRef(async () => {});
  close.current = async () => {
    if (current.current.blocked) { current.current.onMessage("请先停止当前任务，再关闭工程", true); return; }
    await run(async () => {
      if (!await guard() || current.current.blocked) return;
      // The native close request has already been prevented. Only destroy after
      // the unsaved-work guard succeeds, and let run() report native failures.
      await getCurrentWindow().destroy();
    });
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
    <div className="project-confirm-actions"><button className="button" autoFocus onClick={() => answer("cancel")}>取消</button><button className="button" onClick={() => answer("discard")}>不保存</button><button className="button primary" onClick={() => answer("save")}>保存并继续</button></div>
  </div></div> : null;
  return { dirty, pending, recent, saveProject, openProject, newProject, confirmation };
}
