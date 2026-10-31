//! Local geometry import. No serial connection or machine commands.
use crate::model::{cubic, Document, Point, Stroke};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ImportOptions {
    pub page: usize,
    pub dpi: f64,
    pub threshold: u8,
    pub conservative: bool,
    pub autotrace_path: PathBuf,
    pub python_path: PathBuf,
    pub tolerance_mm: f64,
    pub filter_iterations: u32,
    pub error_threshold: f64,
    pub line_threshold: f64,
    pub despeckle_level: u32,
}
impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            page: 1,
            dpi: 300.,
            threshold: 180,
            conservative: false,
            autotrace_path: default_autotrace(),
            python_path: default_python(),
            tolerance_mm: 0.02,
            filter_iterations: 4,
            error_threshold: 2.,
            line_threshold: 1.,
            despeckle_level: 0,
        }
    }
}

fn runtime_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(dir) = std::env::var_os("OPENINK_RESOURCE_DIR") {
        roots.push(dir.into());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_owned());
            roots.push(dir.join("resources"));
        }
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    roots
}
pub(crate) fn helper(name: &str) -> Result<PathBuf, String> {
    runtime_roots().into_iter().map(|root|root.join("helpers").join(name)).find(|p|p.is_file())
        .ok_or_else(||format!("Missing bundled helper {name}; place helpers next to the executable or set OPENINK_RESOURCE_DIR"))
}
fn default_autotrace() -> PathBuf {
    let mut candidates = Vec::new();
    for root in runtime_roots() {
        candidates.push(root.join("autotrace.exe"));
        candidates.push(root.join("autotrace/autotrace.exe"));
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../.cache/autotrace/bin-2020/autotrace.exe"),
    );
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("autotrace.exe"))
}
pub(crate) fn default_python() -> PathBuf {
    for root in runtime_roots() {
        for relative in [
            "python/python.exe",
            "python.exe",
            "../.cache/desktop-python/Scripts/python.exe",
        ] {
            let candidate = root.join(relative);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("python")
}
pub(crate) fn python_command(python: &Path) -> Command {
    let mut command = hidden_command(python);
    let mut paths = Vec::new();
    if let Some(configured) = std::env::var_os("OPENINK_PYTHON_MODULES") {
        paths.extend(std::env::split_paths(&configured));
    }
    for root in runtime_roots() {
        for relative in [
            "python-modules",
            "deps/python",
            ".cache/pdf-review",
            "../.cache/pdf-review",
        ] {
            let candidate = root.join(relative);
            if candidate.is_dir() {
                paths.push(candidate);
            }
        }
    }
    if let Some(existing) = std::env::var_os("PYTHONPATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        command.env("PYTHONPATH", joined);
    }
    command
}
fn verify_python(python: &Path, script: &Path, pdf: bool) -> Result<(), String> {
    let code = if pdf {
        "import sys; print('Actual Python: '+sys.executable,file=sys.stderr); import PIL; import fitz"
    } else {
        "import sys; print('Actual Python: '+sys.executable,file=sys.stderr); import PIL"
    };
    let run = python_command(python)
        .args(["-c", code])
        .output()
        .map_err(|e| {
            format!(
                "Cannot launch configured Python {} for helper {}: {e}",
                python.display(),
                script.display()
            )
        })?;
    if !run.status.success() {
        return Err(format!("Python dependencies unavailable. Configured Python: {}\nHelper: {}\n{}\nInstall with that interpreter: -m pip install Pillow PyMuPDF; or set OPENINK_PYTHON_MODULES to the installed module directory.",python.display(),script.display(),String::from_utf8_lossy(&run.stderr)));
    }
    Ok(())
}
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
pub(crate) fn validate_raster_options(options: &ImportOptions) -> Result<(), String> {
    if !options.dpi.is_finite()
        || !(36. ..=1200.).contains(&options.dpi)
        || options.dpi.fract() != 0.
        || options.page == 0
    {
        return Err("DPI must be an integer from 36 to 1200; page numbers start at 1".into());
    }
    if options.filter_iterations > 20
        || options.despeckle_level > 20
        || [options.error_threshold, options.line_threshold]
            .iter()
            .any(|v| !v.is_finite() || *v <= 0. || *v > 20.)
    {
        return Err("AutoTrace filter/despeckle must be 0..20, error/line thresholds must be finite and >0..20".into());
    }
    Ok(())
}

fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}
pub fn pdf_page_count(path: &Path) -> Result<usize, String> {
    pdf_page_count_with_python(path, &default_python())
}
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct PdfBackgroundPage {
    pub data_url: String,
    pub width_mm: f64,
    pub height_mm: f64,
    pub page_count: usize,
}

pub fn pdf_background_page(path: &Path, page: usize) -> Result<PdfBackgroundPage, String> {
    if page == 0 {
        return Err("PDF page numbers start at 1".into());
    }
    let code = r#"
import base64, json, sys
import fitz
with fitz.open(sys.argv[1]) as pdf:
    if not pdf.is_pdf:
        raise ValueError('Background source must be a PDF')
    number = int(sys.argv[2])
    if not 1 <= number <= len(pdf):
        raise ValueError(f'PDF page must be 1..{len(pdf)}')
    page = pdf[number - 1]
    if page.rect.width * page.rect.height * (110 / 72) ** 2 > 50_000_000:
        raise ValueError('PDF background exceeds 50 million pixels')
    pix = page.get_pixmap(dpi=110, colorspace=fitz.csRGB, alpha=False)
    print(json.dumps(dict(data_url='data:image/png;base64,' + base64.b64encode(pix.tobytes('png')).decode('ascii'), width_mm=page.rect.width * 25.4 / 72, height_mm=page.rect.height * 25.4 / 72, page_count=len(pdf))))
"#;
    let python = default_python();
    let output = python_command(&python)
        .args(["-c", code])
        .arg(path)
        .arg(page.to_string())
        .output()
        .map_err(|e| format!("Cannot launch Python {}: {e}", python.display()))?;
    if !output.status.success() {
        return Err(format!(
            "Cannot render PDF background (PyMuPDF required): {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Invalid PDF background response: {e}"))
}

pub fn file_thumbnail(path: &Path) -> Result<String, String> {
    let code = r#"
import base64, sys, fitz
with fitz.open(sys.argv[1]) as doc:
    page = doc[0]
    scale = min(1, 480 / max(page.rect.width, page.rect.height))
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    print('data:image/png;base64,' + base64.b64encode(pix.tobytes('png')).decode('ascii'))
"#;
    let output = python_command(&default_python()).args(["-c", code]).arg(path).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err("暂时无法生成缩略图，仍可使用此文件".into()); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub fn pdf_page_count_with_python(path: &Path, python: &Path) -> Result<usize, String> {
    let cache = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.cache/pdf-review");
    let output=python_command(python).args(["-c","import sys; sys.path.append(sys.argv[2]); import fitz; d=fitz.open(sys.argv[1]); print(len(d))"]).arg(path).arg(cache).output().map_err(|e|format!("Cannot launch Python {}: {e}",python.display()))?;
    if !output.status.success() {
        return Err(format!(
            "PDF inspection needs PyMuPDF (python -m pip install PyMuPDF): {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|e| format!("Invalid PDF page count: {e}"))
}

pub fn import_file(path: &Path, options: &ImportOptions) -> Result<Document, String> {
    if !options.tolerance_mm.is_finite() || options.tolerance_mm <= 0. {
        return Err("Tolerance must be positive".into());
    }
    if path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .eq_ignore_ascii_case("json")
    {
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if value["format"] != "openink-trajectories"
            || value["version"] != 1
            || value["units"] != "mm"
        {
            return Err("Unsupported trajectory JSON format/version/units".into());
        }
        let raw: Vec<Vec<[f64; 2]>> =
            serde_json::from_value(value["strokes"].clone()).map_err(|e| e.to_string())?;
        return validate(Document {
            name: value["name"]
                .as_str()
                .unwrap_or("Imported trajectories")
                .into(),
            width_mm: value["width_mm"].as_f64().ok_or("Missing width_mm")?,
            height_mm: value["height_mm"].as_f64().ok_or("Missing height_mm")?,
            strokes: raw
                .into_iter()
                .map(|s| s.into_iter().map(|v| p(v[0], v[1])).collect())
                .collect(),
        });
    }
    if path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .eq_ignore_ascii_case("svg")
    {
        return read_svg(path, options.tolerance_mm, 25.4 / 96.);
    }
    validate_raster_options(options)?;
    if !options.autotrace_path.is_file() {
        return Err(format!(
            "AutoTrace executable not found: {}. Configure an AutoTrace installation.",
            options.autotrace_path.display()
        ));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("openink-import-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let output = dir.join("trace.svg");
    let result = (|| {
        let script = helper("trace_import.py")?;
        verify_python(
            &options.python_path,
            &script,
            path.extension()
                .and_then(|v| v.to_str())
                .is_some_and(|v| v.eq_ignore_ascii_case("pdf")),
        )?;
        let mut cmd = python_command(&options.python_path);
        cmd.arg(&script)
            .arg(path)
            .arg(&output)
            .arg("--autotrace")
            .arg(&options.autotrace_path)
            .arg("--page")
            .arg(options.page.to_string())
            .arg("--dpi")
            .arg(options.dpi.to_string())
            .arg("--threshold")
            .arg(options.threshold.to_string());
        let (filter, error, line, despeckle) = if options.conservative {
            (0, 0.5, 0.5, 0)
        } else {
            (
                options.filter_iterations,
                options.error_threshold,
                options.line_threshold,
                options.despeckle_level,
            )
        };
        cmd.arg("--filter-iterations")
            .arg(filter.to_string())
            .arg("--error-threshold")
            .arg(error.to_string())
            .arg("--line-threshold")
            .arg(line.to_string())
            .arg("--despeckle-level")
            .arg(despeckle.to_string());
        if options.conservative {
            cmd.arg("--conservative");
        }
        let run = cmd.output().map_err(|e| {
            format!(
                "Cannot launch Python {}: {e}",
                options.python_path.display()
            )
        })?;
        if !run.status.success() {
            return Err(format!(
                "Raster/AutoTrace import failed. Python: {} Helper: {}\n{}",
                options.python_path.display(),
                script.display(),
                String::from_utf8_lossy(&run.stderr)
            ));
        }
        let mut doc = read_svg(&output, options.tolerance_mm, 25.4 / options.dpi)?;
        doc.name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        Ok(doc)
    })();
    let _ = fs::remove_dir_all(dir);
    result
}

fn read_svg(path: &Path, tolerance: f64, pixel_mm: f64) -> Result<Document, String> {
    let data = fs::read(path).map_err(|e| e.to_string())?;
    let options = usvg::Options::default();
    let tree = usvg::Tree::from_data(&data, &options).map_err(|e| format!("SVG parse: {e}"))?;
    let mut strokes = Vec::new();
    fn visit(
        group: &usvg::Group,
        scale: f64,
        tol: f64,
        out: &mut Vec<Stroke>,
    ) -> Result<(), String> {
        if group.opacity().get() < 1. {
            return Err("SVG transparent groups require conversion to explicit visible paths before plotting".into());
        }
        if group.clip_path().is_some() || group.mask().is_some() || !group.filters().is_empty() {
            return Err(
                "SVG clipping/masks/filters require flattening to explicit paths before plotting"
                    .into(),
            );
        }
        for node in group.children() {
            match node {
                usvg::Node::Group(g) => visit(g, scale, tol, out)?,
                usvg::Node::Path(path) => {
                    if !path.is_visible() {
                        continue;
                    }
                    if path.fill().is_none() && path.stroke().is_none() {
                        continue;
                    }
                    if path.fill().is_some_and(|paint| paint.opacity().get() < 1.)
                        || path
                            .stroke()
                            .is_some_and(|paint| paint.opacity().get() < 1.)
                    {
                        return Err("SVG transparent paint requires conversion to explicit visible paths before plotting".into());
                    }
                    if path
                        .fill()
                        .is_some_and(|paint| !matches!(paint.paint(), usvg::Paint::Color(_)))
                        || path
                            .stroke()
                            .is_some_and(|paint| !matches!(paint.paint(), usvg::Paint::Color(_)))
                    {
                        return Err("SVG gradients and patterns require conversion to explicit visible paths before plotting".into());
                    }
                    let transform = path.abs_transform();
                    let convert = |x: f32, y: f32| {
                        let mut q = usvg::tiny_skia_path::Point::from_xy(x, y);
                        transform.map_point(&mut q);
                        p(q.x as f64 * scale, q.y as f64 * scale)
                    };
                    let mut line = Vec::new();
                    for segment in path.data().segments() {
                        use usvg::tiny_skia_path::PathSegment::*;
                        match segment {
                            MoveTo(q) => {
                                if line.len() > 1 {
                                    out.push(std::mem::take(&mut line));
                                } else {
                                    line.clear();
                                }
                                line.push(convert(q.x, q.y));
                            }
                            LineTo(q) => line.push(convert(q.x, q.y)),
                            QuadTo(b, d) => {
                                let a = line.last().ok_or("Invalid SVG quadratic")?.clone();
                                let b = convert(b.x, b.y);
                                let d = convert(d.x, d.y);
                                let c1 =
                                    p(a.x + (b.x - a.x) * 2. / 3., a.y + (b.y - a.y) * 2. / 3.);
                                let c2 =
                                    p(d.x + (b.x - d.x) * 2. / 3., d.y + (b.y - d.y) * 2. / 3.);
                                cubic(&mut line, a, c1, c2, d, tol, 0)?;
                            }
                            CubicTo(b, c, d) => {
                                let a = line.last().ok_or("Invalid SVG cubic")?.clone();
                                cubic(
                                    &mut line,
                                    a,
                                    convert(b.x, b.y),
                                    convert(c.x, c.y),
                                    convert(d.x, d.y),
                                    tol,
                                    0,
                                )?;
                            }
                            Close => {
                                if let Some(first) = line.first().cloned() {
                                    line.push(first);
                                }
                            }
                        }
                    }
                    if line.len() > 1 {
                        out.push(line)
                    }
                }
                usvg::Node::Text(_) => {
                    return Err("SVG text must be converted to paths before import".into())
                }
                usvg::Node::Image(_) => return Err(
                    "SVG contains raster images; import the image directly for centerline tracing"
                        .into(),
                ),
            }
        }
        Ok(())
    }
    visit(tree.root(), pixel_mm, tolerance, &mut strokes)?;
    validate(Document {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        width_mm: tree.size().width() as f64 * pixel_mm,
        height_mm: tree.size().height() as f64 * pixel_mm,
        strokes,
    })
}
pub(crate) fn validate(doc: Document) -> Result<Document, String> {
    if !doc.width_mm.is_finite()
        || !doc.height_mm.is_finite()
        || doc.width_mm <= 0.
        || doc.height_mm <= 0.
    {
        return Err("Document dimensions must be finite and positive".into());
    }
    if doc.strokes.is_empty() {
        return Err("No drawable paths found".into());
    }
    if doc.strokes.iter().map(Vec::len).sum::<usize>() > 2_000_000 {
        return Err("Document exceeds two million points".into());
    }
    if doc
        .strokes
        .iter()
        .flatten()
        .any(|p| !p.x.is_finite() || !p.y.is_finite())
    {
        return Err("Non-finite geometry".into());
    }
    Ok(doc)
}

pub fn export_svg(doc: &Document, path: &Path) -> Result<(), String> {
    fs::write(path, svg_string(doc)).map_err(|e| e.to_string())
}
pub(crate) fn svg_string(doc: &Document) -> String {
    let mut s=format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}mm\" height=\"{}mm\" viewBox=\"0 0 {} {}\"><g fill=\"none\" stroke=\"black\" stroke-width=\"0.2\">",doc.width_mm,doc.height_mm,doc.width_mm,doc.height_mm);
    for stroke in &doc.strokes {
        s.push_str("<path d=\"");
        for (i, p) in stroke.iter().enumerate() {
            s.push_str(&format!(
                "{}{} {} ",
                if i == 0 { "M" } else { "L" },
                p.x,
                p.y
            ));
        }
        s.push_str("\"/>");
    }
    s.push_str("</g></svg>");
    s
}
pub fn export_json(doc: &Document, path: &Path) -> Result<(), String> {
    let strokes: Vec<_> = doc
        .strokes
        .iter()
        .map(|s| s.iter().map(|p| [p.x, p.y]).collect::<Vec<_>>())
        .collect();
    let data = serde_json::json!({"format":"openink-trajectories","version":1,"units":"mm","name":doc.name,"width_mm":doc.width_mm,"height_mm":doc.height_mm,"strokes":strokes,"note":"Local reusable trajectories; no inferred character mapping or original stroke order"});
    fs::write(
        path,
        serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn font_text(path: &Path, text: &str, size_mm: f64) -> Result<Document, String> {
    if !size_mm.is_finite() || size_mm <= 0. {
        return Err("Font size must be positive".into());
    }
    let data = fs::read(path).map_err(|e| e.to_string())?;
    let face = ttf_parser::Face::parse(&data, 0).map_err(|e| format!("Font parse: {e:?}"))?;
    struct Builder {
        strokes: Vec<Stroke>,
        line: Stroke,
        scale: f64,
        x: f64,
        y: f64,
        error: Option<String>,
    }
    impl Builder {
        fn point(&self, x: f32, y: f32) -> Point {
            p(
                self.x + x as f64 * self.scale,
                self.y - y as f64 * self.scale,
            )
        }
        fn flush(&mut self) {
            if self.line.len() > 1 {
                self.strokes.push(std::mem::take(&mut self.line));
            } else {
                self.line.clear();
            }
        }
    }
    impl ttf_parser::OutlineBuilder for Builder {
        fn move_to(&mut self, x: f32, y: f32) {
            self.flush();
            self.line.push(self.point(x, y));
        }
        fn line_to(&mut self, x: f32, y: f32) {
            self.line.push(self.point(x, y));
        }
        fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
            let a = self.line.last().unwrap().clone();
            let b = self.point(x1, y1);
            let d = self.point(x, y);
            let c1 = p(a.x + (b.x - a.x) * 2. / 3., a.y + (b.y - a.y) * 2. / 3.);
            let c2 = p(d.x + (b.x - d.x) * 2. / 3., d.y + (b.y - d.y) * 2. / 3.);
            if let Err(e) = cubic(&mut self.line, a, c1, c2, d, 0.02, 0) {
                self.error = Some(e)
            }
        }
        fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
            let a = self.line.last().unwrap().clone();
            let b = self.point(x1, y1);
            let c = self.point(x2, y2);
            let d = self.point(x, y);
            if let Err(e) = cubic(&mut self.line, a, b, c, d, 0.02, 0) {
                self.error = Some(e)
            }
        }
        fn close(&mut self) {
            if let Some(a) = self.line.first().cloned() {
                self.line.push(a)
            }
            self.flush();
        }
    }
    let scale = size_mm / face.units_per_em() as f64;
    let mut b = Builder {
        strokes: vec![],
        line: vec![],
        scale,
        x: 0.,
        y: size_mm,
        error: None,
    };
    let mut width: f64 = 0.;
    for ch in text.chars() {
        if ch == '\n' {
            width = width.max(b.x);
            b.x = 0.;
            b.y += size_mm * 1.3;
            continue;
        }
        let id = face
            .glyph_index(ch)
            .ok_or_else(|| format!("Font lacks character {ch} (U+{:04X})", ch as u32))?;
        if !ch.is_whitespace() && face.outline_glyph(id, &mut b).is_none() {
            return Err(format!(
                "No outline for {ch}; bitmap/color fonts unsupported"
            ));
        }
        b.flush();
        b.x += face.glyph_hor_advance(id).unwrap_or(face.units_per_em()) as f64 * scale;
    }
    if let Some(e) = b.error {
        return Err(e);
    }
    validate(Document {
        name: format!(
            "{} — outline text",
            path.file_name().unwrap_or_default().to_string_lossy()
        ),
        width_mm: width.max(b.x),
        height_mm: b.y + size_mm * 0.3,
        strokes: b.strokes,
    })
}

pub fn font_text_centerline(
    path: &Path,
    text: &str,
    size_mm: f64,
    options: &ImportOptions,
) -> Result<Document, String> {
    font_centerline(path, text, size_mm, options, false)
}

pub(crate) fn font_centerline(
    path: &Path, text: &str, size_mm: f64, options: &ImportOptions, baseline: bool,
) -> Result<Document, String> {
    validate_raster_options(options)?;
    // Validate coverage first: rasterizers otherwise silently draw replacement boxes.
    let _ = font_text(path, text, size_mm)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("openink-font-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let result = (|| {
        let input = dir.join("text.txt");
        let image = dir.join("text.png");
        fs::write(&input, text).map_err(|e| e.to_string())?;
        let script = helper("render_font.py")?;
        verify_python(&options.python_path, &script, false)?;
        let output = python_command(&options.python_path)
            .arg(script)
            .arg(path)
            .arg(input)
            .arg(&image)
            .arg(size_mm.to_string())
            .arg(options.dpi.to_string())
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "Font rasterization failed (Pillow required): {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let mut local = options.clone();
        local.page = 1;
        let mut doc = import_file(&image, &local)?;
        if baseline {
            let metrics: serde_json::Value = serde_json::from_slice(&fs::read(image.with_extension("json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let metric = |name: &str| metrics[name].as_f64().filter(|v| v.is_finite()).ok_or_else(|| format!("Missing font metric {name}"));
            let pixel_mm = 25.4 / options.dpi;
            let origin_x = metric("origin_x")? * pixel_mm;
            let origin_y = metric("baseline_y")? * pixel_mm;
            for p in doc.strokes.iter_mut().flatten() { p.x -= origin_x; p.y -= origin_y; }
            doc.width_mm = metric("advance")? * pixel_mm;
        }
        doc.name = format!(
            "{} — AutoTrace centerline text",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
        Ok(doc)
    })();
    let _ = fs::remove_dir_all(dir);
    result
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ComparisonVariant {
    pub label: String,
    pub source: String,
    pub page: usize,
    pub options: ImportOptions,
    pub document: Document,
}
/// Compare the selected current file/page; every result contains its own real
/// geometry and effective parameters. No historical SVG/sample is consulted.
pub fn preview_variants(
    path: &Path,
    options: &ImportOptions,
) -> Result<Vec<ComparisonVariant>, String> {
    validate_raster_options(options)?;
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ["svg", "json", "ttf", "otf"].contains(&extension.as_str()) {
        return Err("Fitting comparison requires the selected PDF or raster image".into());
    }
    let source = fs::canonicalize(path)
        .map_err(|e| format!("Cannot open comparison source {}: {e}", path.display()))?;
    let mut baseline = options.clone();
    baseline.conservative = false;
    baseline.filter_iterations = 4;
    baseline.error_threshold = 2.;
    baseline.line_threshold = 1.;
    baseline.despeckle_level = 0;
    let mut t128 = baseline.clone();
    t128.threshold = 128;
    let mut t180 = baseline.clone();
    t180.threshold = 180;
    let mut conservative = t180.clone();
    conservative.conservative = true;
    conservative.filter_iterations = 0;
    conservative.error_threshold = 0.5;
    conservative.line_threshold = 0.5;
    let mut current = options.clone();
    if current.conservative {
        current.filter_iterations = 0;
        current.error_threshold = 0.5;
        current.line_threshold = 0.5;
        current.despeckle_level = 0;
    }
    let mut variants = Vec::new();
    for (label, effective) in [
        ("128 / default fitting", t128),
        ("180 / default fitting", t180),
        ("180 / conservative fitting", conservative),
        ("Current custom parameters", current),
    ] {
        let document = import_file(&source, &effective).map_err(|e| {
            format!(
                "Comparison {label}, source {}, page {}: {e}",
                source.display(),
                effective.page
            )
        })?;
        variants.push(ComparisonVariant {
            label: label.into(),
            source: source.to_string_lossy().into_owned(),
            page: effective.page,
            options: effective,
            document,
        });
    }
    Ok(variants)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pdf_background_rejects_zero_before_launching_python() {
        assert!(pdf_background_page(Path::new("missing.pdf"), 0)
            .unwrap_err()
            .contains("start at 1"));
    }

    #[test]
    #[ignore = "Requires repository PDF and local PyMuPDF; no machine IO"]
    fn actual_pdf_background_pages_and_bounds() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../inko-inko.pdf");
        let first = pdf_background_page(&source, 1).unwrap();
        let second = pdf_background_page(&source, 2).unwrap();
        assert_eq!(first.page_count, 3);
        assert!((first.width_mm - 210.).abs() < 0.2);
        assert!((first.height_mm - 297.).abs() < 0.2);
        assert!(first.data_url.starts_with("data:image/png;base64,iVBORw0KGgo"));
        assert_ne!(first.data_url, second.data_url);
        assert!(pdf_background_page(&source, 4).unwrap_err().contains("1..3"));
        assert!(pdf_background_page(&source.with_file_name("missing.pdf"), 1).is_err());
    }

    #[test]
    fn loop_curve_is_not_lost() {
        let mut points = vec![p(0., 0.)];
        cubic(
            &mut points,
            p(0., 0.),
            p(10., 20.),
            p(-10., 20.),
            p(0., 0.),
            0.02,
            0,
        )
        .unwrap();
        assert!(points.len() > 20);
        assert!(points.iter().any(|q| q.y > 14.));
    }
    #[test]
    fn degenerate_curve_terminates() {
        let mut points = vec![];
        cubic(
            &mut points,
            p(1., 1.),
            p(1., 1.),
            p(1., 1.),
            p(1., 1.),
            0.02,
            0,
        )
        .unwrap();
        assert_eq!(points.len(), 1);
    }
    #[test]
    fn svg_units_transforms_arcs_and_subpaths() {
        let file = std::env::temp_dir().join(format!("openink-svg-test-{}.svg", std::process::id()));
        fs::write(&file,r#"<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 20 10"><g transform="translate(2 1)"><path fill="none" stroke="black" d="M0 0 Q3 6 6 0 A2 2 0 0 1 10 0 M12 0h2v2z"/></g></svg>"#).unwrap();
        let doc = read_svg(&file, 0.02, 25.4 / 96.).unwrap();
        let _ = fs::remove_file(file);
        assert!((doc.width_mm - 20.).abs() < 0.001);
        assert_eq!(doc.strokes.len(), 2);
        assert!((doc.strokes[0][0].x - 2.).abs() < 0.001);
        assert!(doc.strokes[0].len() > 10);
    }
    #[test]
    fn autotrace_guard_border_preserves_original_mm_coordinates() {
        let file = std::env::temp_dir().join(format!("openink-border-test-{}.svg", std::process::id()));
        fs::write(&file, r#"<svg width="64" height="48" viewBox="2 2 64 48"><path fill="none" stroke="black" d="M2 49L12 49"/></svg>"#).unwrap();
        let pixel_mm = 25.4 / 300.;
        let doc = read_svg(&file, 0.02, pixel_mm).unwrap();
        let _ = fs::remove_file(file);
        assert!((doc.width_mm - 64. * pixel_mm).abs() < 1e-6);
        assert!((doc.height_mm - 48. * pixel_mm).abs() < 1e-6);
        assert_eq!(doc.strokes.len(), 1);
        assert!(doc.strokes[0][0].x.abs() < 1e-6);
        assert!((doc.strokes[0][0].y - 47. * pixel_mm).abs() < 1e-6);
        assert!((doc.strokes[0][1].x - 10. * pixel_mm).abs() < 1e-6);
    }
    #[test]
    fn repository_svg_fixtures() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        for relative in [
            "docs/samples/svg/gong-shi-xi.svg",
            "docs/samples/autotrace/raw-t180.svg",
        ] {
            let path = root.join(relative);
            if path.exists() {
                let doc = read_svg(&path, 0.02, 25.4 / 96.).unwrap();
                assert!(!doc.strokes.is_empty());
            }
        }
    }
    #[test]
    fn ordinary_system_font_and_missing_glyph() {
        let path = Path::new("C:/Windows/Fonts/arial.ttf");
        if !path.exists() {
            return;
        }
        let doc = font_text(path, "Hello", 12.).unwrap();
        assert!(doc.strokes.len() > 5);
        assert!(font_text(path, "\u{10ffff}", 12.)
            .unwrap_err()
            .contains("lacks character"));
        let file =
            std::env::temp_dir().join(format!("openink-font-test-{}.svg", std::process::id()));
        export_svg(&doc, &file).unwrap();
        let reread = read_svg(&file, 0.02, 25.4 / 96.).unwrap();
        let _ = fs::remove_file(file);
        assert_eq!(doc.strokes.len(), reread.strokes.len());
    }
    #[test]
    fn open_json_roundtrip_and_version_guard() {
        let path =
            std::env::temp_dir().join(format!("openink-json-test-{}.json", std::process::id()));
        let doc = Document {
            name: "Reusable glyph candidate".into(),
            width_mm: 20.,
            height_mm: 10.,
            strokes: vec![vec![p(1., 2.), p(3., 4.)]],
        };
        export_json(&doc, &path).unwrap();
        let loaded = import_file(&path, &ImportOptions::default()).unwrap();
        assert_eq!(loaded.strokes, doc.strokes);
        assert_eq!(loaded.width_mm, 20.);
        fs::write(
            &path,
            r#"{"format":"openink-trajectories","version":99,"units":"mm"}"#,
        )
        .unwrap();
        assert!(import_file(&path, &ImportOptions::default()).is_err());
        let _ = fs::remove_file(path);
    }
    #[test]
    fn fractional_dpi_is_rejected() {
        let mut options = ImportOptions::default();
        options.dpi = 299.5;
        assert!(validate_raster_options(&options).is_err());
    }
    #[test]
    fn fitting_parameters_are_validated() {
        let default = ImportOptions::default();
        assert!(validate_raster_options(&default).is_ok());
        let mut o = default.clone();
        o.filter_iterations = 21;
        assert!(validate_raster_options(&o).is_err());
        let mut o = default.clone();
        o.error_threshold = f64::NAN;
        assert!(validate_raster_options(&o).is_err());
        let mut o = default.clone();
        o.line_threshold = 0.;
        assert!(validate_raster_options(&o).is_err());
        let mut o = default;
        o.despeckle_level = 21;
        assert!(validate_raster_options(&o).is_err());
    }
    #[test]
    fn svg_hidden_groups_are_never_written() {
        let file =
            std::env::temp_dir().join(format!("openink-hidden-test-{}.svg", std::process::id()));
        for style in [
            "opacity:0",
            "opacity:0.5",
            "visibility:hidden",
            "display:none",
        ] {
            fs::write(&file,format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><g style="{style}"><path fill="none" stroke="black" d="M0 0 L10 10"/></g></svg>"#)).unwrap();
            assert!(
                read_svg(&file, 0.02, 25.4 / 96.).is_err(),
                "Hidden geometry must not become a job: {style}"
            );
        }
        let _ = fs::remove_file(file);
    }
    #[test]
    #[ignore = "Requires local Python dependencies, AutoTrace and repository PDF; offline conversion only"]
    fn actual_pdf_centerline_pipeline() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../inko-inko.pdf");
        let mut options = ImportOptions::default();
        assert_eq!(
            pdf_page_count_with_python(&source, &options.python_path).unwrap(),
            3
        );
        for (page, conservative) in [(1, false), (2, true)] {
            options.page = page;
            options.conservative = conservative;
            let doc = import_file(&source, &options).unwrap();
            assert!(doc.strokes.len() > 100);
            assert!((doc.width_mm - 210.).abs() < 0.2);
            assert!((doc.height_mm - 297.).abs() < 0.2);
            // Editing an A4 PDF to the fixed-origin writable area must produce
            // an executable canvas job, without weakening the travel guards.
            let mut fitted = doc.clone();
            let points: Vec<_> = doc.strokes.iter().flatten().collect();
            let min_x = points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
            let min_y = points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
            let max_x = points.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
            let max_y = points.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
            let scale = 183.15 / (max_x - min_x).max(max_y - min_y);
            for point in fitted.strokes.iter_mut().flatten() {
                point.x = 10. + (point.x - min_x) * scale;
                point.y = 10. + (point.y - min_y) * scale;
            }
            let job = crate::device::Job {
                document: fitted,
                feed: 1200.,
                travel_feed: 1500.,
                z_feed: 300.,
                z_down: 4.,
            };
            let commands = crate::positioning::canvas_job(&job, [0., 0.]).unwrap();
            assert!(commands.len() > 100);
            assert_eq!(commands.last().unwrap(), "G1 G90 Z0.000 F300");
            crate::positioning::check_job_travel(&job, [0., 0.], [0.; 3]).unwrap();
        }
        options.page = 4;
        assert!(import_file(&source, &options).unwrap_err().contains("1..3"));
    }
    #[test]
    #[ignore = "Uses current repository PDF, installed Python dependencies and AutoTrace"]
    fn current_pdf_comparison_contains_real_variants() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../inko-inko.pdf");
        let mut options = ImportOptions::default();
        options.page = 2;
        options.dpi = 150.;
        options.threshold = 170;
        options.filter_iterations = 1;
        options.error_threshold = 0.75;
        options.line_threshold = 0.8;
        let variants = preview_variants(&source, &options).unwrap();
        assert_eq!(variants.len(), 4);
        assert_eq!(variants[0].options.threshold, 128);
        assert_eq!(variants[1].options.threshold, 180);
        assert!(variants[2].options.conservative);
        assert_eq!(variants[3].options.filter_iterations, 1);
        assert!(variants.iter().all(|v| v.page == 2
            && v.source.ends_with("inko-inko.pdf")
            && v.document.strokes.len() > 100));
        assert_ne!(variants[0].document.strokes, variants[1].document.strokes);
    }
    #[test]
    #[ignore = "Requires a copied release helper plus local Python modules and AutoTrace"]
    fn release_helper_runs_from_unrelated_cwd() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let script = root.join("target/release/helpers/trace_import.py");
        let options = ImportOptions::default();
        verify_python(&options.python_path, &script, true).unwrap();
        let output =
            std::env::temp_dir().join(format!("openink-release-helper-{}.svg", std::process::id()));
        let run = python_command(&options.python_path)
            .arg(&script)
            .arg(root.join("../inko-inko.pdf"))
            .arg(&output)
            .arg("--autotrace")
            .arg(options.autotrace_path)
            .args(["--dpi", "150", "--page", "2"])
            .current_dir(std::env::temp_dir())
            .output()
            .unwrap();
        assert!(
            run.status.success(),
            "{}",
            String::from_utf8_lossy(&run.stderr)
        );
        let doc = read_svg(&output, 0.02, 25.4 / 150.).unwrap();
        assert!(doc.strokes.len() > 100);
        let _ = fs::remove_file(&output);
        let _ = fs::remove_file(output.with_extension("ppm"));
    }
}
