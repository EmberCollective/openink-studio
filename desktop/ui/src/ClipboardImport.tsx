import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
export type ClipboardFile = { path: string; name: string; size: number };
type Preview = { data_url: string | null; document: { width_mm: number; height_mm: number; strokes: { x: number; y: number }[][] } | null };

export function ClipboardImport({ files, disabled, onUse, onBrowse, onCancel }: {
  files: ClipboardFile[]; disabled: boolean; onUse: (path: string) => void; onBrowse: () => void; onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const file = files[index];
  useEffect(() => {
    let current = true;
    setPreview(null); setError("");
    invoke<Preview>("clipboard_file_preview", { path: file.path }).then(value => {
      if (current) setPreview(value);
    }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [file.path]);
  return <section className="clipboard-import" aria-label="剪贴板素材">
    <div className="clipboard-heading"><strong>使用剪贴板素材？</strong><button className="text-button" disabled={disabled} onClick={onCancel}>取消</button></div>
    {files.length > 1 && <select className="text-input" aria-label="剪贴板文件" value={index} disabled={disabled} onChange={e => setIndex(Number(e.target.value))}>
      {files.map((f, i) => <option key={`${i}:${f.path}`} value={i}>{f.name}</option>)}
    </select>}
    <div className="clipboard-preview" aria-label="剪贴板文件预览" aria-busy={!preview && !error}>
      {preview?.data_url ? <img src={preview.data_url} alt={`${file.name} 首页预览`} /> : preview?.document ?
        <svg viewBox={`0 0 ${preview.document.width_mm || 1} ${preview.document.height_mm || 1}`} role="img" aria-label={`${file.name} 路径预览`}>
          {preview.document.strokes.map((stroke, i) => <polyline key={i} points={stroke.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        </svg> : <p className="field-note" role="status">{error || "正在生成预览…"}</p>}
    </div>
    <strong>{file.name}</strong>
    <p className="field-note">{(file.size / 1024).toFixed(1)} KB{ /\.pdf$/i.test(file.name) ? " · 预览第 1 页，导入后可切换页面" : ""}</p>
    <div className="clipboard-actions">
      <button className="button" disabled={disabled} onClick={onBrowse}>浏览其他文件</button>
      <button className="button primary" disabled={disabled} onClick={() => onUse(file.path)}>使用此文件</button>
    </div>
  </section>;
}
