use std::path::Path;

#[derive(serde::Serialize)]
pub struct ClipboardFile {
    path: String,
    name: String,
    size: u64,
}

fn supported(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|ext|
        ["svg", "pdf", "png", "jpg", "jpeg", "json"].contains(&ext.to_ascii_lowercase().as_str()))
}

#[cfg(windows)]
fn file_paths() -> Result<Vec<String>, String> {
    use std::{ffi::c_void, os::windows::ffi::OsStringExt};
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(window: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn GetClipboardData(format: u32) -> *mut c_void;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(drop: *mut c_void, index: u32, path: *mut u16, count: u32) -> u32;
    }
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) { unsafe { CloseClipboard(); } }
    }
    unsafe {
        const CF_HDROP: u32 = 15;
        if IsClipboardFormatAvailable(CF_HDROP) == 0 { return Ok(vec![]); }
        if OpenClipboard(std::ptr::null_mut()) == 0 { return Err("剪贴板正被其他程序使用，请稍后重试".into()); }
        let _guard = ClipboardGuard;
        let drop = GetClipboardData(CF_HDROP);
        if drop.is_null() { return Ok(vec![]); }
        let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
        let mut paths = Vec::new();
        for index in 0..count.min(100) {
            let len = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
            if len == 0 || len > 32767 { continue; }
            let mut buffer = vec![0u16; len as usize + 1];
            let copied = DragQueryFileW(drop, index, buffer.as_mut_ptr(), len + 1);
            if copied == len {
                paths.push(std::ffi::OsString::from_wide(&buffer[..len as usize]).to_string_lossy().into_owned());
            }
        }
        Ok(paths)
    }
}
#[cfg(not(windows))]
fn file_paths() -> Result<Vec<String>, String> { Ok(vec![]) }

#[cfg(windows)]
fn image_path() -> Result<Option<String>, String> {
    use std::os::windows::process::CommandExt;
    #[link(name = "user32")]
    extern "system" { fn IsClipboardFormatAvailable(format: u32) -> i32; }
    if unsafe { IsClipboardFormatAvailable(8) == 0 && IsClipboardFormatAvailable(2) == 0 } { return Ok(None); }
    let directory = std::env::temp_dir().join("openink-clipboard");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let path = directory.join(format!("image-{}-{stamp}.png", std::process::id()));
    // Windows Forms handles clipboard DIB formats on an STA thread; never alters the clipboard.
    let result = std::process::Command::new("powershell.exe")
        .creation_flags(0x08000000)
        .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $image=[System.Windows.Forms.Clipboard]::GetImage(); if ($null -ne $image) { try { $image.Save($env:OPENINK_CLIPBOARD_IMAGE,[System.Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() } }"])
        .env("OPENINK_CLIPBOARD_IMAGE", &path)
        .output().map_err(|e| e.to_string())?;
    if !result.status.success() { return Err("无法读取剪贴板图片，请重新复制后再试".into()); }
    Ok(path.is_file().then(|| path.to_string_lossy().into_owned()))
}
#[cfg(not(windows))]
fn image_path() -> Result<Option<String>, String> { Ok(None) }

#[tauri::command]
pub async fn clipboard_files() -> Result<Vec<ClipboardFile>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut files: Vec<_> = file_paths()?.into_iter().filter_map(|path| {
            let p = Path::new(&path);
            if !supported(p) { return None; }
            let metadata = p.metadata().ok()?;
            if !metadata.is_file() { return None; }
            Some(ClipboardFile { name: p.file_name()?.to_string_lossy().into_owned(), size: metadata.len(), path })
        }).collect();
        if files.is_empty() {
            if let Some(path) = image_path()? {
                let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
                files.push(ClipboardFile { path, name: "剪贴板图片.png".into(), size });
            }
        }
        Ok(files)
    }).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct FilePreview {
    data_url: Option<String>,
    document: Option<crate::model::Document>,
}

#[tauri::command]
pub async fn clipboard_file_preview(path: String) -> Result<FilePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&path);
        if !supported(path) { return Err("不支持此文件类型".into()); }
        let meta = path.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() > 20 * 1024 * 1024 { return Err("文件过大或不可用，可直接导入查看".into()); }
        let ext = path.extension().unwrap().to_string_lossy().to_ascii_lowercase();
        if ext == "svg" || ext == "json" {
            let document = crate::import::import_file(path, &Default::default())?;
            if document.strokes.iter().map(Vec::len).sum::<usize>() > 100_000 { return Err("路径较多，请导入后查看".into()); }
            Ok(FilePreview { data_url: None, document: Some(document) })
        } else {
            Ok(FilePreview { data_url: Some(crate::import::file_thumbnail(path)?), document: None })
        }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_importable_extensions() {
        for name in ["图形.SVG", "scan.PDF", "a.png", "b.jpg", "c.jpeg", "paths.json"] { assert!(supported(Path::new(name))); }
        for name in ["a.exe", "a.svg.exe", "folder", "font.ttf", "a.txt"] { assert!(!supported(Path::new(name))); }
    }
    #[test]
    #[ignore = "Requires an image already on the Windows clipboard; never changes clipboard contents"]
    fn actual_clipboard_image_snapshot_and_thumbnail() {
        let path = image_path().unwrap().expect("Copy an image before running this check");
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(crate::import::file_thumbnail(Path::new(&path)).unwrap().starts_with("data:image/png;base64,"));
        std::fs::remove_file(path).unwrap();
    }
}
