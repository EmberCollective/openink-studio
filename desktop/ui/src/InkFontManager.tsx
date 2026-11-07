import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, FilePlus2, FolderOpen, PenTool, Plus, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { InkConfirm, InkGlyphEditor, InkGlyphView } from "./InkGlyphEditor";
import { inkfontDelete, inkfontExport, inkfontImport, inkfontList, inkfontLoad, inkfontSave, newInkPackage, newInkVariant, previewInkText, replaceVariant, type InkPackage, type InkSummary, type InkVariant } from "./inkfont";
import "./inkfont.css";

export function InkFontManager({ onClose, onChanged, renderImport, initialPackageId, privateGfont = false }: { onClose: () => void; onChanged: () => void; renderImport: (pack: InkPackage, onSaved: (pack: InkPackage) => void, onCancel: () => void) => ReactNode; initialPackageId?: string; privateGfont?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), loading = useRef(false), mounted = useRef(true);
  const [packages, setPackages] = useState<InkSummary[]>([]), [pack, setPack] = useState<InkPackage | null>(null), [busy, setBusy] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [query, setQuery] = useState(""), [character, setCharacter] = useState("");
  const [editor, setEditor] = useState<InkVariant | null>(null), [importing, setImporting] = useState(false), [newName, setNewName] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; detail: string; action: () => Promise<void> } | null>(null);
  const [tab, setTab] = useState<"characters" | "preview">("characters"), [sample, setSample] = useState(""), [preview, setPreview] = useState<ReturnType<typeof previewInkText> | null>(null);
  const [undo, setUndo] = useState<InkPackage | null>(null);
  const [visibleCount, setVisibleCount] = useState(120);
  const byCharacter = useMemo(() => {
    const groups = new Map<string, InkVariant[]>();
    for (const variant of pack?.variants || []) {
      const items = groups.get(variant.character) || []; items.push(variant); groups.set(variant.character, items);
    }
    return groups;
  }, [pack]);
  const characters = [...byCharacter.keys()];
  const filtered = characters.filter(c => !query || Array.from(query).includes(c));
  const variants = byCharacter.get(character) || [];
  useEffect(() => setVisibleCount(120), [query, pack?.id]);
  async function work(label: string, action: () => Promise<void>) {
    if (loading.current) return;
    loading.current = true; setBusy(label); setError("");
    try { await action(); } catch (e) { if (mounted.current) setError(String(e)); }
    finally { loading.current = false; if (mounted.current) setBusy(""); }
  }
  function select(next: InkPackage) {
    setPack(next); setCharacter(next.variants[0]?.character || ""); setQuery(""); setPreview(null); setUndo(null); setNotice("");
    setSample([...new Set(next.variants.map(v => v.character))].slice(0, 16).join(""));
  }
  async function refresh(id?: string) {
    const list = await inkfontList(); if (!mounted.current) return;
    setPackages(list);
    const chosen = list.find(p => p.id === id) || list[0];
    if (chosen) { const loaded = await inkfontLoad(chosen.id); if (mounted.current) select(loaded); }
    else { setPack(null); setPreview(null); setUndo(null); }
  }
  useEffect(() => {
    mounted.current = true; const node = dialog.current; node?.showModal();
    void work("读取字包", () => refresh(initialPackageId));
    return () => { mounted.current = false; node?.close(); };
  }, []);
  async function persist(next: InkPackage, deleted = false) {
    const saved = await inkfontSave(next);
    setPack(saved); setUndo(deleted ? pack : null); onChanged();
    if (!saved.variants.some(v => v.character === character)) setCharacter(saved.variants[0]?.character || "");
    setPackages(await inkfontList());
    return saved;
  }
  async function importFile() {
    const path = await open({ title: privateGfont ? "导入 OpenInk 字包或转换 gfont" : "导入 OpenInk 字包", filters: [{ name: privateGfont ? "OpenInk 字包 / gfont 字体" : "OpenInk 字包", extensions: privateGfont ? ["inkfont", "gfont"] : ["inkfont"] }] });
    if (typeof path !== "string") return;
    const imported = await inkfontImport(path); onChanged(); await refresh(imported.id);
    setNotice(/\.gfont$/i.test(path) ? `已转换为 OpenInk 字包，共 ${imported.variants.length} 个字形，可编辑或导出。空白与无笔迹字符不入库；全库统一适配字面，保留大小比例和笔顺。` : "字包已导入，保留所有同字写法。");
  }
  async function exportFile() {
    if (!pack) return;
    const path = await save({ title: "导出 OpenInk 字包", defaultPath: `${pack.name.replace(/[<>:"/\\|?*]/g, "_")}.inkfont`, filters: [{ name: "OpenInk 字包", extensions: ["inkfont"] }] });
    if (!path) return;
    await inkfontExport(pack.id, path); setNotice("字包已导出，可备份或导入其他设备。");
  }
  function removeVariant(variant?: InkVariant) {
    if (!pack) return;
    const count = variant ? 1 : variants.length;
    setConfirm({ title: variant ? `删除「${variant.character}」的这个写法？` : `删除「${character}」的全部写法？`, detail: `将从「${pack.name}」移除 ${count} 个字形，已有画布笔迹不变。`, action: async () => {
      await persist({ ...pack, variants: pack.variants.filter(v => variant ? v.id !== variant.id : v.character !== character) }, true);
      setNotice(`已删除 ${count} 个字形，可撤销本次删除。`);
    } });
  }
  async function savedImport(next: InkPackage) {
    setImporting(false); select(next); setNotice("校准字形已入库，同字的所有写法均保留。"); onChanged();
    await work("刷新字包", async () => setPackages(await inkfontList()));
  }
  return <dialog ref={dialog} className="modal inkfont-dialog" aria-label="OpenInk 字库管理" onCancel={e => { e.preventDefault(); if (!busy && !editor && !importing) onClose(); }}>
    {editor && pack ? <InkGlyphEditor key={editor.id} variant={editor} packName={pack.name} onExit={() => setEditor(null)} onSave={async v => { const next = await persist(replaceVariant(pack, v)); setEditor(null); setCharacter(v.character); setNotice(`「${v.character}」已保存，共 ${next.variants.filter(g => g.character === v.character).length} 种写法。`); }} />
      : importing && pack ? renderImport(pack, next => void savedImport(next), () => setImporting(false))
      : <div className="ink-manager">
        <header className="ink-header"><div><strong>OpenInk 字库</strong><p className="field-note">一个字包，多种写法 · 本地保存</p></div><div className="ink-tools"><button className="button" disabled={!!busy} onClick={() => void work("刷新字包", () => refresh(pack?.id))}><RefreshCw size={16} />刷新</button><button className="icon-button" aria-label="关闭字库管理" title="关闭" disabled={!!busy} onClick={onClose}><X size={18} /></button></div></header>
        <div className="ink-manager-body">
          <aside className="section ink-packages"><h3>我的字包</h3><button className="button" disabled={!!busy} onClick={() => setNewName("我的手写字包")}><Plus size={16} />新建字包</button><div className="ink-package-list">{packages.map(item => <button key={item.id} className="button" aria-pressed={pack?.id === item.id} disabled={!!busy} onClick={() => void work("读取字包", async () => select(await inkfontLoad(item.id)))}><FolderOpen size={18} /><span>{item.name}<small>{item.characters.length} 字 · {item.variant_count} 字形</small></span></button>)}</div><button className="button" disabled={!!busy} onClick={() => void work("导入字包", importFile)}><Upload size={16} />{privateGfont ? "导入 .inkfont / .gfont" : "导入 .inkfont"}</button><p className="field-note">字包包含全部写法和可编辑笔迹，可导出备份。</p></aside>
          <main className="ink-main">{pack ? <>
            <div className="ink-package-heading"><div><h2>{pack.name} <small>.inkfont</small></h2><p className="field-note">{characters.length} 个字符 · {pack.variants.length} 份字形 · 同字的不同写法共同保留</p></div><div className="ink-tools"><button className="button" disabled={!!busy} onClick={() => void work("导出字包", exportFile)}><Download size={16} />导出字包</button><button className="button danger-icon" title="删除整个字包" aria-label="删除整个字包" disabled={!!busy} onClick={() => setConfirm({ title: `删除字包「${pack.name}」？`, detail: `将删除本机此字包的全部 ${pack.variants.length} 个字形。请先导出备份；已有画布笔迹保留。`, action: async () => { await inkfontDelete(pack.id, pack.revision); onChanged(); await refresh(); } })}><Trash2 size={16} />删除字包</button><button className="button primary" disabled={!!busy} onClick={() => setImporting(true)}><FilePlus2 size={16} />向此字包新增</button></div></div>
            <div className="ink-tabs"><button className="button" aria-pressed={tab === "characters"} onClick={() => setTab("characters")}>字符管理</button><button className="button" aria-pressed={tab === "preview"} onClick={() => setTab("preview")}>随机书写预览</button></div>
            {tab === "characters" ? <div className="ink-character-body">
              <section className="section ink-characters">
                <div className="ink-package-heading"><h3>字包中的字符</h3><button className="button" disabled={!!busy} onClick={() => setEditor(newInkVariant())}><PenTool size={15} />手绘新字符</button></div>
                <label className="ink-search"><Search size={16} /><input className="text-input" aria-label="搜索字包中的字符" placeholder="搜索一个字，或输入一句话查找" value={query} onChange={e => setQuery(e.target.value)} /></label>
                <p className="field-note">显示 {Math.min(visibleCount, filtered.length)} / {filtered.length} 个字符{query && ` · 字包共 ${characters.length} 字`}</p>
                <div className="ink-character-grid">{filtered.slice(0, visibleCount).map(c => { const options = byCharacter.get(c)!; return <button key={c} className="button ink-character-card" aria-label={`字符 ${c}，${options.length} 个字形`} aria-pressed={character === c} onClick={() => setCharacter(c)}><InkGlyphView variant={options[0]} /><span>{c}<small>{options.length} 个字形</small></span></button>; })}</div>
                {visibleCount < filtered.length && <button className="button" onClick={() => setVisibleCount(n => n + 120)}>显示更多字符</button>}
                {!filtered.length && <p className="field-note">{query ? "未找到这些字符，清空搜索或继续向字包新增。" : "字包还是空的。导入手写素材，或用画笔创建第一个字形。"}</p>}
              </section>
              <aside className="section ink-variants"><div className="ink-package-heading"><div><small>当前字符</small><h2>{character || "—"}</h2></div><button className="button" disabled={!!busy || !character} onClick={() => setEditor(newInkVariant(character))}><Plus size={15} />再写一个写法</button></div><p className="field-note">每次书写从本字包内随机选一种写法。编辑只影响选中的字形。</p><div className="ink-variant-list">{variants.map((variant, i) => <article key={variant.id} className="ink-variant"><InkGlyphView variant={variant} /><div><strong>写法 {String(i + 1).padStart(2, "0")}</strong><p className="field-note">{variant.strokes.length} 条笔迹</p><div className="ink-tools"><button className="button" disabled={!!busy} onClick={() => setEditor(variant)}>编辑字形</button><button className="icon-button danger-icon" aria-label={`删除写法 ${i + 1}`} title="删除此写法" disabled={!!busy} onClick={() => removeVariant(variant)}><Trash2 size={16} /></button></div></div></article>)}</div><button className="button" disabled={!!busy || !variants.length} onClick={() => removeVariant()}>删除此字符的全部写法</button></aside>
            </div> : <section className="section ink-preview"><label>预览文字<textarea className="text-input" rows={3} value={sample} onChange={e => setSample(e.target.value)} maxLength={500} /></label><div className="ink-tools"><button className="button primary" disabled={!sample || !!busy} onClick={() => setPreview(previewInkText(pack, sample))}>重新随机生成</button><span className="field-note">每个字符独立抽取，允许重复。生成后笔迹固定；不会从其他字包取字。</span></div><div className="ink-preview-lines" aria-label="随机书写结果">{preview?.map((item, i) => item.character === "\n" ? <div key={i} className="ink-preview-break" /> : <div key={i} className="ink-preview-glyph" title={`${item.character} · ${item.variant ? `写法 ${item.ordinal}` : "缺字"}`}>{item.variant ? <><InkGlyphView variant={item.variant} writing /><small>{item.character} · 写法 {item.ordinal}</small></> : <><span>{item.character}</span>{item.character.trim() && <small className="ink-error">缺字</small>}</>}</div>)}</div>{!preview && <p className="field-note">输入文字后生成预览；缺失字符会标出，便于继续补字。</p>}</section>}
            <footer className="ink-package-footer"><p className="field-note">已保存至本机字库，字体来源选择「OpenInk 字库」即可用于版面。</p></footer>
          </> : <section className="section ink-empty"><FolderOpen size={38} /><h2>建立你的第一个手写字包</h2><p className="field-note">从 PDF、图片提取字形，人工校准后保存；也可以直接手绘。</p><button className="button primary" disabled={!!busy} onClick={() => setNewName("我的手写字包")}>新建字包</button></section>}</main>
        </div><footer className="ink-status" role="status"><span className={error ? "ink-error" : "field-note"}>{error || busy || notice || "字形修改自动写入本机字包；编辑器内请点击保存字形。"}</span>{undo && pack && <button className="button" disabled={!!busy} onClick={() => void work("撤销删除", async () => { await persist({ ...undo, revision: pack.revision }); setNotice("已恢复删除的字形。"); })}>撤销删除</button>}</footer>
      </div>}
    {newName !== null && <InkConfirm title="新建 OpenInk 字包" confirmText="创建字包" busy={!!busy} onCancel={() => setNewName(null)} onConfirm={() => { if (!newName.trim()) { setError("请输入字包名称。"); return; } void work("创建字包", async () => { const created = await inkfontSave(newInkPackage(newName)); onChanged(); await refresh(created.id); setNewName(null); }); }}><label>字包名称<input className="text-input" aria-label="新字包名称" maxLength={100} value={newName} disabled={!!busy} onChange={e => setNewName(e.target.value)} /></label>{error && <p className="ink-error">{error}</p>}</InkConfirm>}
    {confirm && <InkConfirm title={confirm.title} busy={!!busy} onCancel={() => setConfirm(null)} onConfirm={() => void work("正在保存", async () => { await confirm.action(); setConfirm(null); })}><p>{confirm.detail}</p>{error && <p className="ink-error">{error}</p>}</InkConfirm>}
  </dialog>;
}
