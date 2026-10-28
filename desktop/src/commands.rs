use crate::{
    device::{self, DeviceCommand, DeviceEvent, DeviceService, Job},
    import::{self, ImportOptions},
    model::Document,
    templates::{Template, TemplateStore},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub struct Backend {
    device: Mutex<DeviceService>,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn compare_routes(
    job: Job,
    start: Option<crate::model::Point>,
    allow_reverse: bool,
    official_baseline: bool,
    stroke_owners: Vec<String>,
    max_gap_mm: Option<f64>,
    deduplicate: Option<bool>,
    trajectory_enabled: Option<bool>,
) -> Result<crate::route_compare::Comparison, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::route_compare::compare_with_options(
            job,
            start,
            allow_reverse,
            official_baseline,
            stroke_owners,
            crate::route_compare::Options {
                max_gap_mm: max_gap_mm.unwrap_or(0.),
                deduplicate: deduplicate.unwrap_or(false),
                trajectory_enabled: trajectory_enabled.unwrap_or(true),
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn optimize_document(
    document: Document,
    start: Option<crate::model::Point>,
    allow_reverse: bool,
    travel_feed_mm_min: f64,
) -> Result<crate::route_opt::OptimizationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::route_opt::optimize(&document, start, allow_reverse, travel_feed_mm_min)
    })
    .await
    .map_err(|e| e.to_string())?
}
impl Backend {
    pub fn new() -> Self {
        Self {
            device: Mutex::new(DeviceService::new()),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Scan,
    AutoConnect,
    Connect {
        port: String,
    },
    Recover {
        port: String,
    },
    Disconnect,
    Jog {
        x: f64,
        y: f64,
        feed: f64,
    },
    Calibrate {
        canvas_x: f64,
        canvas_y: f64,
        origin_x: f64,
        origin_y: f64,
        raised_confirmed: bool,
    },
    MoveTo {
        canvas_x: f64,
        canvas_y: f64,
        feed: f64,
    },
    BeginRegistration { canvas_x: f64, canvas_y: f64, #[serde(default)] preserve_scale: Option<[f64; 2]> },
    FinishRegistration { canvas_x: f64, canvas_y: f64 },
    CaptureRegistrationSecond { canvas_x: f64, canvas_y: f64 },
    FinishRegistrationThird { canvas_x: f64, canvas_y: f64 },
    CancelRegistration,
    ApplyRegistration { origin: [f64; 2], scale: f64, rotation_deg: f64, #[serde(default)] matrix: Option<[f64;4]> },
    ReturnOrigin,
    ConfirmManualOrigin { raised_confirmed: bool },
    ForgetCalibration,
    SetRegistrationScale { scales: [f64; 2] },
    ResetOrigin,
    AlignTopRight {
        width_mm: f64,
    },
    PenUp,
    PenDown {
        #[serde(default = "device::default_z_down")]
        depth: f64,
    },
    Pause,
    Resume,
    Stop,
    Run {
        job: Job,
    },
}
#[tauri::command(rename_all = "snake_case")]
pub fn device_command(command: Request, state: tauri::State<Backend>) -> Result<(), String> {
    let c = match command {
        Request::Scan => DeviceCommand::Scan,
        Request::AutoConnect => DeviceCommand::AutoConnect,
        Request::Connect { port } => DeviceCommand::Connect(port),
        Request::Recover { port } => DeviceCommand::Recover(port),
        Request::Disconnect => DeviceCommand::Disconnect,
        Request::Jog { x, y, feed } => DeviceCommand::Jog { x, y, feed },
        Request::Calibrate {
            canvas_x,
            canvas_y,
            origin_x,
            origin_y,
            raised_confirmed,
        } => DeviceCommand::Calibrate {
            canvas_x,
            canvas_y,
            origin_x,
            origin_y,
            raised_confirmed,
        },
        Request::MoveTo {
            canvas_x,
            canvas_y,
            feed,
        } => DeviceCommand::MoveTo {
            canvas_x,
            canvas_y,
            feed,
        },
        Request::BeginRegistration { canvas_x, canvas_y, preserve_scale } => DeviceCommand::BeginRegistration { canvas_x, canvas_y, preserve_scale },
        Request::CancelRegistration => DeviceCommand::CancelRegistration,
        Request::FinishRegistration { canvas_x, canvas_y } => DeviceCommand::FinishRegistration { canvas_x, canvas_y },
        Request::ApplyRegistration { origin, scale, rotation_deg, matrix } => DeviceCommand::ApplyRegistration { origin, scale, rotation_deg, matrix },
        Request::CaptureRegistrationSecond { canvas_x, canvas_y } => DeviceCommand::CaptureRegistrationSecond { canvas_x, canvas_y },
        Request::FinishRegistrationThird { canvas_x, canvas_y } => DeviceCommand::FinishRegistrationThird { canvas_x, canvas_y },
        Request::ReturnOrigin => DeviceCommand::ReturnOrigin,
        Request::ConfirmManualOrigin { raised_confirmed } => DeviceCommand::ConfirmManualOrigin { raised_confirmed },
        Request::ForgetCalibration => {
            let (tx, rx) = std::sync::mpsc::channel();
            state.device.lock().map_err(|e| e.to_string())?.command(DeviceCommand::ForgetCalibration(tx));
            return rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_| "Device did not confirm project positioning reset".to_string())?;
        },
        Request::SetRegistrationScale { scales } => {
            let (tx, rx) = std::sync::mpsc::channel();
            state.device.lock().map_err(|e| e.to_string())?.command(DeviceCommand::SetRegistrationScale { scales, reply: tx });
            return rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_| "Device did not confirm page scales".to_string())?;
        },
        Request::ResetOrigin => DeviceCommand::ResetOrigin,
        Request::AlignTopRight { width_mm } => DeviceCommand::AlignTopRight { width_mm },
        Request::PenUp => DeviceCommand::PenUp,
        Request::PenDown { depth } => DeviceCommand::PenDown { depth },
        Request::Pause => DeviceCommand::Pause,
        Request::Resume => DeviceCommand::Resume,
        Request::Stop => DeviceCommand::Stop,
        Request::Run { job } => DeviceCommand::Run(job),
    };
    state.device.lock().map_err(|e| e.to_string())?.command(c);
    Ok(())
}
#[tauri::command]
pub fn poll_device(state: tauri::State<Backend>) -> Result<Vec<Value>, String> {
    Ok(state
        .device
        .lock()
        .map_err(|e| e.to_string())?
        .poll()
        .into_iter()
        .map(|e| match e {
            DeviceEvent::Ports(ports) => json!({"type":"ports","ports":ports}),
            DeviceEvent::AutoOrigin(automatic) => {
                json!({"type":"origin_mode","automatic":automatic})
            }
            DeviceEvent::Connected(port) => json!({"type":"connected","port":port}),
            DeviceEvent::Disconnected => json!({"type":"disconnected"}),
            DeviceEvent::Status(status) => json!({"type":"status","status":status}),
            DeviceEvent::Log(message) => json!({"type":"log","message":message}),
            DeviceEvent::Error(message) => json!({"type":"error","message":message}),
            DeviceEvent::JobRejected { reason, running } => {
                json!({"type":"job_rejected","reason":reason,"running":running})
            }
            DeviceEvent::Progress { sent, total } => {
                json!({"type":"progress","sent":sent,"total":total})
            }
            DeviceEvent::Timing { total_seconds, cumulative_seconds } => {
                json!({"type":"timing","total_seconds":total_seconds,"cumulative_seconds":cumulative_seconds})
            }
            DeviceEvent::StrokeCompleted { index } => json!({"type":"stroke_completed","index":index}),
            DeviceEvent::Completed => json!({"type":"completed"}),
            DeviceEvent::Stopped => json!({"type":"stopped"}),
            DeviceEvent::Recovering(active) => json!({"type":"recovering","active":active}),
            DeviceEvent::Positioning(active) => json!({"type":"positioning","active":active}),
            DeviceEvent::RegistrationChanged { scale, rotation_deg, matrix } => json!({"type":"registration_changed", "scale":scale, "rotation_deg":rotation_deg, "matrix":matrix}),
            DeviceEvent::RegistrationPointCaptured { index } => json!({"type":"registration_point_captured", "index":index}),
            DeviceEvent::CalibrationChanged { origin } => {
                json!({"type":"calibration_changed","origin":origin})
            }
            DeviceEvent::JobStarted { anchor } => json!({"type":"job_started","anchor":anchor}),
            DeviceEvent::Paused(paused) => json!({"type":"paused","paused":paused}),
        })
        .collect())
}
#[tauri::command]
pub fn default_import_options() -> ImportOptions {
    ImportOptions::default()
}
#[tauri::command(rename_all = "snake_case")]
pub async fn import_document(path: String, options: ImportOptions) -> Result<Document, String> {
    tauri::async_runtime::spawn_blocking(move || import::import_file(Path::new(&path), &options))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command(rename_all = "snake_case")]
pub async fn import_comparison(
    path: String,
    options: ImportOptions,
) -> Result<Vec<import::ComparisonVariant>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import::preview_variants(Path::new(&path), &options)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn private_gfont_available() -> bool {
    cfg!(feature = "private-gfont")
}

#[cfg(feature = "private-gfont")]
fn legacy_store() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|p| p.join("OpenInkStudio").join("legacy-fonts"))
        .ok_or_else(|| "LOCALAPPDATA is not configured".into())
}

#[cfg(feature = "private-gfont")]
#[tauri::command]
pub async fn list_legacy_fonts() -> Result<Vec<crate::legacy_font::FontSummary>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(crate::legacy_font::discover(&[legacy_store()?])))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(feature = "private-gfont")]
#[tauri::command(rename_all = "snake_case")]
pub async fn import_legacy_fonts(
    paths: Vec<String>,
) -> Result<Vec<crate::legacy_font::FontSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let store = legacy_store()?;
        // Validate every original font completely before adding any to the library.
        let mut fonts = Vec::new();
        for path in paths {
            let font = crate::legacy_font::load(Path::new(&path))?;
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            fonts.push((font.summary, bytes));
        }
        std::fs::create_dir_all(&store).map_err(|e| e.to_string())?;
        let mut imported = Vec::new();
        for (mut summary, bytes) in fonts {
            let name = Path::new(&summary.path)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let mut index = 0u64;
            loop {
                let target = store.join(if index == 0 {
                    format!("{name}.gfont")
                } else {
                    format!("{name}-{index}.gfont")
                });
                match std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                {
                    Ok(mut file) => {
                        if let Err(e) = file.write_all(&bytes) {
                            drop(file);
                            let _ = std::fs::remove_file(&target);
                            return Err(e.to_string());
                        }
                        summary.path = target.to_string_lossy().into_owned();
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        if std::fs::read(&target).map_err(|e| e.to_string())? == bytes {
                            summary.path = target.to_string_lossy().into_owned();
                            break;
                        }
                        index += 1;
                    }
                    Err(e) => return Err(e.to_string()),
                }
            }
            if !imported
                .iter()
                .any(|f: &crate::legacy_font::FontSummary| f.path == summary.path)
            {
                imported.push(summary);
            }
        }
        Ok(imported)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(feature = "private-gfont")]
#[tauri::command(rename_all = "snake_case")]
pub async fn legacy_font_document(
    selections: Vec<crate::legacy_font::FontSelection>,
    text: String,
    options: crate::legacy_font::ComposeOptions,
) -> Result<crate::legacy_font::Composition, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::legacy_font::compose(&selections, &text, &options)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pdf_background_page(
    path: String,
    page: usize,
) -> Result<import::PdfBackgroundPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import::pdf_background_page(Path::new(&path), page)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn pdf_page_count(path: String, python_path: Option<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || match python_path {
        Some(python) => import::pdf_page_count_with_python(Path::new(&path), Path::new(&python)),
        None => import::pdf_page_count(Path::new(&path)),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn layout_font(
    path: &Path,
    text: &str,
    size: f64,
    spacing: f64,
    rows: usize,
    width: f64,
    height: f64,
    centerline: bool,
    options: &ImportOptions,
) -> Result<Document, String> {
    if ![size, spacing, width, height].iter().all(|v| v.is_finite())
        || size <= 0.
        || size > 100.
        || spacing < 0.
        || width <= 0.
        || height <= 0.
        || width > 1000.
        || height > 1000.
        || rows == 0
        || rows > 1000
        || text.chars().count() > 5000
    {
        return Err("文字尺寸、排版参数或内容长度无效".into());
    }
    let pitch = height / rows as f64;
    if pitch < size {
        return Err("行高小于字号，请减少行数或字号".into());
    }
    let mut glyphs: HashMap<char, Document> = HashMap::new();
    let mut strokes = vec![];
    let mut x = 0.;
    let mut row = 0;
    for ch in text.chars() {
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            row += 1;
            x = 0.;
            continue;
        }
        if ch.is_whitespace() {
            x += size * 0.5 + spacing;
            continue;
        }
        if !glyphs.contains_key(&ch) {
            let s = ch.to_string();
            let glyph = if centerline {
                import::font_text_centerline(path, &s, size, options)
            } else {
                import::font_text(path, &s, size)
            }?;
            glyphs.insert(ch, glyph);
        }
        let glyph = &glyphs[&ch];
        let minx = glyph
            .strokes
            .iter()
            .flatten()
            .map(|p| p.x)
            .fold(f64::INFINITY, f64::min);
        let maxx = glyph
            .strokes
            .iter()
            .flatten()
            .map(|p| p.x)
            .fold(f64::NEG_INFINITY, f64::max);
        let miny = glyph
            .strokes
            .iter()
            .flatten()
            .map(|p| p.y)
            .fold(f64::INFINITY, f64::min);
        let maxy = glyph
            .strokes
            .iter()
            .flatten()
            .map(|p| p.y)
            .fold(f64::NEG_INFINITY, f64::max);
        let ink_width = maxx - minx;
        if ink_width > width {
            return Err(format!("字符 {ch} 宽度超过可写区域"));
        }
        if x + ink_width > width {
            row += 1;
            x = 0.;
        }
        if row >= rows || row as f64 * pitch + (maxy - miny) > height {
            return Err("文字超出当前模板，请调整字号、行数或页尺寸".into());
        }
        for stroke in &glyph.strokes {
            strokes.push(
                stroke
                    .iter()
                    .map(|p| crate::model::Point {
                        x: x + p.x - minx,
                        y: row as f64 * pitch + p.y - miny,
                    })
                    .collect(),
            );
        }
        x += glyph.width_mm.max(ink_width) + spacing;
    }
    if strokes.is_empty() {
        return Err("没有可书写文字".into());
    }
    Ok(Document {
        name: if centerline {
            "字体中心线"
        } else {
            "字体轮廓"
        }
        .into(),
        width_mm: width,
        height_mm: height,
        strokes,
    })
}
#[tauri::command(rename_all = "snake_case")]
pub async fn font_document(
    path: String,
    text: String,
    size_mm: f64,
    spacing_mm: f64,
    rows: usize,
    width_mm: f64,
    height_mm: f64,
    centerline: bool,
    options: ImportOptions,
) -> Result<Document, String> {
    tauri::async_runtime::spawn_blocking(move || {
        layout_font(
            Path::new(&path),
            &text,
            size_mm,
            spacing_mm,
            rows,
            width_mm,
            height_mm,
            centerline,
            &options,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command(rename_all = "snake_case")]
pub fn generate_gcode(
    job: Job,
    relative: bool,
    origin: Option<[f64; 2]>,
    registration: Option<crate::positioning::Registration>,
) -> Result<String, String> {
    if let Some(origin) = origin {
        if relative {
            return Err("Canvas positioning uses absolute G54 coordinates, not relative first-point placement".into());
        }
        let registration = registration.unwrap_or_default();
        let lines = crate::positioning::registered_job(&job, origin, registration)?;
        let mapping = if let Some([a,b,c,d]) = registration.matrix {
            format!("matrix [{a:.9}, {b:.9}, {c:.9}, {d:.9}]")
        } else { format!("scale {:.6}, rotation {:.6} degrees",registration.scale,registration.rotation_deg) };
        return Ok(format!("; Fixed canvas placement: G54 origin at canvas X{:.3} Y{:.3} mm\n; Registration {mapping}\n; Requires the same confirmed calibration and raised Z0 before execution\n{}\n", origin[0], origin[1], lines.join("\n")));
    }
    if registration.is_some() { return Err("Registration requires a confirmed canvas origin".into()); }
    let lines = if relative {
        device::build_relative_job(&job)?
    } else {
        device::build_job(&job, [0., 0., 0.])?
    };
    let label = if relative {
        "XY relative to current pen point; Z requires calibrated raised Z0"
    } else {
        "PREVIEW ONLY: assumed XY anchor 0,0; do not replay as a positioned job"
    };
    Ok(format!("; {label}\n{}\n", lines.join("\n")))
}
#[tauri::command(rename_all = "snake_case")]
pub fn export_gcode(path: String, job: Job, origin: Option<[f64; 2]>, registration: Option<crate::positioning::Registration>) -> Result<(), String> {
    std::fs::write(path, generate_gcode(job, origin.is_none(), origin, registration)?).map_err(|e| e.to_string())
}
#[tauri::command(rename_all = "snake_case")]
pub fn export_document(path: String, document: Document, format: String) -> Result<(), String> {
    match format.as_str() {
        "svg" => import::export_svg(&document, Path::new(&path)),
        "json" => import::export_json(&document, Path::new(&path)),
        _ => Err("支持SVG或开放JSON".into()),
    }
}
#[tauri::command]
pub fn list_templates() -> Result<Vec<Template>, String> {
    TemplateStore::new().list()
}
#[tauri::command(rename_all = "snake_case")]
pub fn save_template(template: Template) -> Result<(), String> {
    TemplateStore::new().save(&template)
}
#[tauri::command(rename_all = "snake_case")]
pub fn delete_template(id: String) -> Result<(), String> {
    TemplateStore::new().delete(&id)
}
#[tauri::command(rename_all = "snake_case")]
pub fn import_template(path: String) -> Result<Template, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut template: Template = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if template.id.starts_with("builtin-") {
        template.id = format!("imported-{}", template.id)
    }
    TemplateStore::new().save(&template)?;
    Ok(template)
}
#[tauri::command(rename_all = "snake_case")]
pub fn export_template(path: String, template: Template) -> Result<(), String> {
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&template).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn list_fonts() -> Vec<Value> {
    let base = std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| "C:/Windows".into())
        .join("Fonts");
    let Ok(entries) = std::fs::read_dir(base) else {
        return vec![];
    };
    let mut fonts:Vec<_>=entries.filter_map(Result::ok).map(|e|e.path()).filter(|p|matches!(p.extension().and_then(|e|e.to_str()).map(str::to_ascii_lowercase).as_deref(),Some("ttf"|"otf"|"ttc")))
        .map(|p|json!({"name":p.file_stem().unwrap_or_default().to_string_lossy(),"path":p.to_string_lossy()})).collect();
    fonts.sort_by_key(|f| f["name"].as_str().unwrap_or("").to_string());
    fonts
}

#[tauri::command]
pub fn list_glyph_fonts() -> Result<Vec<crate::glyphs::GlyphFontSummary>, String> {
    crate::glyphs::list_fonts()
}
#[tauri::command(rename_all = "snake_case")]
pub async fn save_glyph(
    library_name: String,
    character: String,
    document: Document,
    window: [f64; 4],
) -> Result<crate::glyphs::GlyphFontSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::glyphs::save_glyph(library_name, character, document, window)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command(rename_all = "snake_case")]
pub async fn glyph_font_document(
    path: String,
    text: String,
    size_mm: f64,
    spacing_mm: f64,
    rows: usize,
    width_mm: f64,
    height_mm: f64,
) -> Result<Document, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::glyphs::compose(
            Path::new(&path),
            &text,
            size_mm,
            spacing_mm,
            rows,
            width_mm,
            height_mm,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_routes_ipc_and_legacy_pen_depth() {
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![compare_routes])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "compare", Default::default())
            .build()
            .unwrap();
        let response=tauri::test::get_ipc_response(&webview,tauri::webview::InvokeRequest {
            cmd:"compare_routes".into(),callback:tauri::ipc::CallbackFn(0),error:tauri::ipc::CallbackFn(1),url:"http://tauri.localhost".parse().unwrap(),
            body:tauri::ipc::InvokeBody::Json(json!({"job":{"document":{"name":"test","width_mm":100.,"height_mm":100.,"strokes":[[{"x":0.,"y":0.},{"x":10.,"y":0.}]]},"feed":1500.,"travel_feed":2500.,"z_feed":300.,"z_down":10.},"start":null,"allow_reverse":false,"official_baseline":true,"stroke_owners":[],"max_gap_mm":0.3,"deduplicate":true,"trajectory_enabled":false})),
            headers:Default::default(),invoke_key:tauri::test::INVOKE_KEY.into()
        }).unwrap().deserialize::<Value>().unwrap();
        assert_eq!(response["variants"][0]["label"], "官方原始笔顺");
        assert_eq!(response["variants"][0]["z_mm"], 20.);
        assert_eq!(response["variants"].as_array().unwrap().len(), 4);
        assert!(matches!(
            serde_json::from_value::<Request>(json!({"type":"pen_down"})).unwrap(),
            Request::PenDown { depth: 4. }
        ));
    }

    #[test]
    fn optimize_document_ipc_accepts_ui_snake_case_arguments() {
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![optimize_document])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let invoke = |body: Value| {
            tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: "optimize_document".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
        };
        // Match useRoutePlan's real request, through Tauri's generated dispatcher.
        let request = json!({
            "document": {
                "name": "ipc-route", "width_mm": 100., "height_mm": 100.,
                "strokes": [
                    [{"x": 10., "y": 0.}, {"x": 20., "y": 0.}],
                    [{"x": 1., "y": 0.}, {"x": 2., "y": 0.}]
                ]
            },
            "start": {"x": 0., "y": 0.},
            "allow_reverse": false,
            "travel_feed_mm_min": 1200.
        });
        let result = invoke(request.clone())
            .unwrap()
            .deserialize::<Value>()
            .unwrap();
        assert_eq!(result["stroke_order"], json!([1, 0]));
        assert_eq!(result["reversed"], json!([false, false]));
        assert_eq!(result["document"]["name"], "ipc-route");
        assert_eq!(result["after_distance_mm"], 9.);
        assert_eq!(result["after_travel_seconds"], 0.45);

        for required in ["allow_reverse", "travel_feed_mm_min"] {
            let mut missing = request.clone();
            missing.as_object_mut().unwrap().remove(required);
            let error = invoke(missing)
                .err()
                .expect("required argument must be rejected");
            assert!(error.as_str().unwrap().contains(required), "{error}");
        }
    }

    #[test]
    fn canvas_gcode_preserves_paper_placement_and_does_not_reanchor_first_point() {
        let job = Job {
            document: Document {
                name: "placement".into(),
                width_mm: 100.,
                height_mm: 100.,
                strokes: vec![vec![
                    crate::model::Point { x: 20., y: 30. },
                    crate::model::Point { x: 22., y: 35. },
                ]],
            },
            feed: 1200.,
            travel_feed: 1500.,
            z_feed: 300.,
            z_down: 4.,
        };
        let code = generate_gcode(job.clone(), false, Some([10., 10.]), None).unwrap();
        assert!(code.contains("G54"));
        assert!(code.contains("X10.000 Y-20.000"));
        assert!(code.contains("X12.000 Y-25.000"));
        assert!(!code.contains("G10"));
        assert!(!code.contains("$H"));
        assert!(generate_gcode(job, true, Some([10., 10.]), None).is_err());
    }
    #[test]
    fn font_layout_rejects_invalid_parameters() {
        assert!(layout_font(
            Path::new("missing.ttf"),
            "永",
            10.,
            1.,
            0,
            100.,
            100.,
            false,
            &ImportOptions::default()
        )
        .is_err());
        assert!(layout_font(
            Path::new("missing.ttf"),
            "永",
            10.,
            1.,
            20,
            100.,
            100.,
            false,
            &ImportOptions::default()
        )
        .is_err());
    }
}
