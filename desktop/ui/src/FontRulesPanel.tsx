import { useEffect, useMemo, useRef, useState } from "react";
import { DraftNumberInput } from "./DraftNumberInput";
import Toggle from "./Toggle";
import { Trash2, X } from "lucide-react";
import { boundsOf } from "./editorGeometry";
import { newFontRule, rangeFields, ruleError, scalarFields, type CharacterRule, type FontRule, type FontRuleLibrary } from "./fontRules";

type RulePreview = { document: { width_mm: number; height_mm: number; strokes: { x: number; y: number }[][] }; guides: { start: [number, number]; end: [number, number] }[] };
export function FontRulesPanel({ library, locked, onSave, onPreview, onClose, fonts = [], initialText = "山川与远方\n落笔皆有回响" }: { library: FontRuleLibrary; locked: boolean; onSave: (value: FontRuleLibrary) => void; onPreview: (rule: FontRule, seed: number, sample: { font: string; text: string }) => Promise<RulePreview>; onClose: () => void; fonts?: { id: string; name: string }[]; initialText?: string }) {
  const [sampleFont, setSampleFont] = useState("");
  const [sampleText, setSampleText] = useState(initialText);
  const [draft, setDraft] = useState<FontRule>(() => structuredClone(library.rules.find(r => r.id === library.selected) || newFontRule(crypto.randomUUID())));
  const [target, setTarget] = useState(-1), [inputError, setInputError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false), [previewError, setPreviewError] = useState("");
  const [retry, setRetry] = useState(0);
  const seed = useRef(crypto.getRandomValues(new Uint32Array(1))[0]);
  const version = useRef(0), inFlight = useRef(false);
  const queued = useRef<{ version: number; rule: FontRule; sample: { font: string; text: string } } | null>(null);
  const previewer = useRef(onPreview); previewer.current = onPreview;
  const drain = useRef<() => void>(() => {});
  const error = ruleError(draft) || inputError;
  drain.current = () => {
    if (inFlight.current || !queued.current) return;
    const request = queued.current; queued.current = null; inFlight.current = true;
    let timer: ReturnType<typeof setTimeout>;
    // One conversion at a time; edits replace the queued request, never a newer result.
    void Promise.race([
      Promise.resolve().then(() => previewer.current(request.rule, seed.current, request.sample)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("预览等待超时，可重试或减少输入文字；后台计算可能仍在继续")), 30000); }),
    ]).then(result => { if (version.current === request.version) { setPreview(result); setPreviewError(""); } }, e => {
      if (version.current === request.version) setPreviewError(String(e));
    }).finally(() => {
      clearTimeout(timer); inFlight.current = false;
      if (version.current === request.version) setPreviewBusy(false);
      drain.current();
    });
  };
  useEffect(() => {
    const current = ++version.current;
    queued.current = null; setPreviewError(""); setPreviewBusy(!error && !locked);
    const timer = !error && !locked ? setTimeout(() => { queued.current = { version: current, rule: draft, sample: { font: sampleFont, text: sampleText } }; drain.current(); }, 180) : undefined;
    return () => { clearTimeout(timer); ++version.current; queued.current = null; };
  }, [draft, error, locked, retry, sampleFont, sampleText]);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const box = useMemo(() => preview ? boundsOf({ ...preview.document, name: "预览" }) : null, [preview]);
  const padding = box ? Math.max(2, Math.min(8, box.height * .12)) : 2;
  const viewBox = box ? `${box.x - padding} ${box.y - padding} ${Math.max(1, box.width) + 2 * padding} ${Math.max(1, box.height) + 2 * padding}` : "0 0 100 100";
  const settings = target < 0 ? draft.general : draft.overrides[target].settings;
  const update = (value: CharacterRule) => setDraft(r => target < 0 ? { ...r, general: value } : { ...r, overrides: r.overrides.map((o, i) => i === target ? { ...o, settings: value } : o) });
  const number = (value: number, change: (v: number) => void, label: string, min: number, max: number) => <DraftNumberInput aria-label={label} className="text-input" type="number" value={value} min={min} max={max} step={0.1}
    onInput={e => {
      const raw = e.currentTarget.value, n = Number(raw);
      if (!raw.trim() || !Number.isFinite(n) || n < min || n > max) { setInputError(`${label}须在 ${min}～${max} 之间，请完成输入`); return; }
      setInputError(""); change(n);
    }} onBlur={() => setInputError("")} onChange={e => change(Number(e.target.value))} />;
  function save(copy: boolean) {
    if (error || locked) return;
    const rule = copy ? { ...draft, id: crypto.randomUUID(), name: `${draft.name.slice(0, 70)} 副本` } : draft;
    const rules = library.rules.filter(r => r.id !== rule.id).concat(rule);
    if (rules.length > 50) return;
    onSave({ rules, selected: rule.id }); onClose();
  }
  return <dialog ref={dialog} className="font-rules-dialog" aria-labelledby="font-rules-title" onCancel={onClose}>
    <header><div><h2 id="font-rules-title">字体规则</h2><p className="field-note">保存后用于主界面左侧选中的规则集，仅影响后续插入。</p></div><button className="icon-button" aria-label="关闭字体规则" title="关闭，不保存修改" onClick={onClose}><X size={20} /></button></header>
    <div className="font-rules-body">
      <nav className="font-rules-list" aria-label="当前规则列表">
        <strong>{draft.name || "新规则集"}</strong><p className="field-note">通用设置与字符覆盖</p>
        <button className="button full" aria-pressed={target === -1} onClick={() => setTarget(-1)}>通用规则<small>全部适用字符</small></button>
        {draft.overrides.map((o, i) => <div className="font-rule-list-item" key={i}><button className="button full" title={o.characters} aria-pressed={target === i} onClick={() => setTarget(i)}>{o.characters || "待填写字符"}<small>{Object.keys(o.settings).length ? `${Object.keys(o.settings).length} 项单独设置` : "沿用通用规则"}</small></button><button className="icon-button danger-icon" disabled={locked} aria-label={`删除字符规则：${o.characters || "待填写字符"}`} title="删除此字符规则" onClick={() => { setDraft(r => ({ ...r, overrides: r.overrides.filter((_, index) => index !== i) })); setTarget(t => t === i ? -1 : t > i ? t - 1 : t); setInputError(""); }}><Trash2 size={15} /></button></div>)}
        <button className="button full" disabled={locked || draft.overrides.length >= 100} onClick={() => { setDraft(r => ({ ...r, overrides: [...r.overrides, { characters: "", settings: {} }] })); setTarget(draft.overrides.length); }}>＋ 字符规则</button>
        <p className="field-note">指定字符只覆盖单独设置的项目；其余沿用通用规则。</p>
      </nav>
      <fieldset className="font-rules-settings" disabled={locked}>
        <div className="font-rule-settings-heading"><strong>{target < 0 ? "通用规则" : "字符规则"}</strong><button className="button" title={target < 0 ? "恢复通用参数及整行设置，保留规则名称和字符规则" : "清除当前字符的单独设置，恢复沿用通用规则"} onClick={() => {
          if (target < 0) setDraft(r => ({ ...newFontRule(r.id, r.name), overrides: r.overrides }));
          else update({});
          setInputError("");
        }}>恢复默认值</button></div>
        <label className="paper-field">规则名称<input className="text-input" value={draft.name} maxLength={80} onChange={e => setDraft(r => ({ ...r, name: e.target.value }))} /></label>
        {target >= 0 && <label className="paper-field">适用字符<input className="text-input" value={draft.overrides[target].characters} onChange={e => setDraft(r => ({ ...r, overrides: r.overrides.map((o, i) => i === target ? { ...o, characters: e.target.value } : o) }))} /></label>}
        <div className="font-rule-columns"><span>项目</span><span>下限</span><span>上限</span></div>
        {rangeFields.map(([key, label, unit, min, max, fallback]) => {
          const value = settings[key] || draft.general[key] || [fallback, fallback];
          return <div className="font-rule-field" key={key}>
            <div>{target >= 0 ? <Toggle label={`${label} / ${unit}`} checked={settings[key] !== undefined} onChange={enabled => { const next = { ...settings }; if (enabled) next[key] = [...value]; else delete next[key]; update(next); }} /> : <span>{label} / {unit}</span>}</div>
            {number(value[0], n => update({ ...settings, [key]: [n, value[1]] }), `${label}下限`, min, max)}
            {number(value[1], n => update({ ...settings, [key]: [value[0], n] }), `${label}上限`, min, max)}
          </div>;
        })}
        {scalarFields.map(([key, label, min]) => <div className="font-rule-field scalar" key={key}><div>{target >= 0 ? <Toggle label={`${label} / mm`} checked={settings[key] !== undefined} onChange={enabled => { const next = { ...settings }; if (enabled) next[key] = draft.general[key] || 0; else delete next[key]; update(next); }} /> : <span>{label} / mm</span>}</div>{number(settings[key] ?? draft.general[key] ?? 0, n => update({ ...settings, [key]: n }), label, min, 20)}</div>)}
        {target < 0 && <details><summary>整行设置</summary>{([['first_offset', '首字随机右移 / mm', 0, 20], ['wave_amplitude', '波动振幅 / mm', 0, 20], ['wave_length', '波长 / 字', 1, 500]] as const).map(([key, label, min, max]) => <div className="font-rule-field" key={key}><span>{label}</span>{number(draft[key][0], n => setDraft(r => ({ ...r, [key]: [n, r[key][1]] })), `${label}下限`, min, max)}{number(draft[key][1], n => setDraft(r => ({ ...r, [key]: [r[key][0], n] })), `${label}上限`, min, max)}</div>)}<p className="field-note">振幅 0 关闭波动；选中文字模式不应用整行设置。</p></details>}
        <p className="field-note">100% 保持原比例；基准线正值向上；负留白收紧字距。字符开关关闭时沿用通用设置，直接输入可单独设置。</p>
        {error && <p role="alert" className="inline-error">{error}</p>}
      </fieldset>
      <section className="font-rules-preview" aria-label="实时文字预览">
        <div className="font-preview-heading"><strong>实时预览</strong><span role="status">{error ? "等待有效参数" : locked ? "等待当前操作完成" : previewBusy ? "正在更新…" : previewError ? "更新失败" : "已更新"}</span></div>
        <label className="paper-field">预览字体<select className="text-input" value={sampleFont} disabled={locked} onChange={e => setSampleFont(e.target.value)}><option value="">主界面当前字体</option>{fonts.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label className="paper-field">预览文本<textarea className="text-input" rows={2} maxLength={2000} value={sampleText} disabled={locked} onChange={e => setSampleText(e.target.value)} /></label>
        <p className="field-note">规则应用于全部预览文本；此处试用字体和文字不改变主界面的插入设置。</p>
        <div className="font-preview-paper" aria-busy={previewBusy}>
          {preview && box ? <svg role="img" aria-label="当前字体与规则的真实路径预览，虚线为排字基准线" viewBox={viewBox} preserveAspectRatio="xMidYMid meet" style={{ opacity: previewBusy || error || previewError ? .5 : 1 }}>
            {preview.guides.map((g, i) => <line key={i} x1={g.start[0]} y1={g.start[1]} x2={g.end[0]} y2={g.end[1]} stroke="#a49ac7" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="4 4" />)}
            {preview.document.strokes.map((stroke, i) => <polyline key={i} points={stroke.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#30364d" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />)}
          </svg> : <p className="field-note">{previewBusy ? "正在生成当前输入的文字…" : "选择字体并输入文字后，这里自动预览。"}</p>}
        </div>
        {previewError && <div role="alert"><p className="inline-error">{previewError}</p><button className="button" disabled={locked || !!error || previewBusy} onClick={() => setRetry(n => n + 1)}>重试预览</button></div>}
        <p className="field-note">等比显示文字区域，虚线为基准线。修改参数自动更新，预览固定随机样本便于比较；不插入画布。</p>
      </section>
    </div>
    <footer><button className="button" disabled={!!error || locked || library.rules.length >= 50} onClick={() => save(true)}>另存为新规则集</button><button className="button primary" disabled={!!error || locked || (library.rules.length >= 50 && !library.rules.some(r => r.id === draft.id))} onClick={() => save(false)}>保存并使用</button></footer>
  </dialog>;
}
