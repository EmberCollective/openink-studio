//! Handwriting recognition is local Python/AutoTrace work; no device access.
use crate::import::{self, ImportOptions};
use serde_json::{json, Value};
use std::{fs, path::Path, process::{Command, Output}, sync::mpsc, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::ipc::Channel;

fn progress(channel: Option<&Channel<Value>>, stage: &str, done: usize, total: usize) {
    if let Some(channel) = channel {
        let _ = channel.send(json!({"stage":stage,"done":done,"total":total}));
    }
}

fn output_with_progress(command: &mut Command, path: &Path, channel: Option<&Channel<Value>>) -> std::io::Result<Output> {
    let Some(channel) = channel else { return command.output(); };
    std::thread::scope(|scope| {
        // Dropping the sender also stops the scoped monitor on launch error or unwinding.
        let (stop, stopped) = mpsc::channel::<()>();
        scope.spawn(move || {
            let mut previous = String::new();
            let mut forward = || {
                if let Ok(text) = fs::read_to_string(path) {
                    if text != previous {
                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            let _ = channel.send(value);
                            previous = text;
                        }
                    }
                }
            };
            loop {
                forward();
                match stopped.recv_timeout(Duration::from_millis(100)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => (),
                    _ => { forward(); break; }
                }
            }
        });
        // output() drains both child pipes concurrently; progress never consumes stdout.
        let result = command.output();
        drop(stop);
        result
    })
}

fn add_strokes(value: &mut Value, directory: &Path, options: &ImportOptions) -> Result<(), String> {
    value["strokes"] = json!([]);
    if value.get("error").is_some() {
        return Ok(());
    }
    let svg = value["svg"].as_str().ok_or("识别结果缺少 SVG")?;
    if svg.len() > 8 * 1024 * 1024 {
        return Err("单字 SVG 超过 8 MiB，请缩小切字范围".into());
    }
    let file = directory.join("glyph.svg");
    fs::write(&file, svg).map_err(|e| e.to_string())?;
    match import::import_file(&file, options) {
        Ok(mut doc) => {
            let scale = 1000. / doc.width_mm;
            for point in doc.strokes.iter_mut().flatten() {
                point.x *= scale;
                point.y *= scale;
            }
            value["strokes"] = serde_json::to_value(doc.strokes).map_err(|e| e.to_string())?;
        }
        Err(error) => {
            value["error"] = json!(format!("拟合曲线不可用：{error}"));
            value["needs_review"] = json!(true);
        }
    }
    Ok(())
}

fn run(path: String, options: ImportOptions, model_dir: Option<String>, bounds: Option<[f64; 4]>, preview_only: bool) -> Result<Value, String> {
    run_with_progress(path, options, model_dir, bounds, preview_only, None)
}

fn run_with_progress(path: String, options: ImportOptions, model_dir: Option<String>, bounds: Option<[f64; 4]>, preview_only: bool, on_progress: Option<Channel<Value>>) -> Result<Value, String> {
    if preview_only {
        if !options.dpi.is_finite() || !(36. ..=1200.).contains(&options.dpi) || options.dpi.fract() != 0. || options.page == 0 {
            return Err("DPI 必须为 36 至 1200 的整数，页码从 1 开始".into());
        }
    } else {
        import::validate_raster_options(&options)?;
        if !options.tolerance_mm.is_finite() || options.tolerance_mm <= 0. || options.tolerance_mm > 1. {
            return Err("曲线误差必须大于 0 且不超过 1 mm".into());
        }
    }
    if !Path::new(&path).is_file() { return Err("请选择存在的 PDF 或图片文件".into()); }
    if !preview_only && !options.autotrace_path.is_file() { return Err("未找到 AutoTrace，请在转换参数中选择程序路径".into()); }
    if bounds.is_some_and(|b| b.iter().any(|n| !n.is_finite()) || b[0] < 0. || b[1] < 0. || b[2] <= 0. || b[3] <= 0.) {
        return Err("切字范围必须为有效的 x、y、宽、高".into());
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let directory = std::env::temp_dir().join(format!("openink-handwriting-{}-{stamp}", std::process::id()));
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let result = (|| {
        let script = import::helper("handwriting_import.py")?;
        let input = directory.join("request.json");
        let output = directory.join("result.json");
        let progress_path = directory.join("progress.json");
        let mut request = json!({"path":path,"options":options,"model_dir":model_dir,"preview_only":preview_only});
        if on_progress.is_some() { request["progress_path"] = json!(progress_path); }
        if let Some(bounds) = bounds { request["bounds"] = json!(bounds); }
        fs::write(&input, serde_json::to_vec(&request).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut command = import::python_command(&options.python_path);
        command.arg(script).arg(input).arg(&output);
        let run = output_with_progress(&mut command, &progress_path, on_progress.as_ref())
            .map_err(|e| format!("无法启动识别 Python {}：{e}", options.python_path.display()))?;
        if !run.status.success() {
            return Err(format!("{}：{}", if preview_only { "页面预览失败" } else { "手写识别 / 拟合失败" }, String::from_utf8_lossy(&run.stderr)));
        }
        if fs::metadata(&output).map_err(|e| e.to_string())?.len() > 128 * 1024 * 1024 {
            return Err("页面处理结果超过 128 MiB，请降低 DPI 或裁剪素材".into());
        }
        let mut value: Value = serde_json::from_slice(&fs::read(output).map_err(|e| e.to_string())?).map_err(|e| format!("识别结果格式错误：{e}"))?;
        if preview_only {
            return Ok(value);
        } else if bounds.is_some() {
            add_strokes(&mut value, &directory, &options)?;
        } else {
            let candidates = value["candidates"].as_array_mut().ok_or("识别结果缺少候选字符")?;
            if candidates.len() > 1000 { return Err("单页超过 1000 个候选，请分批导入".into()); }
            let total = candidates.len();
            progress(on_progress.as_ref(), "curves", 0, total);
            for (index, candidate) in candidates.iter_mut().enumerate() {
                add_strokes(candidate, &directory, &options)?;
                progress(on_progress.as_ref(), "curves", index + 1, total);
            }
            candidates.sort_by_key(|v| !v["needs_review"].as_bool().unwrap_or(true));
            progress(on_progress.as_ref(), "done", total, total);
        }
        Ok(value)
    })();
    let _ = fs::remove_dir_all(directory);
    result
}

#[tauri::command(rename_all = "snake_case")]
pub async fn inkfont_recognize(path: String, options: ImportOptions, model_dir: Option<String>, on_progress: Option<tauri::ipc::JavaScriptChannelId>, webview: tauri::Webview) -> Result<Value, String> {
    let on_progress = on_progress.map(|id| id.channel_on(webview));
    tauri::async_runtime::spawn_blocking(move || run_with_progress(path, options, model_dir, None, false, on_progress)).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn inkfont_refit(path: String, options: ImportOptions, bounds: [f64; 4]) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run(path, options, None, Some(bounds), false)).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn inkfont_preview_page(path: String, options: ImportOptions) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run(path, options, None, None, true)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_monitor_exits_when_child_cannot_start() {
        let path = std::env::temp_dir().join(format!("openink-progress-test-{}.json", std::process::id()));
        fs::write(&path, r#"{"stage":"rasterize","done":0,"total":1}"#).unwrap();
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = events.clone();
        let channel = Channel::<Value>::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                recorded.lock().unwrap().push(serde_json::from_str::<Value>(&text).unwrap());
            }
            Ok(())
        });
        let result = output_with_progress(&mut Command::new("openink-nonexistent-progress-test-program"), &path, Some(&channel));
        assert!(result.is_err());
        assert_eq!(events.lock().unwrap().len(), 1);
        fs::remove_file(path).unwrap();
    }
    #[test]
    #[ignore = "Requires OPENINK_TEST_HANDWRITING_SAMPLE and bundled OCR runtime; no hardware access"]
    fn real_handwriting_package_roundtrip() {
        let sample = std::env::var("OPENINK_TEST_HANDWRITING_SAMPLE").unwrap();
        let output = std::env::var("OPENINK_TEST_OUTPUT").unwrap();
        let mut preview_options = ImportOptions::default();
        preview_options.autotrace_path = "missing-autotrace.exe".into();
        let preview = run(sample.clone(), preview_options, None, None, true).unwrap();
        assert!(preview["page_count"].as_u64().unwrap() >= 1);
        assert!(preview["image_data_url"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert!(preview.get("candidates").is_none());
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = events.clone();
        let channel = Channel::<Value>::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                recorded.lock().unwrap().push(serde_json::from_str::<Value>(&text).unwrap());
            }
            Ok(())
        });
        let result = run_with_progress(sample, ImportOptions::default(), None, None, false, Some(channel)).unwrap();
        let candidates = result["candidates"].as_array().unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.last().unwrap(), &json!({"stage":"done","done":candidates.len(),"total":candidates.len()}));
        let curves: Vec<_> = events.iter().filter(|event| event["stage"] == "curves").collect();
        assert_eq!(curves.len(), candidates.len() + 1);
        for (done, event) in curves.iter().enumerate() { assert_eq!(event["done"], done); }
        let source = candidates.iter().find(|v| v["character"] == "见" && v.get("error").is_none()).unwrap();
        let first: crate::inkfont::InkVariant = serde_json::from_value(source.clone()).unwrap();
        assert!(!first.strokes.is_empty());
        tauri::async_runtime::block_on(async {
            let package = crate::inkfont::InkPackage { format:"openink-font".into(), version:1, id:String::new(), name:"离线集成测试".into(), revision:0, variants:vec![first.clone()] };
            let saved = crate::inkfont::inkfont_save(package).await.unwrap();
            let mut latest = crate::inkfont::inkfont_load(saved.id.clone()).unwrap();
            let mut second = first.clone(); second.id = "second-writing".into();
            second.strokes[0][0].x += 0.01;
            latest.variants.push(second);
            let saved = crate::inkfont::inkfont_save(latest).await.unwrap();
            crate::inkfont::inkfont_export(saved.id.clone(), output.clone()).await.unwrap();
            let imported = crate::inkfont::inkfont_import(output.clone()).await.unwrap();
            assert_eq!(imported.variants.len(), 2);
            assert_ne!(imported.id, saved.id);
            let document = crate::commands::glyph_font_document(output, "见见见".into(), 10., 1., 1, 210., 297., None).await.unwrap();
            assert_eq!(document.strokes.len(), first.strokes.len() * 3);
            assert!(document.strokes.iter().flatten().all(|p| p.x.is_finite() && p.y.is_finite()));
            crate::inkfont::inkfont_delete(saved.id, saved.revision).unwrap();
            crate::inkfont::inkfont_delete(imported.id, imported.revision).unwrap();
        });
    }
    #[test]
    fn rejects_invalid_input_before_spawning_python() {
        let mut options = ImportOptions::default();
        options.dpi = f64::NAN;
        assert!(run("missing.pdf".into(), options, None, None, false).unwrap_err().contains("DPI"));
        let mut options = ImportOptions::default();
        options.tolerance_mm = 0.;
        assert!(run("missing.pdf".into(), options, None, None, false).unwrap_err().contains("曲线误差"));
        let mut options = ImportOptions::default();
        options.page = 0;
        assert!(run("missing.pdf".into(), options, None, None, true).unwrap_err().contains("页码"));
    }
    #[test]
    fn parsed_svg_keeps_normalized_coordinates() {
        let directory = std::env::temp_dir().join(format!("inkfont-strokes-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let mut value = json!({"svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1000\" height=\"1000\"><path fill=\"none\" stroke=\"black\" d=\"M100 200L900 800\"/></svg>"});
        add_strokes(&mut value, &directory, &ImportOptions::default()).unwrap();
        let x = value["strokes"][0][0]["x"].as_f64().unwrap();
        assert!((x - 100.).abs() < 0.001);
        fs::remove_dir_all(directory).unwrap();
    }
}
