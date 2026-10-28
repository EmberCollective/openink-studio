//! Open local stroke fonts built by explicitly mapping selected page trajectories.
use crate::model::{Document, Point, Stroke};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GlyphFont {
    pub format: String,
    pub version: u32,
    pub name: String,
    pub glyphs: BTreeMap<String, Glyph>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Glyph {
    pub width_mm: f64,
    pub height_mm: f64,
    pub advance_mm: f64,
    pub strokes: Vec<Stroke>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GlyphFontSummary {
    pub name: String,
    pub path: String,
    pub characters: Vec<String>,
}

fn directory() -> Result<PathBuf, String> {
    let root = std::env::var_os("LOCALAPPDATA")
        .ok_or("LOCALAPPDATA is unavailable; cannot locate local glyph libraries")?;
    Ok(PathBuf::from(root).join("OpenInkStudio/glyph-fonts"))
}
fn summary(font: &GlyphFont, path: &Path) -> GlyphFontSummary {
    GlyphFontSummary {
        name: font.name.clone(),
        path: path.to_string_lossy().into_owned(),
        characters: font.glyphs.keys().cloned().collect(),
    }
}
fn safe_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err("Library name must contain 1..100 UTF-8 bytes".into());
    }
    // Hex encoding every UTF-8 byte gives a stable Windows-safe filename and no traversal.
    Ok(format!(
        "font-{}.json",
        name.as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}
fn validate_glyph(g: &Glyph) -> Result<(), String> {
    if [g.width_mm, g.height_mm, g.advance_mm]
        .iter()
        .any(|v| !v.is_finite() || *v < 0.)
        || g.height_mm <= 0.
        || g.advance_mm <= 0.
    {
        return Err("Invalid glyph dimensions".into());
    }
    if g.strokes.is_empty() || g.strokes.iter().map(Vec::len).sum::<usize>() > 2_000_000 {
        return Err("Glyph has no strokes or exceeds point limit".into());
    }
    for line in &g.strokes {
        if line.len() < 2 {
            return Err("Glyph contains an empty or single-point stroke".into());
        }
        for p in line {
            if !p.x.is_finite()
                || !p.y.is_finite()
                || p.x < -1e-8
                || p.y < -1e-8
                || p.x > g.width_mm + 1e-8
                || p.y > g.height_mm + 1e-8
            {
                return Err("Glyph coordinates exceed finite bounding box".into());
            }
        }
    }
    Ok(())
}
pub(crate) fn load(path: &Path) -> Result<GlyphFont, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > 100_000_000 {
        return Err("Glyph library exceeds 100 MB".into());
    }
    let font: GlyphFont = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Glyph library JSON: {e}"))?;
    if font.format != "openink-stroke-font" || font.version != 1 {
        return Err("Unsupported stroke font format/version".into());
    }
    let mut points = 0;
    for (ch, g) in &font.glyphs {
        if ch.chars().count() != 1 || ch.chars().any(char::is_whitespace) {
            return Err("Glyph keys must be one non-whitespace Unicode character".into());
        }
        validate_glyph(g)?;
        points += g.strokes.iter().map(Vec::len).sum::<usize>();
        if points > 2_000_000 {
            return Err("Glyph library exceeds two million points".into());
        }
    }
    Ok(font)
}
pub fn list_fonts() -> Result<Vec<GlyphFontSummary>, String> {
    list_at(&directory()?)
}
fn list_at(dir: &Path) -> Result<Vec<GlyphFontSummary>, String> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|x| x.to_str()) == Some("json") {
            let font = load(&path)?;
            out.push(summary(&font, &path));
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn extract(document: &Document, window: [f64; 4]) -> Result<Glyph, String> {
    let [x, y, right, bottom] = window;
    if window.iter().any(|v| !v.is_finite()) || right <= x || bottom <= y {
        return Err("Selection must be a finite positive rectangle [x0,y0,x1,y1]".into());
    }
    let inside = |p: &Point| p.x >= x && p.x <= right && p.y >= y && p.y <= bottom;
    // Segment/rectangle intersection also catches strokes whose vertices are all outside.
    let intersects = |a: &Point, b: &Point| {
        let mut lo: f64 = 0.;
        let mut hi: f64 = 1.;
        for (origin, delta, min, max) in [(a.x, b.x - a.x, x, right), (a.y, b.y - a.y, y, bottom)] {
            if delta == 0. {
                if origin < min || origin > max {
                    return false;
                }
            } else {
                let u = (min - origin) / delta;
                let v = (max - origin) / delta;
                lo = lo.max(u.min(v));
                hi = hi.min(u.max(v));
                if lo > hi {
                    return false;
                }
            }
        }
        true
    };
    let mut strokes = vec![];
    let mut count = 0;
    for line in &document.strokes {
        count += line.len();
        if count > 2_000_000 {
            return Err("Source exceeds two million points".into());
        }
        if line.iter().any(|p| !p.x.is_finite() || !p.y.is_finite()) {
            return Err("Source contains non-finite points".into());
        }
        let any = line.iter().any(&inside);
        let all = !line.is_empty() && line.iter().all(&inside);
        if !all && (any || line.windows(2).any(|pair| intersects(&pair[0], &pair[1]))) {
            return Err(
                "Selection crosses a stroke; expand the rectangle to include the complete stroke"
                    .into(),
            );
        }
        if all && line.len() > 1 {
            strokes.push(line.clone())
        }
    }
    let mut minx = f64::INFINITY;
    let mut miny = f64::INFINITY;
    let mut maxx = f64::NEG_INFINITY;
    let mut maxy = f64::NEG_INFINITY;
    for p in strokes.iter().flatten() {
        minx = minx.min(p.x);
        miny = miny.min(p.y);
        maxx = maxx.max(p.x);
        maxy = maxy.max(p.y);
    }
    if strokes.is_empty() {
        return Err("Selection needs drawable strokes".into());
    }
    // A horizontal glyph such as 一 has no ink height. Its explicit selection
    // supplies the em height; keep the horizontal stroke centered in that em.
    let ink_height = maxy - miny;
    let em_height = if ink_height == 0. {
        bottom - y
    } else {
        ink_height
    };
    for p in strokes.iter_mut().flatten() {
        p.x -= minx;
        p.y = if ink_height == 0. {
            em_height * 0.5
        } else {
            p.y - miny
        };
    }
    let glyph = Glyph {
        width_mm: maxx - minx,
        height_mm: em_height,
        advance_mm: (maxx - minx).max(em_height * 0.15),
        strokes,
    };
    validate_glyph(&glyph)?;
    Ok(glyph)
}
pub fn save_glyph(
    library_name: String,
    character: String,
    document: Document,
    window: [f64; 4],
) -> Result<GlyphFontSummary, String> {
    save_at(&directory()?, library_name, character, document, window)
}
fn save_at(
    dir: &Path,
    library_name: String,
    character: String,
    document: Document,
    window: [f64; 4],
) -> Result<GlyphFontSummary, String> {
    let _guard = SAVE_LOCK
        .lock()
        .map_err(|_| "Glyph library save lock is unavailable")?;
    if character.chars().count() != 1 || character.chars().any(char::is_whitespace) {
        return Err("Map exactly one non-whitespace Unicode character".into());
    }
    let filename = safe_name(&library_name)?;
    let name = library_name.trim().to_owned();
    let glyph = extract(&document, window)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(filename);
    // Reject links so a managed library cannot redirect writes outside its directory.
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            return Err("Symbolic-link font files are refused".into());
        }
    }
    let mut font = if path.exists() {
        load(&path)?
    } else {
        GlyphFont {
            format: "openink-stroke-font".into(),
            version: 1,
            name,
            glyphs: BTreeMap::new(),
        }
    };
    if font.glyphs.contains_key(&character) {
        return Err(format!("Character {character} already exists; choose another library to preserve the existing glyph"));
    }
    font.glyphs.insert(character, glyph);
    let total: usize = font
        .glyphs
        .values()
        .flat_map(|g| g.strokes.iter())
        .map(Vec::len)
        .sum();
    if total > 2_000_000 {
        return Err("Library exceeds two million points".into());
    }
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&font).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(temporary);
        return Err(format!("Cannot atomically save glyph library: {e}"));
    }
    Ok(summary(&font, &path))
}

pub fn compose(
    path: &Path,
    text: &str,
    size_mm: f64,
    spacing_mm: f64,
    rows: usize,
    width_mm: f64,
    height_mm: f64,
) -> Result<Document, String> {
    if [size_mm, width_mm, height_mm]
        .iter()
        .any(|v| !v.is_finite() || *v <= 0.)
        || !spacing_mm.is_finite()
        || spacing_mm < 0.
        || rows == 0
    {
        return Err(
            "Positive size/page dimensions/rows and nonnegative spacing are required".into(),
        );
    }
    let pitch = height_mm / rows as f64;
    if pitch < size_mm {
        return Err("Configured rows are too close for the chosen glyph size".into());
    }
    let font = load(path)?;
    let mut strokes = vec![];
    let mut x = 0.;
    let mut row = 0usize;
    let mut points = 0usize;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                continue;
            } else {
                return Err("Use newline (LF or CRLF) for line breaks".into());
            }
        }
        if ch == '\n' {
            row += 1;
            x = 0.;
            if row >= rows {
                return Err("Text exceeds configured row count".into());
            }
            continue;
        }
        let glyph =
            if ch.is_whitespace() {
                None
            } else {
                Some(font.glyphs.get(&ch.to_string()).ok_or_else(|| {
                    format!("Stroke font lacks character {ch} (U+{:04X})", ch as u32)
                })?)
            };
        let advance = glyph.map_or(size_mm * 0.5, |g| g.advance_mm * size_mm / g.height_mm);
        let ink_width = glyph.map_or(advance, |g| g.width_mm * size_mm / g.height_mm);
        let needed = advance.max(ink_width);
        if needed > width_mm {
            return Err(format!("Character {ch} is wider than the page"));
        }
        if x > 0. && x + needed > width_mm {
            x = 0.;
            row += 1;
        }
        let y = row as f64 * pitch;
        if row >= rows || y + size_mm > height_mm {
            return Err(
                "Text exceeds configured rows or page height; no characters were discarded".into(),
            );
        }
        if let Some(g) = glyph {
            let scale = size_mm / g.height_mm;
            for line in &g.strokes {
                points += line.len();
                if points > 2_000_000 {
                    return Err("Composed text exceeds two million points".into());
                }
                strokes.push(
                    line.iter()
                        .map(|p| Point {
                            x: x + p.x * scale,
                            y: y + p.y * scale,
                        })
                        .collect(),
                );
            }
        }
        x += advance + spacing_mm;
    }
    if strokes.is_empty() {
        return Err("Text contains no drawable glyphs".into());
    }
    Ok(Document {
        name: format!("{} — stroke font text", font.name),
        width_mm,
        height_mm,
        strokes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Document {
        Document {
            name: "page".into(),
            width_mm: 100.,
            height_mm: 100.,
            strokes: vec![vec![Point { x: 10., y: 20. }, Point { x: 15., y: 30. }]],
        }
    }
    #[test]
    fn extract_save_load_compose_roundtrip() {
        let dir = std::env::temp_dir().join(format!("openink-glyph-test-{}", std::process::id()));
        let result = save_at(
            &dir,
            "../自由字体".into(),
            "永".into(),
            source(),
            [9., 19., 16., 31.],
        )
        .unwrap();
        assert!(Path::new(&result.path).starts_with(&dir));
        assert_eq!(list_at(&dir).unwrap().len(), 1);
        let font = load(Path::new(&result.path)).unwrap();
        assert_eq!(font.glyphs["永"].strokes[0][0], Point { x: 0., y: 0. });
        let doc = compose(Path::new(&result.path), "永永", 20., 2., 2, 20., 50.).unwrap();
        assert_eq!(doc.strokes.len(), 2);
        assert_eq!(doc.strokes[1][0].y, 25.);
        assert!(compose(Path::new(&result.path), "无", 20., 2., 2, 20., 50.)
            .unwrap_err()
            .contains("lacks character"));
        assert!(save_at(
            &dir,
            "../自由字体".into(),
            "永".into(),
            source(),
            [9., 19., 16., 31.]
        )
        .is_err());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn boundary_crossings_rejected() {
        assert!(extract(&source(), [11., 21., 13., 24.]).is_err());
        assert!(extract(&source(), [9., 19., 12., 22.]).is_err());
    }
    #[test]
    fn row_overflow_is_error() {
        let dir =
            std::env::temp_dir().join(format!("openink-glyph-row-test-{}", std::process::id()));
        let summary = save_at(
            &dir,
            "test".into(),
            "A".into(),
            source(),
            [9., 19., 16., 31.],
        )
        .unwrap();
        assert!(compose(Path::new(&summary.path), "AAAA", 10., 1., 1, 12., 100.).is_err());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn horizontal_glyph_uses_selection_em_height() {
        let dir = std::env::temp_dir().join(format!(
            "openink-glyph-horizontal-test-{}",
            std::process::id()
        ));
        let mut document = source();
        document.strokes = vec![vec![Point { x: 10., y: 25. }, Point { x: 20., y: 25. }]];
        let saved = save_at(
            &dir,
            "horizontal".into(),
            "一".into(),
            document,
            [9., 20., 21., 30.],
        )
        .unwrap();
        let font = load(Path::new(&saved.path)).unwrap();
        let glyph = &font.glyphs["一"];
        assert_eq!(glyph.width_mm, 10.);
        assert_eq!(glyph.height_mm, 10.);
        assert_eq!(glyph.strokes[0][0].y, 5.);
        let doc = compose(Path::new(&saved.path), "一", 20., 1., 1, 50., 30.).unwrap();
        assert!(doc
            .strokes
            .iter()
            .flatten()
            .all(|p| p.x.is_finite() && p.y.is_finite()));
        assert_eq!(doc.strokes[0][0].y, 10.);
        assert_eq!(doc.strokes[0][1].x, 20.);
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn configured_rows_control_line_pitch() {
        let dir =
            std::env::temp_dir().join(format!("openink-glyph-pitch-test-{}", std::process::id()));
        let saved = save_at(
            &dir,
            "pitch".into(),
            "A".into(),
            source(),
            [9., 19., 16., 31.],
        )
        .unwrap();
        let path = Path::new(&saved.path);
        let two = compose(path, "A\nA", 10., 1., 2, 100., 100.).unwrap();
        let four = compose(path, "A\nA", 10., 1., 4, 100., 100.).unwrap();
        assert_eq!(two.strokes[1][0].y, 50.);
        assert_eq!(four.strokes[1][0].y, 25.);
        assert!(compose(path, "A", 30., 1., 4, 100., 100.).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
