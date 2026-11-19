//! Portable, bounded plain-data stroke packages. SVG companions are inspectable exports;
//! manifest trajectories are authoritative, as in .inkproj documents.
use crate::{
    glyphs::{Glyph, GlyphFont},
    model::{Document, Stroke},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs::{self, File, OpenOptions},
    hash::{BuildHasher, Hasher},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const MAX_BYTES: u64 = 100_000_000;
const MAX_POINTS: usize = 2_000_000;
const MAX_VARIANTS: usize = 30_000;
static LOCK: Mutex<()> = Mutex::new(());
static NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InkCanvas {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InkVariant {
    pub id: String,
    pub character: String,
    pub width_mm: f64,
    pub height_mm: f64,
    pub advance_mm: f64,
    pub strokes: Vec<Stroke>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas: Option<InkCanvas>,
}
impl InkVariant {
    fn glyph(&self) -> Glyph {
        Glyph {
            width_mm: self.width_mm,
            height_mm: self.height_mm,
            advance_mm: self.advance_mm,
            strokes: self.strokes.clone(),
        }
    }
    fn svg(&self) -> String {
        let mut glyph = self.glyph();
        if let Some(canvas) = &self.canvas {
            glyph.width_mm = canvas.width;
            glyph.height_mm = canvas.height;
            for p in glyph.strokes.iter_mut().flatten() { p.x -= canvas.x; p.y -= canvas.y; }
        }
        crate::import::svg_string(&Document {
            name: self.character.clone(),
            width_mm: glyph.width_mm.max(0.001),
            height_mm: glyph.height_mm,
            strokes: glyph.strokes,
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InkPackage {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub variants: Vec<InkVariant>,
}
#[derive(Debug, Serialize)]
pub struct InkSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    pub characters: Vec<String>,
    pub variant_count: usize,
    pub revision: u64,
}
fn directory() -> Result<PathBuf, String> {
    Ok(
        PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA unavailable")?)
            .join("OpenInkStudio/inkfonts"),
    )
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn fresh_id() -> String {
    format!(
        "{:x}-{:x}-{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    )
}
fn path_at(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("字包 ID 无效".into());
    }
    Ok(dir.join(format!("{id}.inkfont")))
}
fn validate(package: &InkPackage) -> Result<(), String> {
    if package.format != "openink-font" || package.version != 1 {
        return Err("不支持的 OpenInk 字包版本".into());
    }
    if !valid_id(&package.id) || package.name.trim().is_empty() || package.name.len() > 300 {
        return Err("字包名称或 ID 无效".into());
    }
    if package.variants.len() > MAX_VARIANTS {
        return Err("字包超过 30000 个字形".into());
    }
    let mut ids = HashSet::new();
    let mut total = 0usize;
    for v in &package.variants {
        if !valid_id(&v.id)
            || !ids.insert(&v.id)
            || v.character.chars().count() != 1
            || v.character
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
        {
            return Err("字形 ID 重复或对应字符无效".into());
        }
        let mut glyph = v.glyph();
        if let Some(canvas) = &v.canvas {
            if ![v.width_mm, v.height_mm, v.advance_mm, canvas.x, canvas.y, canvas.width, canvas.height, canvas.x + canvas.width, canvas.y + canvas.height].iter().all(|n| n.is_finite())
                || v.width_mm < 0. || v.height_mm <= 0. || v.advance_mm <= 0. || canvas.width <= 0. || canvas.height <= 0. {
                return Err("字形书写尺寸或编辑画布范围无效".into());
            }
            glyph.width_mm = canvas.width;
            glyph.height_mm = canvas.height;
            for p in glyph.strokes.iter_mut().flatten() { p.x -= canvas.x; p.y -= canvas.y; }
        }
        crate::glyphs::validate_glyph(&glyph)?;
        total += v.strokes.iter().map(Vec::len).sum::<usize>();
        if total > MAX_POINTS {
            return Err("字包超过两百万个轨迹点".into());
        }
    }
    Ok(())
}
fn summary(p: &InkPackage, path: &Path) -> InkSummary {
    InkSummary {
        id: p.id.clone(),
        name: p.name.clone(),
        path: path.to_string_lossy().into_owned(),
        characters: p
            .variants
            .iter()
            .map(|v| v.character.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        variant_count: p.variants.len(),
        revision: p.revision,
    }
}
fn read_package(path: &Path) -> Result<InkPackage, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("字包超过 100 MB".into());
    }
    let mut zip = ZipArchive::new(file).map_err(|e| format!("无效 .inkfont 压缩包：{e}"))?;
    if zip.len() > MAX_VARIANTS + 1 {
        return Err("字包文件数量过多".into());
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.enclosed_name().is_none()
            || f.name().contains(['\\', ':'])
            || f.is_dir()
            || !names.insert(f.name().to_owned())
            || f.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
        {
            return Err("字包含非法或重复路径".into());
        }
        total = total.checked_add(f.size()).ok_or("字包大小溢出")?;
        if total > MAX_BYTES {
            return Err("字包解压内容超过 100 MB".into());
        }
    }
    let mut bytes = vec![];
    zip.by_name("manifest.json")
        .map_err(|_| "字包缺少 manifest.json")?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("字包清单过大".into());
    }
    let package: InkPackage =
        serde_json::from_slice(&bytes).map_err(|e| format!("字包清单无效：{e}"))?;
    validate(&package)?;
    let expected: HashSet<String> = std::iter::once("manifest.json".into())
        .chain(
            package
                .variants
                .iter()
                .map(|v| format!("glyphs/{}.svg", v.id)),
        )
        .collect();
    if names != expected {
        return Err("字包 SVG 文件与清单不匹配".into());
    }
    // Never render untrusted SVG markup. Exact companions prevent ambiguous geometry.
    for v in &package.variants {
        let expected = v.svg();
        let mut svg = Vec::new();
        zip.by_name(&format!("glyphs/{}.svg", v.id))
            .map_err(|e| e.to_string())?
            .take(expected.len() as u64 + 1)
            .read_to_end(&mut svg)
            .map_err(|e| e.to_string())?;
        if svg != expected.as_bytes() {
            return Err("SVG 与清单轨迹不一致，请通过字形编辑器修改后重新保存".into());
        }
    }
    Ok(package)
}
fn write_package(path: &Path, package: &InkPackage) -> Result<(), String> {
    validate(package)?;
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("拒绝写入符号链接".into());
    }
    let temporary = path.with_extension(format!("{}.tmp", fresh_id()));
    let result = (|| {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let bytes = serde_json::to_vec(package).map_err(|e| e.to_string())?;
        // Generate companions from the same JSON-decoded floats readers will use.
        let canonical: InkPackage = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let mut total = bytes.len() as u64;
        if total > MAX_BYTES {
            return Err("字包清单超过 100 MB".into());
        }
        zip.start_file("manifest.json", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
        for v in &canonical.variants {
            let svg = v.svg();
            total += svg.len() as u64;
            if total > MAX_BYTES {
                return Err("字包内容超过 100 MB".into());
            }
            zip.start_file(format!("glyphs/{}.svg", v.id), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(svg.as_bytes()).map_err(|e| e.to_string())?;
        }
        let file = zip.finish().map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES {
            return Err("字包压缩文件超过 100 MB".into());
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, path).map_err(|e| format!("无法保存字包，原文件保留：{e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn save_at(dir: &Path, mut package: InkPackage) -> Result<InkPackage, String> {
    if package.id.is_empty() {
        package.id = fresh_id();
    }
    let path = path_at(dir, &package.id)?;
    validate(&package)?;
    if path.exists() {
        let old = read_package(&path)?;
        if package.revision != old.revision {
            return Err("字包已被其他操作修改，请重新打开后再保存".into());
        }
    } else if package.revision != 0 {
        return Err("字包已不存在，请重新打开".into());
    }
    package.revision = package.revision.checked_add(1).ok_or("字包版本计数溢出")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    write_package(&path, &package)?;
    Ok(package)
}
/// 排版时最多保留的正向左留白；超出部分视为编辑器画布留白，不参与字距。
const MAX_LEFT_BEARING: f64 = 0.5;

#[tauri::command]
pub fn inkfont_list() -> Result<Vec<InkSummary>, String> {
    let dir = directory()?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) == Some("inkfont") {
            let p = read_package(&path)?;
            result.push(summary(&p, &path));
        }
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}
#[tauri::command]
pub fn inkfont_load(id: String) -> Result<InkPackage, String> {
    read_package(&path_at(&directory()?, &id)?)
}
#[tauri::command]
pub async fn inkfont_save(package: InkPackage) -> Result<InkPackage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(|_| "字包写入锁不可用")?;
        save_at(&directory()?, package)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// 把字形底部对齐到基准线（字面高度的 75%）所需的垂直位移。
/// 笔画坐标 y 向下。为保住手写特征，小符号、下伸字母与偏旁部首（位移过大）保持原位。
fn baseline_shift(strokes: &[Stroke], character: &str, height_mm: f64, max_shift: f64) -> f64 {
    let mut ys: Vec<f64> = strokes.iter().flatten().map(|p| p.y).collect();
    if ys.is_empty() { return 0.; }
    ys.sort_by(|a, b| a.total_cmp(b));
    let (min, max) = (ys[0], ys[ys.len() - 1]);
    if max - min < 4. { return 0.; }
    if matches!(character.chars().next(), Some('g' | 'p' | 'q' | 'y' | 'j')) { return 0.; }
    let delta = height_mm * crate::model::FONT_BASELINE_RATIO - max;
    if delta.abs() > max_shift { return 0.; }
    delta
}
/// 一次性把整个字包统一到基准线；先备份原文件，再用软件自身接口重写（SVG 同步生成）。
/// max_shift_mm 限制单次平移幅度，避免把偏旁部首硬拉到基线；缺省 3mm。
#[tauri::command(rename_all = "snake_case")]
pub async fn inkfont_normalize_baseline(id: String, max_shift_mm: Option<f64>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let limit = max_shift_mm.filter(|v| v.is_finite() && *v > 0. && *v <= 10.).unwrap_or(3.);
        let _guard = LOCK.lock().map_err(|_| "字包写入锁不可用")?;
        let dir = directory()?;
        let path = path_at(&dir, &id)?;
        let original = fs::read(&path).map_err(|e| format!("无法读取原字包：{e}"))?;
        let backup_dir = dir.join("_baseline_backup");
        fs::create_dir_all(&backup_dir).map_err(|e| format!("无法建立备份目录：{e}"))?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_millis();
        let backup = backup_dir.join(format!("{id}-{stamp}.inkfont"));
        fs::write(&backup, &original).map_err(|e| format!("备份原字包失败，未修改：{e}"))?;
        let mut package = read_package(&path)?;
        let (mut adjusted, mut skipped, mut max_shift, mut total_shift) = (0usize, 0usize, 0f64, 0f64);
        for variant in &mut package.variants {
            let shift = baseline_shift(&variant.strokes, &variant.character, variant.height_mm, limit);
            let (canvas_y, canvas_h) = variant.canvas.as_ref()
                .map(|c| (c.y, c.height)).unwrap_or((0., variant.height_mm));
            let ys: Vec<f64> = variant.strokes.iter().flatten().map(|p| p.y).collect();
            let (lo, hi) = (ys.iter().cloned().fold(f64::INFINITY, f64::min), ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
            if shift.abs() <= 1e-6 || lo + shift - canvas_y < -1e-8 || hi + shift - canvas_y > canvas_h + 1e-8 {
                skipped += 1; continue;
            }
            for point in variant.strokes.iter_mut().flatten() { point.y += shift; }
            adjusted += 1;
            total_shift += shift.abs();
            max_shift = max_shift.max(shift.abs());
        }
        let saved = save_at(&dir, package)?;
        Ok(serde_json::json!({
            "revision": saved.revision,
            "adjusted": adjusted,
            "skipped": skipped,
            "total": saved.variants.len(),
            "limit_mm": limit,
            "max_shift_mm": max_shift,
            "mean_shift_mm": if adjusted > 0 { total_shift / adjusted as f64 } else { 0. },
            "backup": backup.to_string_lossy().into_owned(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn inkfont_import(path: String) -> Result<InkPackage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut p = read_import(Path::new(&path))?;
        p.id = String::new();
        p.revision = 0;
        let _guard = LOCK.lock().map_err(|_| "字包写入锁不可用")?;
        save_at(&directory()?, p)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_import(path: &Path) -> Result<InkPackage, String> {
    if path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("gfont")) {
        #[cfg(feature = "private-gfont")]
        return convert_gfont(path);
        #[cfg(not(feature = "private-gfont"))]
        return Err("此版本不支持 gfont 转换，请导入 .inkfont 字包".into());
    }
    read_package(path)
}

#[cfg(feature = "private-gfont")]
fn convert_gfont(path: &Path) -> Result<InkPackage, String> {
    let font = crate::legacy_font::load(path)?;
    let mut variants = Vec::new();
    let mut height = font.summary.size as f64;
    let baseline = crate::model::FONT_BASELINE_RATIO;
    for (&code, glyph) in &font.glyphs {
        let Some(character) = char::from_u32(code as u32) else { continue };
        if character.is_whitespace() || character.is_control() { continue; }
        let mut strokes = glyph.strokes();
        strokes.retain(|s| !s.is_empty());
        if strokes.is_empty() { continue; }
        for stroke in &mut strokes {
            // A repeated point preserves a dot without inventing a line segment.
            if stroke.len() == 1 { stroke.push(stroke[0]); }
            for point in stroke {
                if !point.x.is_finite() || !point.y.is_finite() {
                    return Err(format!("字形「{character}」包含无效坐标"));
                }
                height = height.max(-point.y / baseline).max(point.y / (1. - baseline));
            }
        }
        let metrics = crate::model::font_horizontal_metrics(&strokes, 1.);
        for point in strokes.iter_mut().flatten() { point.x += metrics.left_shift; }
        variants.push(InkVariant {
            id: format!("u{code:04x}"), character: character.to_string(),
            width_mm: metrics.advance, height_mm: 0., advance_mm: 0., strokes, canvas: None,
        });
    }
    if variants.is_empty() { return Err("gfont 中没有可导入的字符笔迹".into()); }
    // One shared em keeps punctuation and letters proportional, including overshoots.
    let scale = 20. / height;
    for variant in &mut variants {
        variant.width_mm = (variant.width_mm * scale).max(0.001);
        variant.height_mm = 20.;
        variant.advance_mm = variant.width_mm.max(2.);
        for point in variant.strokes.iter_mut().flatten() {
            point.x *= scale;
            point.y = ((point.y + height * baseline) * scale).clamp(0., 20.);
        }
    }
    let package = InkPackage {
        format: "openink-font".into(), version: 1, id: fresh_id(),
        name: if font.summary.display.trim().is_empty() {
            path.file_stem().unwrap_or_default().to_string_lossy().into_owned()
        } else { font.summary.display },
        revision: 0, variants,
    };
    validate(&package)?;
    Ok(package)
}
#[tauri::command]
pub async fn inkfont_export(id: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(|_| "字包写入锁不可用")?;
        let p = inkfont_load(id)?;
        write_package(Path::new(&path), &p)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn inkfont_delete(id: String, revision: u64) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "字包写入锁不可用")?;
    let path = path_at(&directory()?, &id)?;
    if read_package(&path)?.revision != revision {
        return Err("字包已改变，请刷新后重试".into());
    }
    fs::remove_file(path).map_err(|e| e.to_string())
}
pub(crate) fn load_font(path: &Path) -> Result<GlyphFont, String> {
    let p = read_package(path)?;
    let mut glyphs = BTreeMap::new();
    let mut variants: BTreeMap<String, Vec<Glyph>> = BTreeMap::new();
    for v in p.variants {
        // Tighten only the layout copy; archives/editor coordinates and vertical metrics stay intact.
        let mut glyph = v.glyph();
        // 编辑器里靠右书写的字形带着很大的正向左留白；排版时最多保留 0.5mm，
        // 否则该字与前后字之间会出现明显空隙（老字 minX=0，行为不变）。
        let (mut minx, mut maxx) = (f64::INFINITY, f64::NEG_INFINITY);
        for point in glyph.strokes.iter().flatten() {
            minx = minx.min(point.x);
            maxx = maxx.max(point.x);
        }
        let (ink_width, bearing) = if minx.is_finite() && maxx.is_finite() {
            (maxx - minx, minx.max(0.).min(MAX_LEFT_BEARING))
        } else {
            (0., 0.)
        };
        // 只对字形编辑器写出的带 canvas 字形纠偏：这类字常被画在画布中段
        // （如 x=6.6~13.85），排版时若不左移，字在字位里左右都留白。
        // 老格式字形（无 canvas，坐标 0–1000）依赖绝对坐标，保持原样。
        let left_shift = if v.canvas.is_some() { bearing - minx } else { 0. };
        glyph.width_mm = ink_width + bearing;
        // Zero-width strokes still need a cursor step; this never enlarges their geometry.
        let zero_width_advance = glyph.height_mm * 0.1;
        glyph.advance_mm = if glyph.width_mm > 0. { glyph.width_mm }
            else if zero_width_advance > 0. { zero_width_advance } else { glyph.height_mm };
        for point in glyph.strokes.iter_mut().flatten() { point.x += left_shift; }
        glyphs
            .entry(v.character.clone())
            .or_insert_with(|| glyph.clone());
        variants
            .entry(v.character.clone())
            .or_default()
            .push(glyph);
    }
    Ok(GlyphFont {
        format: "openink-stroke-font".into(),
        version: 1,
        name: p.name,
        glyphs,
        variants,
        baseline_ratio: Some(crate::model::FONT_BASELINE_RATIO),
    })
}
pub(crate) struct Random {
    state: u64,
}
impl Random {
    pub(crate) fn new() -> Self {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write(fresh_id().as_bytes());
        Self {
            state: h.finish().max(1),
        }
    }
    pub(crate) fn index(&mut self, len: usize) -> usize {
        let bound = len as u64;
        let limit = u64::MAX - u64::MAX % bound;
        loop {
            self.state ^= self.state << 13;
            self.state ^= self.state >> 7;
            self.state ^= self.state << 17;
            let value = self.state - 1;
            if value < limit {
                return (value % bound) as usize;
            }
        }
    }
    /// [0, 1) 之间的随机数，供笔画级扰动等几何采样复用。
    pub(crate) fn unit(&mut self) -> f64 {
        self.index(1_000_000) as f64 / 1_000_000.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Point;
    #[test]
    fn right_drawn_glyph_is_shifted_back_into_its_cell() {
        // 字形编辑器里把字写在画布中段（x=6.6~13.85）时，排版副本必须把墨迹
        // 左移到字位起点附近，否则字在画布上左右都留白、与前后字重叠。
        let dir = std::env::temp_dir().join(fresh_id());
        let mut p = package();
        p.variants[0].canvas = Some(InkCanvas { x: 0., y: 0., width: 20., height: 20. });
        p.variants[0].width_mm = 20.;
        p.variants[0].height_mm = 20.;
        p.variants[0].advance_mm = 7.74;
        p.variants[0].strokes = vec![vec![Point { x: 6.6, y: 8. }, Point { x: 13.85, y: 15. }]];
        let saved = save_at(&dir, p).unwrap();
        let font = load_font(&path_at(&dir, &saved.id).unwrap()).unwrap();
        let g = &font.glyphs["永"];
        let minx = g.strokes.iter().flatten().map(|p| p.x).fold(f64::INFINITY, f64::min);
        assert!(minx >= 0. && minx <= MAX_LEFT_BEARING + 1e-9, "墨迹应左移到 0–{MAX_LEFT_BEARING}mm，实际 {minx}");
        assert!((g.advance_mm - (13.85 - 6.6 + minx)).abs() < 1e-6, "推进宽度应与收紧后的墨迹对齐");
        // 老格式（无 canvas）字形的绝对坐标保持不变
        let old_dir = std::env::temp_dir().join(fresh_id());
        let mut old = package();
        old.variants[0].strokes = vec![vec![Point { x: 3., y: 1. }, Point { x: 7., y: 9. }]];
        let saved = save_at(&old_dir, old).unwrap();
        let old_font = load_font(&path_at(&old_dir, &saved.id).unwrap()).unwrap();
        assert_eq!(old_font.glyphs["永"].strokes[0][0].x, 3.);
        let _ = fs::remove_dir_all(&old_dir);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn expanded_canvas_roundtrips_negative_ink_without_changing_writing_metrics() {
        let dir = std::env::temp_dir().join(fresh_id());
        let mut p = package();
        let original_font_height = p.variants[0].height_mm;
        p.variants[0].canvas = Some(InkCanvas { x: -5., y: -5., width: 20., height: 20. });
        let before = p.variants[0].strokes.clone();
        let saved = save_at(&dir, p.clone()).unwrap();
        let path = path_at(&dir, &saved.id).unwrap();
        let font = load_font(&path).unwrap();
        assert_eq!(font.glyphs["永"].height_mm, original_font_height);
        assert_eq!(font.glyphs["永"].strokes, before);
        assert_eq!(font.glyphs["永"].advance_mm, 10.);
        p.id = fresh_id();
        p.variants[0].strokes.push(vec![Point{x:-5.,y:-5.}, Point{x:15.,y:15.}]);
        let saved = save_at(&dir, p.clone()).unwrap();
        let path = path_at(&dir, &saved.id).unwrap();
        let reopened = read_package(&path).unwrap();
        assert_eq!(reopened.variants[0].strokes, p.variants[0].strokes);
        assert_eq!(reopened.variants[0].canvas.as_ref().unwrap().x, -5.);
        assert_eq!(reopened.variants[0].height_mm, original_font_height);
        let svg = reopened.variants[0].svg();
        assert!(svg.contains("20"));
        let font = load_font(&path).unwrap();
        assert_eq!(font.glyphs["永"].height_mm, original_font_height);
        assert_eq!(font.glyphs["永"].advance_mm, 20.);
        p.variants[0].strokes[1][0].x = -5.1;
        assert!(validate(&p).is_err());
        p.variants[0].strokes[1][0].x = -5.;
        p.variants[0].canvas.as_mut().unwrap().width = f64::NAN;
        assert!(validate(&p).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[cfg(not(feature = "private-gfont"))]
    fn gfont_import_requires_private_build() {
        assert!(read_import(Path::new("missing.GFONT")).unwrap_err().contains("此版本不支持"));
    }
    #[test]
    #[cfg(feature = "private-gfont")]
    fn gfont_import_preserves_geometry_and_roundtrips() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let dir = std::env::temp_dir().join(fresh_id());
        for relative in ["tests/data/legacy-v1.gfont", "tests/data/legacy-v2.gfont", "tests/data/legacy-v3.gfont", "tests/data/legacy-v4.gfont", "../fonts/Apollo_kvenjoy_Zl.gfont", "../fonts/zy01.gfont"] {
            let source = root.join(relative);
            let original = fs::read(&source).unwrap();
            let font = crate::legacy_font::load(&source).unwrap();
            let converted = read_import(&source).unwrap();
            assert!(!converted.variants.is_empty());
            let mut scale = None;
            for variant in &converted.variants {
                let code = variant.character.chars().next().unwrap() as u16;
                let strokes = font.glyphs[&code].strokes();
                assert_eq!(variant.strokes.len(), strokes.len());
                let metrics = crate::model::font_horizontal_metrics(&strokes, 1.);
                for (before, after) in strokes.iter().zip(&variant.strokes) {
                    assert_eq!(after.len(), before.len().max(2));
                    for (a, b) in before.iter().zip(after) {
                        if a.y.abs() > 1e-8 {
                            let current = (b.y - 15.) / a.y;
                            let expected = *scale.get_or_insert(current);
                            assert!((current - expected).abs() < 1e-8, "All glyphs share scale and baseline");
                        }
                        if let Some(scale) = scale {
                            assert!((b.x - (a.x + metrics.left_shift) * scale).abs() < 1e-8);
                        }
                    }
                }
            }
            let saved = save_at(&dir, converted).unwrap();
            let target = path_at(&dir, &saved.id).unwrap();
            let reopened = read_package(&target).unwrap();
            assert_eq!(reopened.variants.len(), saved.variants.len());
            for (before, after) in saved.variants.iter().zip(&reopened.variants) {
                assert_eq!((&before.id, &before.character), (&after.id, &after.character));
                assert_eq!(before.strokes.iter().map(Vec::len).collect::<Vec<_>>(), after.strokes.iter().map(Vec::len).collect::<Vec<_>>());
                for (a, b) in before.strokes.iter().flatten().zip(after.strokes.iter().flatten()) {
                    assert!((a.x - b.x).abs() < 1e-12 && (a.y - b.y).abs() < 1e-12);
                }
            }
            println!("Converted {relative}: {} glyphs", saved.variants.len());
            assert_eq!(fs::read(source).unwrap(), original);
        }
        assert!(read_import(&dir.join("missing.gfont")).is_err());
        fs::write(dir.join("invalid.gfont"), b"invalid font").unwrap();
        assert!(read_import(&dir.join("invalid.gfont")).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    fn package() -> InkPackage {
        InkPackage {
            format: "openink-font".into(),
            version: 1,
            id: "test".into(),
            name: "测试".into(),
            revision: 0,
            variants: vec![InkVariant { canvas: None,
                id: "v1".into(),
                character: "永".into(),
                width_mm: 10.,
                height_mm: 10.,
                advance_mm: 10.,
                strokes: vec![vec![Point { x: 0., y: 0. }, Point { x: 10., y: 10. }]],
            }],
        }
    }
    #[test]
    fn layout_reuses_bearings_and_baseline_without_resizing_or_rewriting_old_packages() {
        let dir = std::env::temp_dir().join(fresh_id());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.inkfont");
        let mut p = package();
        p.variants = [
            ("han", "永", 1000., 300., 700., 100., 900.),
            ("short", "一", 1000., 200., 800., 550., 550.),
            ("punctuation", "。", 1000., 600., 650., 800., 850.),
            ("different-em", "高", 2000., 500., 700., 600., 1800.),
        ].into_iter().map(|(id, character, height_mm, x0, x1, y0, y1)| InkVariant { canvas: None,
            id:id.into(), character:character.into(), width_mm:1000., height_mm,
            advance_mm:1700., strokes:vec![vec![Point{x:x0,y:y0}, Point{x:x1,y:y1}]],
        }).collect();
        // Write an unchanged old-format archive, bypassing any future save-time conveniences.
        write_package(&path, &p).unwrap();
        let original_bytes = fs::read(&path).unwrap();
        let font = load_font(&path).unwrap();
        for original in &p.variants {
            let glyph = &font.glyphs[&original.character];
            // 排版推进 = 墨迹宽度 + 最多 0.5mm 左留白，且不小于 10% 字高。
            let ink = original.strokes[0][1].x - original.strokes[0][0].x;
            let bearing = original.strokes[0][0].x.max(0.).min(0.5);
            let width = ink + bearing;
            assert_eq!((glyph.width_mm, glyph.advance_mm), (width, width), "{}", original.character);
            assert_eq!(glyph.height_mm, original.height_mm);
            assert_eq!(glyph.strokes[0][0].x, original.strokes[0][0].x);
            assert_eq!(glyph.strokes[0][1].x, original.strokes[0][1].x);
            assert_eq!(glyph.strokes[0][0].y, original.strokes[0][0].y);
            assert_eq!(glyph.strokes[0][1].y, original.strokes[0][1].y);
        }
        let document = crate::glyphs::compose(&path, "永一。高", 10., 2., 1, 210., 297.).unwrap();
        // 新规则：推进 = 墨迹宽 + 最多 0.5mm 左留白，所以「一」「。」这类窄字的间距不再被画布留白撑开。
        let expected = [
            [(3., 1.), (7., 9.)],
            [(8.005, 5.5), (14.005, 5.5)],
            [(20.01, 8.), (20.51, 8.5)],
            [(19.015, 3.), (20.015, 9.)],
        ];
        for (stroke, want) in document.strokes.iter().zip(expected) {
            for (point, (x, y)) in stroke.iter().zip(want) {
                assert!((point.x - x).abs() < 1e-6 && (point.y - y).abs() < 1e-6, "{} {:?}", point.x, point.y);
            }
        }
        let lined = crate::lined_text::compose(&crate::lined_text::TextOptions {
            font_mode:"glyph".into(), path:path.to_string_lossy().into_owned(), selections:vec![],
            text:"永一。高".into(), size_mm:10., spacing_mm:2.,
            guide_lines:vec![crate::lined_text::GuideLine{id:"line".into(),start:[10.,20.],end:[200.,20.]}],
            start_line:0, baseline_offset_mm:0., legacy_baseline:1., legacy_percent:100., legacy_seed:1,
            centerline:true, options:Default::default(), width_mm:210., height_mm:297., space_mm:None,
            auto_baseline:false, stroke_variation:None, stroke_tip:None,
            jitter:Default::default(), rules:None, paragraph:Default::default(),
        }).unwrap();
        // 沿横线排版复用同一批字形，逐字向右推进。
        assert_eq!(lined.strokes.len(), 4);
        assert!(lined.strokes.windows(2).all(|w| w[1][0].x >= w[0][0].x));
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
        assert_eq!(serde_json::to_value(read_package(&path).unwrap()).unwrap(), serde_json::to_value(&p).unwrap());
        let legacy_path = dir.join("unchanged.json");
        let legacy = GlyphFont{format:"openink-stroke-font".into(),version:1,name:"old JSON".into(),
            glyphs:BTreeMap::from([("永".into(), p.variants[0].glyph())]), variants:BTreeMap::new(),baseline_ratio:None};
        fs::write(&legacy_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let legacy = crate::glyphs::load(&legacy_path).unwrap();
        assert_eq!(legacy.glyphs["永"].advance_mm, 1700.);
        assert_eq!(legacy.glyphs["永"].strokes[0][0].x, 300.);
        assert_eq!(legacy.baseline_ratio, None);
        assert_eq!(font.baseline_ratio, Some(0.75));
        assert!(serde_json::to_value(&font).unwrap().get("baseline_ratio").is_none());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn zero_width_ink_advances_without_enlarging_or_clamping_positive_widths() {
        let dir = std::env::temp_dir().join(fresh_id());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("lines.inkfont");
        let mut p = package();
        p.variants = [
            ("vertical", "丨", 0., 0., 200., 800.),
            ("point", "·", 0., 0., 600., 600.),
            ("narrow", "窄", 0., 0.001, 200., 800.),
        ].into_iter().map(|(id, character, x0, x1, y0, y1)| InkVariant { canvas: None,
            id:id.into(), character:character.into(), width_mm:1000., height_mm:1000., advance_mm:1000.,
            strokes:vec![vec![Point{x:x0,y:y0}, Point{x:x1,y:y1}]],
        }).collect();
        write_package(&path, &p).unwrap();
        let font = load_font(&path).unwrap();
        for ch in ["丨", "·"] {
            let glyph = &font.glyphs[ch];
            assert_eq!(glyph.width_mm, 0.);
            assert_eq!(glyph.advance_mm, 100.);
            assert!(glyph.strokes.iter().flatten().all(|point| point.x == 0.));
            crate::glyphs::validate_glyph(glyph).unwrap();
        }
        assert_eq!(font.glyphs["·"].strokes[0][0].y, 600.);
        assert!(font.glyphs["窄"].advance_mm > 0. && font.glyphs["窄"].advance_mm < 0.01);
        let document = crate::glyphs::compose(&path, "丨丨", 10., 0.5, 1, 210., 297.).unwrap();
        assert_eq!(document.strokes[0], vec![Point{x:0.,y:2.}, Point{x:0.,y:8.}]);
        assert_eq!(document.strokes[1], vec![Point{x:1.5,y:2.}, Point{x:1.5,y:8.}]);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn archive_roundtrip_conflict_and_random_variants() {
        let dir = std::env::temp_dir().join(fresh_id());
        let mut p = package();
        let mut second = p.variants[0].clone();
        second.id = "v2".into();
        second.strokes[0][1].x = 5.;
        p.variants.push(second);
        let saved = save_at(&dir, p).unwrap();
        let path = path_at(&dir, "test").unwrap();
        assert_eq!(read_package(&path).unwrap().variants.len(), 2);
        let next = save_at(&dir, saved.clone()).unwrap();
        assert_eq!(next.revision, 2);
        assert!(save_at(&dir, saved).is_err());
        let f = load_font(&path).unwrap();
        let mut rng = Random { state: 1 };
        let mut seen = BTreeSet::new();
        for _ in 0..40 {
            seen.insert(f.choose('永', &mut rng).unwrap().strokes[0][1].x as u32);
        }
        assert_eq!(seen.len(), 2);
        assert!(f.choose('无', &mut rng).is_none());
        let doc = crate::glyphs::compose(&path, "永永永", 10., 0., 1, 100., 100.).unwrap();
        assert_eq!(doc.strokes.len(), 3);
        assert!(
            crate::glyphs::compose(&path, "永无", 10., 0., 1, 100., 100.)
                .unwrap_err()
                .contains("lacks character")
        );
        let options = crate::lined_text::TextOptions {
            font_mode: "glyph".into(),
            path: path.to_string_lossy().into_owned(),
            selections: vec![],
            text: "永".repeat(64),
            size_mm: 1.,
            spacing_mm: 0.,
            guide_lines: vec![crate::lined_text::GuideLine {
                id: "line".into(),
                start: [0., 10.],
                end: [200., 10.],
            }],
            start_line: 0,
            baseline_offset_mm: 0.,
            legacy_baseline: 1.,
            legacy_percent: 100.,
            legacy_seed: 1,
            centerline: true,
            options: Default::default(),
            width_mm: 210.,
            height_mm: 297.,
            space_mm: None,
            auto_baseline: false, stroke_variation: None, stroke_tip: None,
            jitter: Default::default(),
            rules: None, paragraph:Default::default(),
        };
        let lined = crate::lined_text::compose(&options).unwrap();
        let widths: BTreeSet<_> = lined
            .strokes
            .iter()
            .map(|s| ((s[1].x - s[0].x) * 100.).round() as i32)
            .collect();
        assert_eq!(
            widths,
            BTreeSet::from([50, 100]),
            "Per-character caching must not freeze every occurrence to one variant"
        );
        let mut missing = options;
        missing.text = "永无".into();
        assert!(crate::lined_text::compose(&missing)
            .unwrap_err()
            .contains('无'));
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn validation_rejects_bad_geometry_and_ids() {
        let mut p = package();
        p.id = "../bad".into();
        assert!(validate(&p).is_err());
        p.id = "ok".into();
        p.variants[0].strokes[0][0].x = f64::INFINITY;
        assert!(validate(&p).is_err());
        let mut p = package();
        p.variants.push(p.variants[0].clone());
        assert!(validate(&p).is_err());
    }
    #[test]
    fn floating_point_svg_companions_survive_roundtrip() {
        let dir = std::env::temp_dir().join(fresh_id());
        let mut p = package();
        p.variants[0].strokes[0][0].x = 0.12345678901234568;
        p.variants[0].strokes[0][0].y = 0.84551240822557006;
        let p = save_at(&dir, p).unwrap();
        let loaded = read_package(&path_at(&dir, &p.id).unwrap()).unwrap();
        assert!((p.variants[0].strokes[0][0].x - loaded.variants[0].strokes[0][0].x).abs() < 1e-14);
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn rejects_extra_or_traversal_archive_entries() {
        let path = std::env::temp_dir().join(format!("{}.inkfont", fresh_id()));
        let p = package();
        write_package(&path, &p).unwrap();
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let mut zip = ZipWriter::new_append(file).unwrap();
        zip.start_file("../unexpected", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"bad").unwrap();
        zip.finish().unwrap();
        assert!(read_package(&path).is_err());
        let _ = fs::remove_file(path);
    }
    #[test]
    fn rejects_declared_zip_bomb_before_decompression() {
        let path = std::env::temp_dir().join(format!("{}.inkfont", fresh_id()));
        write_package(&path, &package()).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let central = bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
        bytes[central + 24..central + 28].copy_from_slice(&((MAX_BYTES + 1) as u32).to_le_bytes());
        fs::write(&path, bytes).unwrap();
        assert!(read_package(&path).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn glyph_free_layout_moves_an_english_word_to_the_next_line() {
        let dir = std::env::temp_dir().join(fresh_id());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("words.inkfont");
        let mut p = package();
        p.variants = ['a', 'b', 'c', 'd', 'e', 'f'].into_iter().map(|ch| InkVariant { canvas: None,
            id: format!("u{:04x}", ch as u32), character: ch.to_string(),
            width_mm: 6., height_mm: 20., advance_mm: 6.,
            strokes: vec![vec![Point { x: 0., y: 0. }, Point { x: 6., y: 4. }]],
        }).collect();
        write_package(&path, &p).unwrap();
        // 每字 3mm + 1mm 字距；20mm 宽的行放不下 "def"，整词应搬走。
        let doc = crate::glyphs::compose(&path, "abc def", 10., 1., 3, 20., 60.).unwrap();
        assert_eq!(doc.strokes.len(), 6, "空格不产生笔迹");
        assert_eq!(doc.strokes.iter().filter(|s| s[0].y < 10.).count(), 3, "第一行只剩 abc");
        assert_eq!(doc.strokes.iter().filter(|s| s[0].y >= 10.).count(), 3, "def 整体在下一行");
        assert!((doc.strokes[3][0].x).abs() < 1e-8, "单词从新行行首开始");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stroke_variation_makes_repeated_characters_distinct_but_keeps_structure() {
        let dir = std::env::temp_dir().join(fresh_id());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("variation.inkfont");
        let mut p = package();
        p.variants = vec![InkVariant { canvas: None,
            id: "u6c38".into(), character: "永".into(),
            width_mm: 10., height_mm: 20., advance_mm: 10.,
            strokes: vec![
                vec![Point { x: 0., y: 4. }, Point { x: 10., y: 4. }],
                vec![Point { x: 5., y: 2. }, Point { x: 5., y: 15. }],
            ],
        }];
        write_package(&path, &p).unwrap();
        let options = |variation: Option<f64>| crate::lined_text::TextOptions {
            font_mode: "glyph".into(), path: path.to_string_lossy().into_owned(), selections: vec![],
            text: "永永永".into(), size_mm: 10., spacing_mm: 1.,
            guide_lines: vec![crate::lined_text::GuideLine { id: "l".into(), start: [10., 20.], end: [200., 20.] }],
            start_line: 0, baseline_offset_mm: 0., legacy_baseline: 1., legacy_percent: 100., legacy_seed: 1,
            centerline: false, options: Default::default(), width_mm: 210., height_mm: 297., space_mm: None,
            auto_baseline: false, stroke_variation: variation, stroke_tip: None,
            jitter: Default::default(), rules: None, paragraph: Default::default(),
        };
        let shape = |d: &crate::model::Document| -> Vec<(f64, f64, f64, f64)> {
            d.strokes.iter().map(|s| {
                let xs = s.iter().map(|p| p.x).collect::<Vec<_>>();
                let ys = s.iter().map(|p| p.y).collect::<Vec<_>>();
                let (x0, x1) = (xs.iter().cloned().fold(f64::INFINITY, f64::min), xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
                let (y0, y1) = (ys.iter().cloned().fold(f64::INFINITY, f64::min), ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
                ((x0 + x1) / 2., (y0 + y1) / 2., x1 - x0, y1 - y0)
            }).collect()
        };
        let (off, off_groups) = crate::lined_text::compose_with_groups(&options(None)).unwrap();
        let (on, on_groups) = crate::lined_text::compose_with_groups(&options(Some(10.))).unwrap();
        assert_eq!(off_groups, on_groups, "分组不受影响");
        assert_eq!(off.strokes.len(), 6);
        let (off_shape, on_shape) = (shape(&off), shape(&on));
        // 关闭时三个「永」应完全一致。
        for i in 0..2 {
            assert_eq!(off_shape[i].2, off_shape[i + 2].2);
            assert_eq!(off_shape[i].3, off_shape[i + 2].3);
        }
        // 现在整字会有轻微缩放/倾斜、每笔落点也会错开，所以判据是「相对位置变化很小」，
        // 而不是完全不动——骨架仍在，字不会散。
        for i in (0..6).step_by(2) {
            let (dx0, dy0) = (off_shape[i + 1].0 - off_shape[i].0, off_shape[i + 1].1 - off_shape[i].1);
            let (dx1, dy1) = (on_shape[i + 1].0 - on_shape[i].0, on_shape[i + 1].1 - on_shape[i].1);
            assert!((dx0 - dx1).abs() < 1.5 && (dy0 - dy1).abs() < 1.5, "字内笔画相对位置只能轻微变化");
        }
        // 开启后同一个字的几次出现形状不同，且变化幅度受控。
        assert_ne!(on_shape[0].2, on_shape[2].2, "同字应有可见差异");
        for (a, b) in off_shape.iter().zip(on_shape.iter()) {
            if a.2 > 1e-9 { assert!(((b.2 / a.2) - 1.).abs() <= 0.35, "宽度变化应受强度约束"); }
            if a.3 > 1e-9 { assert!(((b.3 / a.3) - 1.).abs() <= 0.35, "高度变化应受强度约束"); }
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stroke_tip_keeps_one_stroke_per_input_and_preserves_groups() {
        let dir = std::env::temp_dir().join(fresh_id());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tip.inkfont");
        let mut p = package();
        p.variants = vec![InkVariant { canvas: None,
            id: "u6c38".into(), character: "永".into(),
            width_mm: 10., height_mm: 20., advance_mm: 10.,
            strokes: vec![
                vec![Point { x: 0., y: 4. }, Point { x: 10., y: 4. }],
                vec![Point { x: 5., y: 2. }, Point { x: 5., y: 15. }],
            ],
        }];
        write_package(&path, &p).unwrap();
        let options = |tip: Option<crate::stroke_tip::TipSettings>| crate::lined_text::TextOptions {
            font_mode: "glyph".into(), path: path.to_string_lossy().into_owned(), selections: vec![],
            text: "永永永".into(), size_mm: 10., spacing_mm: 1.,
            guide_lines: vec![crate::lined_text::GuideLine { id: "l".into(), start: [10., 20.], end: [200., 20.] }],
            start_line: 0, baseline_offset_mm: 0., legacy_baseline: 1., legacy_percent: 100., legacy_seed: 1,
            centerline: false, options: Default::default(), width_mm: 210., height_mm: 297., space_mm: None,
            auto_baseline: false, stroke_variation: None, stroke_tip: tip,
            jitter: Default::default(), rules: None, paragraph: Default::default(),
        };
        let (plain, plain_groups) = crate::lined_text::compose_with_groups(&options(None)).unwrap();
        let outline_tip = crate::stroke_tip::TipSettings { style: "outline".into(), width_mm: 0.6, start: 0.2, end: 0.25 };
        let (outlined, outlined_groups) = crate::lined_text::compose_with_groups(&options(Some(outline_tip))).unwrap();
        assert_eq!(plain.strokes.len(), 6);
        assert_eq!(outlined.strokes.len(), 6, "笔锋必须保持 1 条输入 → 1 条输出");
        assert_eq!(plain_groups, outlined_groups, "分组与已书写追踪不受影响");
        assert!(outlined.strokes.iter().all(|s| s.first() == s.last()), "轮廓笔锋是闭合折线");
        assert!(outlined.strokes.iter().all(|s| s.iter().all(|p| p.x.is_finite() && p.y.is_finite())));
        let taper_tip = crate::stroke_tip::TipSettings { style: "taper".into(), width_mm: 0.6, start: 0.2, end: 0.25 };
        let (tapered, tapered_groups) = crate::lined_text::compose_with_groups(&options(Some(taper_tip))).unwrap();
        assert_eq!(tapered.strokes.len(), 6);
        assert_eq!(tapered_groups, plain_groups);
        assert!(tapered.strokes.iter().all(|s| s.len() == 4), "单线尖锋只加首尾两点");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn baseline_shift_aligns_body_bottom_but_keeps_small_symbols_and_descenders() {
        let glyph = |ys: &[f64]| -> Vec<Stroke> { vec![ys.iter().map(|&y| Point { x: 1., y }).collect()] };
        assert!(baseline_shift(&glyph(&[5., 8., 11., 14., 15.3]), "中", 20., 3.).abs() <= 1.01);
        assert!(baseline_shift(&glyph(&[3., 6., 9., 12.]), "中", 20., 3.) > 2., "偏高的字应下移");
        assert_eq!(baseline_shift(&glyph(&[4.3, 5.1, 7.6]), "\"", 20., 3.), 0., "高位标点保持原位");
        assert_eq!(baseline_shift(&glyph(&[10.6, 12., 14., 15., 16., 18.]), "g", 20., 3.), 0., "下伸部保留");
    }
    #[test]
    fn normalized_coordinates_still_pass_exact_svg_validation() {
        let dir = std::env::temp_dir().join(fresh_id());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("normalize.inkfont");
        let mut p = package();
        p.variants[0].width_mm = 20.;
        p.variants[0].height_mm = 20.;
        p.variants[0].advance_mm = 20.;
        let ys = [4., 5., 6., 7., 8., 9., 10., 11., 12., 13., 13.5];
        p.variants[0].strokes = vec![ys.iter().map(|&y| Point { x: 2., y }).collect()];
        write_package(&path, &p).unwrap();
        let mut loaded = read_package(&path).unwrap();
        let shift = baseline_shift(&loaded.variants[0].strokes, "永", loaded.variants[0].height_mm, 3.);
        assert!(shift.abs() > 0.);
        for point in loaded.variants[0].strokes.iter_mut().flatten() { point.y += shift; }
        write_package(&path, &loaded).unwrap();
        assert!(read_package(&path).is_ok(), "平移后 SVG 伴随文件仍与清单一致");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lined_text_auto_baseline_snaps_glyph_bottom_to_the_guide() {
        let dir = std::env::temp_dir().join(fresh_id());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("snap.inkfont");
        let mut p = package();
        p.variants = vec![InkVariant { canvas: None, id: "a".into(), character: "A".into(),
            width_mm: 20., height_mm: 20., advance_mm: 10.,
            strokes: vec![vec![Point { x: 0., y: 4. }, Point { x: 6., y: 18. }]] }];
        write_package(&path, &p).unwrap();
        let options = |auto: bool| crate::lined_text::TextOptions {
            font_mode: "glyph".into(), path: path.to_string_lossy().into_owned(), selections: vec![],
            text: "A".into(), size_mm: 10., spacing_mm: 1.,
            guide_lines: vec![crate::lined_text::GuideLine { id: "l".into(), start: [10., 20.], end: [200., 20.] }],
            start_line: 0, baseline_offset_mm: 0., legacy_baseline: 1., legacy_percent: 100., legacy_seed: 1,
            centerline: false, options: Default::default(), width_mm: 210., height_mm: 297., space_mm: None,
            auto_baseline: auto, stroke_variation: None, stroke_tip: None, jitter: Default::default(), rules: None, paragraph: Default::default(),
        };
        let bottom = |d: &crate::model::Document| d.strokes[0].iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max) - 20.;
        let off = crate::lined_text::compose(&options(false)).unwrap();
        assert!((bottom(&off) - 1.5).abs() < 1e-6, "关闭时按 75% 基准线，底部落在横线下 1.5mm");
        let on = crate::lined_text::compose(&options(true)).unwrap();
        assert!(bottom(&on).abs() < 1e-6, "开启后墨迹底部正好贴到横线");
        let _ = fs::remove_dir_all(&dir);
    }
}
