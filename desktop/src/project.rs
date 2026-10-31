//! Private .inkproj ZIP container. Only named entries are read; device state is never restored.
use crate::{import::ImportOptions, model::Document, positioning::Registration, registration_profiles::RegistrationProfile, templates::Template};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::{HashMap, HashSet}, fs::{self, File}, io::{Read, Seek, Write}, path::Path};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_TOTAL: u64 = 512 * 1024 * 1024;
const MAX_ENTRY: u64 = 128 * 1024 * 1024;
const MAX_PAGES: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Writing { pub feed: f64, pub travel_feed: f64, pub z_feed: f64, pub z_down: f64, pub jog_step: f64 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Routing { pub optimize: bool, pub allow_reverse: bool, pub allow_gap: bool, pub max_gap: f64, pub deduplicate: bool }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Calibration {
    pub origin: Option<[f64; 2]>, pub registration: Registration,
    pub points: [[f64; 2]; 2], pub show_points: bool, pub selected_profile: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point3: Option<[f64;2]>,
    pub profiles: Vec<RegistrationProfile>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Background {
    pub path: String, pub page: usize, pub page_count: usize, pub data_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    // Legacy v1/v2 target-size copies. Read for .kjoy compatibility, never reserialize.
    #[serde(default, rename = "width_mm", skip_serializing)]
    pub legacy_width_mm: Option<f64>,
    #[serde(default, rename = "height_mm", skip_serializing)]
    pub legacy_height_mm: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guide_lines: Vec<GuideLine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corners: Option<[[f64; 2]; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guides_visible: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GuideLine { pub id: String, pub start: [f64; 2], pub end: [f64; 2] }
impl Background {
    pub fn validate(&self, page_width: f64, page_height: f64) -> Result<(), String> {
        if self.page == 0 || self.page > self.page_count || self.page_count > 10_000 || self.path.is_empty() || self.path.len() > 32768
            || self.data_url.len() > 16 * 1024 * 1024 || (!self.data_url.is_empty() && !self.data_url.starts_with("data:image/png;base64,"))
            || self.source_path.as_ref().is_some_and(|s| s.is_empty() || s.len() > 32768)
            || self.kind.as_ref().is_some_and(|s| s != "image" && s != "pdf") {
            return Err("工程背景配置无效".into());
        }
        let close = |value: Option<f64>, expected: f64| value.is_none_or(|v| v.is_finite() && (v - expected).abs() <= 1e-7);
        if !close(self.legacy_width_mm, page_width) || !close(self.legacy_height_mm, page_height) { return Err("工程背景尺寸与版面不一致".into()); }
        if self.guide_lines.len() > 500 || self.guide_lines.iter().map(|g| &g.id).collect::<HashSet<_>>().len() != self.guide_lines.len() { return Err("工程横线数量或标识无效".into()); }
        for line in &self.guide_lines {
            if line.id.is_empty() || line.id.len() > 128 || [line.start,line.end].iter().any(|p| !p.iter().all(|v| v.is_finite()) || p[0] < 0. || p[0] > page_width || p[1] < 0. || p[1] > page_height) || line.end[0] <= line.start[0] {
                return Err("工程横线坐标无效".into());
            }
        }
        if self.corners.is_some_and(|p| !p.iter().flatten().all(|v| v.is_finite() && (0.0..=1.).contains(v))) { return Err("工程背景四角无效".into()); }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub document: Value, pub background: Option<Background>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutDerivation {
    pub mode: String, pub base_width_mm: f64, pub base_height_mm: f64,
    pub scale_x: f64, pub scale_y: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    pub id: String, pub name: String, pub description: String,
    pub width_mm: f64, pub height_mm: f64, pub margin_mm: f64,
    pub font_size_mm: f64, pub letter_spacing_mm: f64, pub lines: usize,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derivation: Option<LayoutDerivation>,
}
impl Layout {
    fn template(&self) -> Template {
        Template { id: self.id.clone(), name: self.name.clone(), description: self.description.clone(),
            width_mm: self.width_mm, height_mm: self.height_mm, margin_mm: self.margin_mm,
            font_size_mm: self.font_size_mm, letter_spacing_mm: self.letter_spacing_mm, lines: self.lines }
    }
    fn validate(&self) -> Result<(), String> {
        crate::templates::TemplateStore::validate(&self.template())?;
        if !["template", "manual", "pdf", "image"].contains(&self.source.as_str()) { return Err("工程版面来源无效".into()); }
        match (self.scale_x, self.scale_y) {
            (None, None) => {},
            (Some(x), Some(y)) if [x, y].iter().all(|v| v.is_finite() && (0.1..=10.).contains(v)) => {},
            _ => return Err("工程版面横纵比例必须成对且在 0.1..10 内".into()),
        }
        if let Some(d) = &self.derivation {
            if !["two", "three"].contains(&d.mode.as_str())
                || ![d.base_width_mm,d.base_height_mm].iter().all(|v| v.is_finite() && *v > 0. && *v <= 1000.)
                || ![d.scale_x,d.scale_y].iter().all(|v| v.is_finite() && (0.1..=10.).contains(v))
                || (d.mode == "two" && d.scale_x != d.scale_y) {
                return Err("工程版面反推参数无效".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Project {
    pub pages: Vec<Page>, pub current_page: usize, pub template: Template,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layouts: Option<Vec<Layout>>,
    pub writing: Writing, pub routing: Routing, pub calibration: Calibration,
    pub conversion: Conversion, pub background_visible: bool, pub show_margins: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Conversion {
    pub dpi: f64, pub threshold: u8, pub conservative: bool, pub tolerance_mm: f64,
    pub filter_iterations: u32, pub error_threshold: f64, pub line_threshold: f64, pub despeckle_level: u32,
}
#[derive(Serialize, Deserialize)]
struct Manifest { format: String, version: u32, app_version: String, page_count: usize, current_page: usize }

fn migrate_layouts(project: &mut Project) -> Result<(), String> {
    if project.layouts.is_some() { return Ok(()); }
    if project.pages.iter().any(|p| p.layout_id.is_some()) { return Err("工程缺少版面集合，不能解析页面引用".into()); }
    let mut layouts: Vec<Layout> = Vec::new();
    for page in &mut project.pages {
        let doc: Document = serde_json::from_value(page.document.clone()).map_err(|e| format!("工程字迹无效：{e}"))?;
        let index = layouts.iter().position(|l| l.width_mm == doc.width_mm && l.height_mm == doc.height_mm).unwrap_or(layouts.len());
        if index == layouts.len() {
            let t = &project.template;
            layouts.push(Layout { id: format!("layout-{}", index + 1), name: t.name.clone(), description: t.description.clone(),
                width_mm: doc.width_mm, height_mm: doc.height_mm,
                margin_mm: if t.margin_mm * 2. < doc.width_mm.min(doc.height_mm) { t.margin_mm } else { doc.width_mm.min(doc.height_mm) / 4. },
                font_size_mm: t.font_size_mm, letter_spacing_mm: t.letter_spacing_mm, lines: t.lines, source: "template".into(), derivation: None, scale_x: None, scale_y: None });
        }
        page.layout_id = Some(layouts[index].id.clone());
    }
    let page = project.pages.get(project.current_page).ok_or("工程当前页无效")?;
    project.template = layouts.iter().find(|l| Some(&l.id) == page.layout_id.as_ref()).ok_or("工程版面引用无效")?.template();
    project.layouts = Some(layouts);
    Ok(())
}

fn persistent_calibration(project: &mut Project) -> Result<(), String> {
    let previous = project.calibration.registration;
    let [sx, sy] = previous.matrix.map(|[a,b,c,d]| [a.hypot(c), b.hypot(d)]).unwrap_or([previous.scale; 2]);
    let layouts = project.layouts.as_mut().ok_or("工程缺少版面集合")?;
    for layout in layouts.iter_mut() {
        layout.validate()?;
        if layout.scale_x.is_none() { layout.scale_x = Some(sx); layout.scale_y = Some(sy); }
    }
    let page = project.pages.get(project.current_page).ok_or("工程当前页无效")?;
    let layout = layouts.iter().find(|l| Some(&l.id) == page.layout_id.as_ref()).ok_or("工程页面版面引用无效")?;
    let (sx, sy) = (layout.scale_x.ok_or("工程横向比例缺失")?, layout.scale_y.ok_or("工程纵向比例缺失")?);
    project.calibration.registration = Registration { scale: (sx + sy) / 2., rotation_deg: 0., matrix: Some([sx, 0., 0., sy]) };
    project.calibration.profiles.clear();
    project.calibration.selected_profile.clear();
    Ok(())
}

fn validate(project: &Project) -> Result<(), String> {
    if project.pages.is_empty() || project.pages.len() > MAX_PAGES || project.current_page >= project.pages.len() { return Err("工程页数或当前页无效".into()); }
    crate::templates::TemplateStore::validate(&project.template)?;
    if let Some(layouts) = &project.layouts {
        if layouts.is_empty() || layouts.len() > MAX_PAGES || layouts.iter().map(|l| &l.id).collect::<HashSet<_>>().len() != layouts.len() { return Err("工程版面数量或标识无效".into()); }
        for layout in layouts { layout.validate()?; }
        for page in &project.pages {
            let layout = layouts.iter().find(|l| Some(&l.id) == page.layout_id.as_ref()).ok_or("工程页面版面引用无效")?;
            let matches = |value: Option<f64>, expected: f64| value.is_some_and(|v| v.is_finite() && (v - expected).abs() <= 1e-7);
            if !matches(page.document["width_mm"].as_f64(), layout.width_mm) || !matches(page.document["height_mm"].as_f64(), layout.height_mm)
                {
                return Err("工程页面、背景和版面尺寸不一致".into());
            }
        }
        let active = layouts.iter().find(|l| Some(&l.id) == project.pages[project.current_page].layout_id.as_ref()).unwrap();
        if serde_json::to_value(active.template()).map_err(|e| e.to_string())? != serde_json::to_value(&project.template).map_err(|e| e.to_string())? { return Err("工程当前版面快照不一致".into()); }
    } else if project.pages.iter().any(|p| p.layout_id.is_some()) { return Err("工程缺少版面集合".into()); }
    let w = &project.writing;
    if ![w.feed, w.travel_feed, w.z_feed].iter().all(|v| crate::device::valid_feed(*v)) || !(2.0..=10.).contains(&w.z_down) || ![0.1,0.5,1.,5.,10.].contains(&w.jog_step) { return Err("工程书写参数无效".into()); }
    if !project.routing.max_gap.is_finite() || !(0.0..=10.).contains(&project.routing.max_gap) { return Err("工程线路参数无效".into()); }
    project.calibration.registration.validate()?;
    if let Some(third) = project.calibration.point3 {
        Registration::validate_three_points(project.calibration.points[0],project.calibration.points[1],third)?;
        if third[0] < 0. || third[1] < 0. || third[0] > project.template.width_mm || third[1] > project.template.height_mm { return Err("工程第三校准点超出纸张".into()); }
    }
    if project.calibration.origin.is_some_and(|p| !p.iter().all(|v| v.is_finite())) || !project.calibration.points.iter().flatten().all(|v| v.is_finite()) { return Err("工程校准坐标无效".into()); }
    if project.calibration.profiles.len() > 1000 { return Err("工程校准方案过多".into()); }
    for profile in &project.calibration.profiles { profile.validate()?; }
    if project.calibration.profiles.iter().map(|p| &p.id).collect::<HashSet<_>>().len() != project.calibration.profiles.len() { return Err("校准方案 ID 重复".into()); }
    let c = &project.conversion;
    let options = ImportOptions { dpi: c.dpi, tolerance_mm: c.tolerance_mm, filter_iterations:c.filter_iterations, error_threshold:c.error_threshold, line_threshold:c.line_threshold, despeckle_level:c.despeckle_level, ..Default::default() };
    crate::import::validate_raster_options(&options)?;
    if !c.tolerance_mm.is_finite() || !(0.001..=10.).contains(&c.tolerance_mm) { return Err("路径拟合容差无效".into()); }
    for page in &project.pages {
        let doc: Document = serde_json::from_value(page.document.clone()).map_err(|e| format!("工程字迹无效：{e}"))?;
        if let Some(bg) = &page.background { bg.validate(doc.width_mm, doc.height_mm)?; }
        if doc.strokes.is_empty() {
            if ![doc.width_mm, doc.height_mm].iter().all(|v| v.is_finite() && *v > 0. && *v <= 1000.) { return Err("空白页尺寸无效".into()); }
        } else { crate::import::validate(doc)?; }
        let fields = ["name", "width_mm", "height_mm", "strokes", "materials", "strokeOwners", "strokeIds", "route_optimized", "text_settings"];
        if page.document.as_object().unwrap().keys().any(|k| !fields.contains(&k.as_str())) || page.document.get("route_optimized").is_some_and(|v| !v.is_boolean()) { return Err("工程字迹字段无效".into()); }
        for key in ["strokeIds", "strokeOwners"] {
            if let Some(values) = page.document.get(key) {
                let values = values.as_array().ok_or("字迹标识无效")?;
                if values.len() != page.document["strokes"].as_array().unwrap().len() || !values.iter().all(Value::is_string) { return Err("字迹标识数量无效".into()); }
                if key == "strokeIds" && values.iter().map(|v| v.as_str().unwrap()).collect::<HashSet<_>>().len() != values.len() { return Err("笔画标识重复".into()); }
            }
        }
        if let Some(materials) = page.document.get("materials") {
            if !materials.as_array().is_some_and(|a| a.iter().all(|v| ["id","name","kind"].iter().all(|k| v[*k].is_string())) && a.iter().map(|v| v["id"].as_str().unwrap()).collect::<HashSet<_>>().len() == a.len()) { return Err("素材信息无效".into()); }
        }
    }
    Ok(())
}

fn json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, String> { serde_json::to_vec_pretty(value).map_err(|e| e.to_string()) }
fn entry<W: Write + Seek>(zip: &mut ZipWriter<W>, name: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_ENTRY { return Err("工程单项内容超过 128 MB".into()); }
    zip.start_file(name, SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).map_err(|e| e.to_string())?;
    zip.write_all(bytes).map_err(|e| e.to_string())
}
fn read_entry<R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str) -> Result<Vec<u8>, String> {
    let mut file = zip.by_name(name).map_err(|_| format!("工程缺少 {name}"))?;
    if file.size() > MAX_ENTRY { return Err("工程单项内容过大".into()); }
    let mut bytes = Vec::new();
    (&mut file).take(MAX_ENTRY + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_ENTRY { return Err("工程单项内容过大".into()); }
    Ok(bytes)
}
fn json_entry<T: for<'a> Deserialize<'a>, R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str) -> Result<T, String> {
    serde_json::from_slice(&read_entry(zip, name)?).map_err(|e| format!("工程配置 {name} 无效：{e}"))
}
fn nonce() -> String { format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()) }

fn asset_extension(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.starts_with(b"%PDF-") { Ok("pdf") }
    else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Ok("png") }
    else if bytes.starts_with(b"\xff\xd8\xff") { Ok("jpg") }
    else { Err("背景原文件不是 PDF、PNG 或 JPEG".into()) }
}
fn pack_asset(zip: &mut ZipWriter<File>, path: &str, assets: &mut HashMap<String,String>, total: &mut u64) -> Result<String, String> {
    if let Some(asset) = assets.get(path) { return Ok(asset.clone()); }
    let file = File::open(path).map_err(|e| format!("无法打包背景 {path}：{e}"))?;
    let mut bytes = Vec::new(); file.take(MAX_ENTRY + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let extension = asset_extension(&bytes)?;
    *total += bytes.len() as u64;
    if *total > MAX_TOTAL { return Err("工程内容超过 512 MB".into()); }
    let asset = format!("backgrounds/{}.{}", assets.len(), extension);
    entry(zip, &asset, &bytes)?; assets.insert(path.into(), asset.clone()); Ok(asset)
}
fn unpack_asset(zip: &mut ZipArchive<File>, path: &str, assets: &mut HashMap<String,String>, directory: &Path) -> Result<String,String> {
    if let Some(target) = assets.get(path) { return Ok(target.clone()); }
    let (number, extension) = path.strip_prefix("backgrounds/").and_then(|s| s.split_once('.')).ok_or("工程背景引用无效")?;
    let index = number.parse::<usize>().ok().filter(|i| *i < MAX_PAGES * 2).ok_or("工程背景引用无效")?;
    if !["pdf","png","jpg"].contains(&extension) || path != format!("backgrounds/{index}.{extension}") { return Err("工程背景引用无效".into()); }
    let bytes = read_entry(zip, path)?;
    if asset_extension(&bytes)? != extension { return Err("工程背景格式与引用不符".into()); }
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let target = directory.join(format!("background-{index}.{extension}"));
    fs::write(&target, bytes).map_err(|e| e.to_string())?;
    let target = target.to_string_lossy().into_owned(); assets.insert(path.into(), target.clone()); Ok(target)
}

fn save_at(path: &Path, mut project: Project) -> Result<(), String> {
    validate(&project)?;
    if project.layouts.is_none() { migrate_layouts(&mut project)?; validate(&project)?; }
    persistent_calibration(&mut project)?;
    validate(&project)?;
    if path.extension().and_then(|s| s.to_str()).is_none_or(|s| !s.eq_ignore_ascii_case("inkproj")) { return Err("工程文件必须使用 .inkproj 后缀".into()); }
    let temporary = path.with_file_name(format!(".openink-{}.tmp", nonce()));
    let result = (|| {
        let mut zip = ZipWriter::new(File::create(&temporary).map_err(|e| e.to_string())?);
        let mut assets = HashMap::new();
        let mut total = 0u64;
        for page in &mut project.pages {
            if let Some(bg) = &mut page.background {
                bg.path = pack_asset(&mut zip, &bg.path, &mut assets, &mut total)?;
                if let Some(source) = &bg.source_path { bg.source_path = Some(pack_asset(&mut zip, source, &mut assets, &mut total)?); }
            }
        }
        let manifest = Manifest { format:"openink-project".into(), version:2, app_version:env!("CARGO_PKG_VERSION").into(), page_count:project.pages.len(), current_page:project.current_page };
        let mut config = serde_json::to_value(&project).map_err(|e| e.to_string())?;
        config.as_object_mut().unwrap().remove("pages");
        config["calibration"]["registration"].as_object_mut().unwrap().remove("rotation_deg");
        // Each configuration stays independently inspectable inside the private container.
        for name in ["template","layouts","writing","routing","calibration","conversion"] {
            let bytes = json_bytes(&config[name])?; total += bytes.len() as u64;
            entry(&mut zip, &format!("config/{name}.json"), &bytes)?;
        }
        let display = serde_json::json!({"background_visible":project.background_visible,"show_margins":project.show_margins});
        let display = json_bytes(&display)?; total += display.len() as u64;
        entry(&mut zip, "config/display.json", &display)?;
        for (i, page) in project.pages.iter().enumerate() {
            let bytes = json_bytes(page)?; total += bytes.len() as u64;
            let document: Document = serde_json::from_value(page.document.clone()).map_err(|e| e.to_string())?;
            let svg = crate::import::svg_string(&document);
            total += svg.len() as u64;
            if total > MAX_TOTAL { return Err("工程内容超过 512 MB".into()); }
            entry(&mut zip, &format!("pages/{i}.json"), &bytes)?;
            entry(&mut zip, &format!("ink/{i}.svg"), svg.as_bytes())?;
        }
        let manifest = json_bytes(&manifest)?; total += manifest.len() as u64;
        if total > MAX_TOTAL { return Err("工程内容超过 512 MB".into()); }
        entry(&mut zip, "manifest.json", &manifest)?;
        let file = zip.finish().map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() > MAX_ARCHIVE { return Err("压缩工程超过 256 MB".into()); }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, path).map_err(|e| format!("无法保存工程，原文件保留：{e}"))
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn open_at(path: &Path) -> Result<Project, String> {
    let file = File::open(path).map_err(|e| format!("无法打开工程：{e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_ARCHIVE { return Err("工程压缩包过大".into()); }
    let mut zip = ZipArchive::new(file).map_err(|_| "不是有效的 .inkproj 工程包".to_string())?;
    if zip.len() > 1200 { return Err("工程文件数量过多".into()); }
    let mut names = HashSet::new(); let mut total = 0u64;
    for i in 0..zip.len() {
        let file = zip.by_index(i).map_err(|e| e.to_string())?;
        if file.enclosed_name().is_none() || file.name().contains('\\') || file.name().contains(':') || !names.insert(file.name().to_owned()) { return Err("工程包含非法或重复路径".into()); }
        total = total.checked_add(file.size()).ok_or("工程尺寸溢出")?;
        if file.size() > MAX_ENTRY || total > MAX_TOTAL { return Err("工程解压内容过大".into()); }
    }
    let manifest: Manifest = json_entry(&mut zip, "manifest.json")?;
    if !((manifest.format == "openink-project" && [1,2].contains(&manifest.version))
        || (manifest.format == "kenjoy-project" && manifest.version == 1)) { return Err("不支持的工程协议或版本，请使用匹配版本的软件".into()); }
    if manifest.page_count == 0 || manifest.page_count > MAX_PAGES { return Err("工程页数无效".into()); }
    let mut config = serde_json::Map::new();
    for name in ["template","writing","routing","calibration","conversion"] { config.insert(name.into(), json_entry(&mut zip, &format!("config/{name}.json"))?); }
    if manifest.version == 2 {
        let layouts: Vec<Layout> = json_entry(&mut zip, "config/layouts.json")?;
        config.insert("layouts".into(), serde_json::to_value(layouts).map_err(|e| e.to_string())?);
    }
    let display: Value = json_entry(&mut zip, "config/display.json")?;
    for name in ["background_visible","show_margins"] { config.insert(name.into(), display[name].clone()); }
    config.insert("current_page".into(), manifest.current_page.into());
    let mut pages = Vec::new();
    for i in 0..manifest.page_count { pages.push(json_entry::<Value, _>(&mut zip, &format!("pages/{i}.json"))?); }
    config.insert("pages".into(), pages.into());
    if let Some(registration) = config.get_mut("calibration").and_then(|c| c.get_mut("registration")).and_then(Value::as_object_mut) {
        registration.entry("rotation_deg").or_insert(0.into());
    }
    let mut project: Project = serde_json::from_value(config.into()).map_err(|e| format!("工程结构无效：{e}"))?;
    validate(&project)?;
    if manifest.version == 1 { migrate_layouts(&mut project)?; validate(&project)?; }
    persistent_calibration(&mut project)?;
    validate(&project)?;
    let directory = std::env::temp_dir().join(format!("openink-project-{}", nonce()));
    let result = (|| {
        let mut assets = HashMap::new();
        for page in &mut project.pages {
            if let Some(bg) = &mut page.background {
                bg.path = unpack_asset(&mut zip, &bg.path, &mut assets, &directory)?;
                if let Some(source) = &bg.source_path { bg.source_path = Some(unpack_asset(&mut zip, source, &mut assets, &directory)?); }
            }
        }
        Ok(project)
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&directory); }
    result
}

#[tauri::command]
pub async fn save_project(path: String, project: Project) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_at(Path::new(&path), project)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn open_project(path: String) -> Result<Project, String> {
    tauri::async_runtime::spawn_blocking(move || open_at(Path::new(&path))).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn startup_project_path() -> Option<String> {
    std::env::args().skip(1).find(|p| Path::new(p).extension().is_some_and(|e| e.eq_ignore_ascii_case("inkproj") || e.eq_ignore_ascii_case("kjoy")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> Project {
        serde_json::from_value(json!({
            "pages": [{"document":{"name":"editable","width_mm":210,"height_mm":297,
                "strokes":[[{"x":12,"y":34},{"x":56,"y":78}]],"strokeIds":["stroke-1"],
                "strokeOwners":["material-1"],"materials":[{"id":"material-1","name":"永","kind":"legacy"}],"route_optimized":true,"text_settings":{"text":"测试","font_mode":"regular","font_path":"/font.ttf","glyph_path":"","legacy_selection":[],"legacy_percent":100,"legacy_baseline":1,"legacy_seed":1,"centerline":false,"placement":"free","start_line":0,"offset":0.5,"font_size_mm":10,"letter_spacing_mm":1}},"background":null},
                {"document":{"name":"blank","width_mm":210,"height_mm":297,"strokes":[]},"background":null}],
            "current_page":1,
            "template":{"id":"a4","name":"A4","description":"","width_mm":210,"height_mm":297,"margin_mm":15,"font_size_mm":25,"letter_spacing_mm":1,"lines":8},
            "writing":{"feed":1500,"travel_feed":2500,"z_feed":300,"z_down":4,"jog_step":1},
            "routing":{"optimize":true,"allow_reverse":false,"allow_gap":true,"max_gap":0.1,"deduplicate":false},
            "calibration":{"origin":[210,0],"registration":{"scale":1.01,"rotation_deg":2},"points":[[210,0],[15,282]],"show_points":false,"selected_profile":"","profiles":[]},
            "conversion":{"dpi":300,"threshold":180,"conservative":false,"tolerance_mm":0.1,"filter_iterations":4,"error_threshold":2,"line_threshold":1,"despeckle_level":0},
            "background_visible":true,"show_margins":false
        })).unwrap()
    }
    fn directory() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("openink-project-test-{}", nonce()));
        fs::create_dir(&dir).unwrap(); dir
    }
    #[test]
    fn roundtrip_all_configs_editable_metadata_blank_pages_and_overwrite() {
        let dir = directory(); let path = dir.join("测试.inkproj"); let mut value = fixture();
        save_at(&path, value.clone()).unwrap();
        let mut zip = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let svg = String::from_utf8(read_entry(&mut zip, "ink/0.svg").unwrap()).unwrap();
        assert!(svg.contains("M12 34 L56 78"));
        assert!(zip.by_name("config/calibration.json").is_ok()); drop(zip);
        migrate_layouts(&mut value).unwrap();
        persistent_calibration(&mut value).unwrap();
        assert_eq!(serde_json::to_value(open_at(&path).unwrap()).unwrap(), serde_json::to_value(&value).unwrap());
        value.writing.feed = 1234.; save_at(&path, value.clone()).unwrap();
        assert_eq!(open_at(&path).unwrap().writing.feed, 1234.);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn three_point_project_roundtrip_keeps_scales_and_optional_third_point_without_rotation() {
        let dir=directory();let path=dir.join("three.inkproj");let mut value=fixture();
        assert!(value.calibration.point3.is_none());
        value.calibration.point3=Some([15.,0.]);
        value.calibration.registration.matrix=Some([1.1,0.03,0.02,0.9]);
        save_at(&path,value.clone()).unwrap();
        let restored=open_at(&path).unwrap();
        assert_eq!(restored.calibration.point3,value.calibration.point3);
        let sx = 1.1_f64.hypot(0.02); let sy = 0.03_f64.hypot(0.9);
        assert_eq!(restored.calibration.registration.matrix, Some([sx,0.,0.,sy]));
        assert_eq!(restored.calibration.registration.rotation_deg, 0.);
        let layouts = restored.layouts.unwrap();
        assert!(layouts.iter().all(|layout| layout.scale_x == Some(sx) && layout.scale_y == Some(sy)));
        let mut zip = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let saved: Value = json_entry(&mut zip, "config/calibration.json").unwrap();
        assert!(saved["registration"].get("rotation_deg").is_none());
        assert_eq!(saved["profiles"], json!([]));
        drop(zip);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn legacy_background_target_sizes_are_read_once_and_not_resaved() {
        let background: Background = serde_json::from_value(json!({
            "path":"backgrounds/0.pdf","page":1,"page_count":1,"data_url":"","width_mm":210,"height_mm":297
        })).unwrap();
        assert_eq!(background.legacy_width_mm, Some(210.));
        assert_eq!(background.legacy_height_mm, Some(297.));
        let saved = serde_json::to_value(background).unwrap();
        assert!(saved.get("width_mm").is_none());
        assert!(saved.get("height_mm").is_none());
    }
    #[test]
    fn embeds_shared_background_original_and_preserves_archive_on_failed_save() {
        let dir = directory(); let path = dir.join("background.inkproj"); let pdf = dir.join("original.pdf");
        fs::write(&pdf, b"%PDF-1.4\nfixture-original").unwrap(); let mut value = fixture();
        for (i, page) in value.pages.iter_mut().enumerate() { page.background = Some(Background { path:pdf.to_string_lossy().into_owned(), page:i+1, page_count:2, data_url:if i==0 {"data:image/png;base64,cHJldmlldw==".into()} else {String::new()}, ..Default::default() }); }
        save_at(&path, value.clone()).unwrap(); let before = fs::read(&path).unwrap();
        fs::remove_file(&pdf).unwrap(); assert!(save_at(&path, value).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let restored = open_at(&path).unwrap();
        let first = restored.pages[0].background.as_ref().unwrap(); let second = restored.pages[1].background.as_ref().unwrap();
        assert_eq!(first.path, second.path); assert_eq!(second.page,2); assert!(second.data_url.is_empty());
        assert_eq!(fs::read(&first.path).unwrap(), b"%PDF-1.4\nfixture-original");
        assert!(first.data_url.starts_with("data:image/png"));
        fs::remove_dir_all(Path::new(&first.path).parent().unwrap()).unwrap(); fs::remove_dir_all(dir).unwrap();
    }
    fn archive(path: &Path, files: &[(&str, &[u8])]) {
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in files { entry(&mut zip, name, bytes).unwrap(); }
        zip.finish().unwrap();
    }
    #[test]
    fn rejects_untrusted_paths_protocol_and_missing_entries() {
        let dir = directory(); let path = dir.join("bad.inkproj");
        for name in ["../outside", "C:/outside", "backgrounds\\outside.pdf"] {
            archive(&path, &[(name,b"bad")]); assert!(open_at(&path).unwrap_err().contains("路径"));
        }
        archive(&path, &[("manifest.json",br#"{"format":"openink-project","version":3,"app_version":"9","page_count":1,"current_page":0}"#)]);
        assert!(open_at(&path).unwrap_err().contains("版本"));
        archive(&path, &[("manifest.json",b"{}")]); assert!(open_at(&path).is_err());
        archive(&path, &[]); assert!(open_at(&path).unwrap_err().contains("manifest.json"));
        save_at(&path, fixture()).unwrap();
        let mut project = fixture(); project.pages[0].background = Some(Background {path:"backgrounds/99.pdf".into(),page:1,page_count:1,data_url:String::new(), ..Default::default()});
        let bytes=json_bytes(&project.pages[0]).unwrap();
        let original=ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let mut files=Vec::new(); let mut original=original;
        for i in 0..original.len() { let name=original.by_index(i).unwrap().name().to_owned(); let content=if name=="pages/0.json" {bytes.clone()} else {read_entry(&mut original,&name).unwrap()}; files.push((name,content)); }
        archive(&path,&files.iter().map(|(n,b)|(n.as_str(),b.as_slice())).collect::<Vec<_>>());
        assert!(open_at(&path).is_err()); fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn image_background_original_guides_and_different_page_sizes_roundtrip() {
        let dir = directory(); let path = dir.join("paper.inkproj");
        let png = dir.join("processed.png"); let original = dir.join("original.jpg");
        fs::write(&png, b"\x89PNG\r\n\x1a\nprocessed").unwrap();
        fs::write(&original, b"\xff\xd8\xfforiginal").unwrap();
        let mut value = fixture();
        value.pages[1].document["width_mm"] = json!(148.);
        value.pages[1].document["height_mm"] = json!(210.);
        value.pages[1].background = Some(Background {
            path: png.to_string_lossy().into_owned(), source_path: Some(original.to_string_lossy().into_owned()),
            page: 1, page_count: 1, kind: Some("image".into()), legacy_width_mm: Some(148.), legacy_height_mm: Some(210.),
            processed: Some(true), guides_visible: Some(false),
            guide_lines: vec![GuideLine { id:"line-1".into(), start:[10.,30.], end:[138.,31.] }],
            ..Default::default()
        });
        save_at(&path, value.clone()).unwrap();
        let mut archive = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let saved: Value = json_entry(&mut archive, "pages/1.json").unwrap();
        assert!(saved["background"].get("width_mm").is_none()); assert!(saved["background"].get("height_mm").is_none());
        drop(archive);
        fs::remove_file(&png).unwrap(); fs::remove_file(&original).unwrap();
        let restored = open_at(&path).unwrap(); let bg = restored.pages[1].background.as_ref().unwrap();
        assert_eq!(restored.pages[1].document["width_mm"], json!(148.));
        assert_eq!(bg.guide_lines[0].end, [138.,31.]); assert_eq!(bg.guides_visible, Some(false));
        assert_eq!(fs::read(&bg.path).unwrap(), b"\x89PNG\r\n\x1a\nprocessed");
        assert_eq!(fs::read(bg.source_path.as_ref().unwrap()).unwrap(), b"\xff\xd8\xfforiginal");
        let mut invalid = restored.clone(); invalid.pages[1].background.as_mut().unwrap().guide_lines[0].end[0] = 999.;
        assert!(validate(&invalid).is_err());
        fs::remove_dir_all(Path::new(&bg.path).parent().unwrap()).unwrap(); fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn validates_configs_and_editor_identity_before_writing() {
        let dir=directory(); let path=dir.join("invalid.inkproj");
        let mut value=fixture(); value.writing.z_down=20.; assert!(save_at(&path,value).is_err());
        let mut value=fixture(); value.conversion.tolerance_mm=-1.; assert!(save_at(&path,value).is_err());
        let mut value=fixture(); value.pages[0].document["strokeIds"]=json!([]); assert!(save_at(&path,value).is_err());
        let mut value=fixture(); value.pages[0].document["wco"]=json!([0,0,0]); assert!(save_at(&path,value).is_err());
        assert!(save_at(&dir.join("bad.zip"),fixture()).is_err()); assert!(!path.exists()); fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn version_one_migrates_by_dimensions_without_changing_ink_or_text() {
        let dir = directory(); let path = dir.join("legacy.kjoy"); let mut value = fixture();
        value.pages.push(value.pages[0].clone());
        value.pages[1].document["width_mm"] = json!(148.);
        value.pages[1].document["height_mm"] = json!(210.);
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        let config = serde_json::to_value(&value).unwrap();
        for name in ["template","writing","routing","calibration","conversion"] {
            entry(&mut zip, &format!("config/{name}.json"), &json_bytes(&config[name]).unwrap()).unwrap();
        }
        entry(&mut zip,"config/display.json", &json_bytes(&json!({"background_visible":true,"show_margins":false})).unwrap()).unwrap();
        entry(&mut zip,"manifest.json", &json_bytes(&json!({"format":"kenjoy-project","version":1,"app_version":"0.4.0","page_count":3,"current_page":1})).unwrap()).unwrap();
        for (i,page) in value.pages.iter().enumerate() { entry(&mut zip,&format!("pages/{i}.json"),&json_bytes(page).unwrap()).unwrap(); }
        zip.finish().unwrap();
        let restored = open_at(&path).unwrap();
        assert_eq!(restored.layouts.as_ref().unwrap().len(),2);
        assert_eq!(restored.pages[0].layout_id,restored.pages[2].layout_id);
        assert_ne!(restored.pages[0].layout_id,restored.pages[1].layout_id);
        for (before,after) in value.pages.iter().zip(&restored.pages) { assert_eq!(before.document,after.document); }
        assert_eq!(restored.template.width_mm,148.);
        assert_eq!(restored.template.height_mm,210.);
        assert_eq!(restored.template.font_size_mm,value.template.font_size_mm);
        let original = fs::read(&path).unwrap();
        assert!(save_at(&path,restored.clone()).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        let path = dir.join("converted.inkproj");
        save_at(&path,restored.clone()).unwrap();
        let mut zip = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        assert_eq!(json_entry::<Manifest,_>(&mut zip,"manifest.json").unwrap().version,2);
        assert_eq!(json_entry::<Vec<Layout>,_>(&mut zip,"config/layouts.json").unwrap().len(),2);
        drop(zip);
        assert_eq!(serde_json::to_value(open_at(&path).unwrap()).unwrap(),serde_json::to_value(restored).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[ignore = "requires local historical .kjoy fixtures"]
    fn historical_kjoy_files_convert_without_changing_documents() {
        let dir = directory();
        let sources = std::env::var("OPENINK_LEGACY_FIXTURES").expect("semicolon-separated historical files");
        for (i, source) in sources.split(';').enumerate() {
            let path = Path::new(source); let bytes = fs::read(path).unwrap();
            let project = open_at(path).unwrap();
            let target = dir.join(format!("converted-{i}.inkproj"));
            save_at(&target,project.clone()).unwrap();
            let reopened = open_at(&target).unwrap();
            for (before,after) in project.pages.iter().zip(&reopened.pages) { assert_eq!(before.document,after.document); }
            assert_eq!(serde_json::to_value(&project.layouts).unwrap(),serde_json::to_value(&reopened.layouts).unwrap());
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn version_two_preserves_derivation_and_rejects_invalid_layouts_before_overwrite() {
        let dir=directory(); let path=dir.join("layout.inkproj"); let mut value=fixture(); migrate_layouts(&mut value).unwrap();
        persistent_calibration(&mut value).unwrap();
        let layout=&mut value.layouts.as_mut().unwrap()[0];
        layout.source="pdf".into();
        layout.derivation=Some(LayoutDerivation{mode:"three".into(),base_width_mm:210.,base_height_mm:297.,scale_x:0.99,scale_y:1.01});
        save_at(&path,value.clone()).unwrap();
        assert_eq!(serde_json::to_value(open_at(&path).unwrap()).unwrap(),serde_json::to_value(&value).unwrap());
        let before=fs::read(&path).unwrap();
        let mut invalid=value.clone(); invalid.pages[0].layout_id=None; assert!(save_at(&path,invalid).is_err());
        let mut invalid=value.clone(); invalid.pages[0].layout_id=Some("missing".into()); assert!(save_at(&path,invalid).is_err());
        let mut invalid=value.clone(); let duplicate=invalid.layouts.as_ref().unwrap()[0].clone(); invalid.layouts.as_mut().unwrap().push(duplicate); assert!(save_at(&path,invalid).is_err());
        let mut invalid=value.clone(); invalid.layouts.as_mut().unwrap()[0].width_mm=f64::NAN; assert!(save_at(&path,invalid).is_err());
        let mut invalid=value.clone(); invalid.pages[0].document["width_mm"]=json!(211); assert!(save_at(&path,invalid).is_err());
        let mut invalid=value.clone(); invalid.template.margin_mm+=1.; assert!(save_at(&path,invalid).is_err());
        let mut invalid=value.clone(); invalid.layouts.as_mut().unwrap()[0].derivation.as_mut().unwrap().scale_x=f64::INFINITY; assert!(save_at(&path,invalid).is_err());
        let mut invalid=value.clone(); invalid.layouts.as_mut().unwrap()[0].source="machine".into(); assert!(save_at(&path,invalid).is_err());
        let mut invalid=value.clone(); invalid.pages[0].background=Some(Background{path:"unused.png".into(),page:1,page_count:1,legacy_width_mm:Some(200.),legacy_height_mm:Some(297.),..Default::default()}); assert!(save_at(&path,invalid).unwrap_err().contains("尺寸"));
        let mut json=serde_json::to_value(&value).unwrap(); json["layouts"][0]["wco"]=json!([0,0,0]); assert!(serde_json::from_value::<Project>(json).is_err());
        assert_eq!(fs::read(&path).unwrap(),before);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn page_scales_roundtrip_and_invalid_pairs_preserve_existing_archive() {
        let dir = directory(); let path = dir.join("scales.inkproj"); let mut value = fixture();
        migrate_layouts(&mut value).unwrap(); persistent_calibration(&mut value).unwrap();
        value.layouts.as_mut().unwrap()[0].scale_x = Some(0.98);
        value.layouts.as_mut().unwrap()[0].scale_y = Some(1.02);
        save_at(&path, value.clone()).unwrap();
        let restored = open_at(&path).unwrap(); let layout = &restored.layouts.as_ref().unwrap()[0];
        assert_eq!((layout.scale_x, layout.scale_y), (Some(0.98), Some(1.02)));
        assert_eq!((layout.width_mm, layout.height_mm), (210., 297.));
        let original = fs::read(&path).unwrap();
        for scales in [(Some(0.98), None), (Some(f64::NAN), Some(1.)), (Some(11.), Some(1.))] {
            let layout = &mut value.layouts.as_mut().unwrap()[0]; layout.scale_x = scales.0; layout.scale_y = scales.1;
            assert!(save_at(&path, value.clone()).is_err());
            assert_eq!(fs::read(&path).unwrap(), original);
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_layouts_or_page_references_return_errors_without_panicking() {
        let mut value = fixture();
        assert!(persistent_calibration(&mut value).is_err());
        migrate_layouts(&mut value).unwrap();
        value.pages[value.current_page].layout_id = None;
        assert!(persistent_calibration(&mut value).is_err());
        let dir = directory(); let path = dir.join("malformed.inkproj");
        save_at(&path, fixture()).unwrap();
        let mut zip = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let mut files = Vec::new();
        for i in 0..zip.len() {
            let name = zip.by_index(i).unwrap().name().to_owned();
            let bytes = if name == "config/layouts.json" { b"null".to_vec() } else { read_entry(&mut zip, &name).unwrap() };
            files.push((name, bytes));
        }
        drop(zip);
        archive(&path, &files.iter().map(|(name, bytes)| (name.as_str(), bytes.as_slice())).collect::<Vec<_>>());
        assert!(open_at(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
