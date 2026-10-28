//! Isolated paper processing: no device access and no original-file writes.
use crate::{import, project::Background};
use std::{fs::{self, File}, io::Read, path::Path, process::Stdio, time::{Duration, Instant}};

pub fn prepare(path: &Path, page: usize, width: f64, height: f64, corners: Option<[[f64; 2]; 4]>, remove_shadow: bool, process: bool, python: Option<String>) -> Result<Background, String> {
    if page == 0 || !width.is_finite() || !height.is_finite() || !(1.0..=210.).contains(&width) || !(1.0..=297.).contains(&height) {
        return Err("纸张页码或尺寸无效".into());
    }
    if corners.is_some_and(|p| !p.iter().flatten().all(|v| v.is_finite() && (0.0..=1.).contains(v))) {
        return Err("纸张四角坐标无效".into());
    }
    let directory = std::env::temp_dir().join(format!("openink-paper-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let result = (|| {
        let executable = python.map(Into::into).unwrap_or_else(import::default_python);
        let mut command = import::python_command(&executable);
        command.arg(import::helper("paper_background.py")?).arg(path).arg(directory.join("background.png"))
            .args(["--page", &page.to_string(), "--width", &width.to_string(), "--height", &height.to_string()]);
        if let Some(points) = corners { command.arg("--corners").arg(serde_json::to_string(&points).map_err(|e| e.to_string())?); }
        if remove_shadow { command.arg("--remove-shadow"); }
        if process { command.arg("--process"); }
        let output = directory.join("result.json"); let errors = directory.join("error.txt");
        command.stdout(Stdio::from(File::create(&output).map_err(|e| e.to_string())?));
        command.stderr(Stdio::from(File::create(&errors).map_err(|e| e.to_string())?));
        let mut child = command.spawn().map_err(|e| format!("无法启动背景处理 Python：{e}"))?;
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() < Duration::from_secs(60) => std::thread::sleep(Duration::from_millis(50)),
                Ok(None) => { let _ = child.kill(); let _ = child.wait(); return Err("背景处理超过 60 秒，请缩小图片后重试".into()); }
                Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error.to_string()); }
            }
        };
        if !status.success() {
            let mut message = String::new(); File::open(errors).map_err(|e| e.to_string())?.take(16 * 1024).read_to_string(&mut message).map_err(|e| e.to_string())?;
            return Err(format!("纸张背景处理失败（需要 Pillow、NumPy、OpenCV，PDF 还需要 PyMuPDF）：{message}"));
        }
        if fs::metadata(&output).map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 { return Err("背景处理结果过大".into()); }
        let background: Background = serde_json::from_slice(&fs::read(output).map_err(|e| e.to_string())?).map_err(|e| format!("背景处理结果无效：{e}"))?;
        background.validate(width, height)?;
        Ok(background)
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&directory); }
    result
}

#[tauri::command(rename_all = "snake_case")]
pub async fn paper_background(path: String, page: usize, width_mm: f64, height_mm: f64, corners: Option<[[f64; 2]; 4]>, remove_shadow: bool, process: bool, python_path: Option<String>) -> Result<Background, String> {
    tauri::async_runtime::spawn_blocking(move || prepare(Path::new(&path), page, width_mm, height_mm, corners, remove_shadow, process, python_path)).await.map_err(|e| e.to_string())?
}
