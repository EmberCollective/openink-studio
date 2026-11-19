mod text_jitter;
pub use text_jitter::TextJitter;
use serde::{Deserialize, Serialize};

/// Millimetres in page coordinates: X right, Y down. Device flips Y once.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
pub type Stroke = Vec<Point>;

pub const FONT_BASELINE_RATIO: f64 = 0.75;

/// 半角空格相对字号的推进量。常规西文词距约 0.25–0.3 em，但 `.inkfont` 的
/// `height_mm` 是字身画布（20mm）而不是字身，实际画出的墨迹只有字号的约 55%，
/// 按 0.25 em 折算到这个字号上仍然明显偏宽；0.22 才是肉眼看过去的常规词距。
/// 取 0.5 em 会让每个词之间空出近半个字身，整行英文被拆成一段一段。
pub const SPACE_ADVANCE_EM: f64 = 0.22;

/// 空格的推进量。全角空格（U+3000）固定占满一个字身；其余空白先看用户是否指定了
/// 空格宽度（毫米），未指定时按 [`SPACE_ADVANCE_EM`] 折算。
pub fn space_advance(ch: char, size: f64, width_mm: Option<f64>) -> f64 {
    if ch == '\u{3000}' { return size; }
    match width_mm {
        Some(w) if w.is_finite() && w >= 0. => w,
        _ => size * SPACE_ADVANCE_EM,
    }
}

pub fn font_baseline_offset(size: f64, adjustment: f64) -> f64 {
    size * FONT_BASELINE_RATIO * adjustment
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontHorizontalMetrics {
    pub right: f64,
    pub left_shift: f64,
    pub advance: f64,
}

/// Keep positive left bearing; compensate only geometry extending left of the origin.
pub fn font_horizontal_metrics(strokes: &[Stroke], scale: f64) -> FontHorizontalMetrics {
    let (mut minx, mut maxx) = (f64::INFINITY, f64::NEG_INFINITY);
    for point in strokes.iter().flatten() {
        let x = point.x * scale;
        minx = minx.min(x);
        maxx = maxx.max(x);
    }
    if minx == f64::INFINITY && maxx == f64::NEG_INFINITY {
        minx = 0.;
        maxx = 0.;
    }
    FontHorizontalMetrics {
        right: maxx,
        left_shift: (-minx).max(0.),
        advance: maxx - minx + minx.max(0.),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Document {
    pub name: String,
    pub width_mm: f64,
    pub height_mm: f64,
    pub strokes: Vec<Stroke>,
}

/// 排版文字：文档本体 + 每条笔画所属的字符分组（同一组即同一个字）。
/// 前端用它把「双击选整字」落到单字，而不是整段文字。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TextDocument {
    pub document: Document,
    #[serde(default)]
    pub groups: Vec<u32>,
}

fn mid(a: &Point, b: &Point) -> Point {
    Point {
        x: (a.x + b.x) / 2.,
        y: (a.y + b.y) / 2.,
    }
}
fn distance(q: &Point, a: &Point, b: &Point) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let l = dx * dx + dy * dy;
    let t = if l == 0. {
        0.
    } else {
        ((q.x - a.x) * dx + (q.y - a.y) * dy) / l
    }
    .clamp(0., 1.);
    (q.x - a.x - t * dx).hypot(q.y - a.y - t * dy)
}
pub fn cubic(
    out: &mut Stroke,
    a: Point,
    b: Point,
    c: Point,
    d: Point,
    tol: f64,
    depth: u8,
) -> Result<(), String> {
    if out.len() > 1_000_000 {
        return Err("Curve point limit exceeded".into());
    }
    if distance(&b, &a, &d).max(distance(&c, &a, &d)) <= tol * 0.5 {
        out.push(d);
        return Ok(());
    }
    if depth >= 24 {
        return Err("Curve subdivision limit exceeded".into());
    }
    let ab = mid(&a, &b);
    let bc = mid(&b, &c);
    let cd = mid(&c, &d);
    let abc = mid(&ab, &bc);
    let bcd = mid(&bc, &cd);
    let m = mid(&abc, &bcd);
    cubic(out, a, ab, abc, m.clone(), tol, depth + 1)?;
    cubic(out, m, bcd, cd, d, tol, depth + 1)
}

#[cfg(test)]
mod font_geometry_tests {
    use super::*;
    #[test]
    fn bearings_and_baseline_keep_the_existing_coordinate_contract() {
        for (minx, maxx, shift, advance) in [(3., 7., 0., 7.), (-3., 7., 3., 10.), (-7., -3., 7., 4.), (0., 0., 0., 0.)] {
            let strokes = vec![vec![Point{x:minx,y:2.},Point{x:maxx,y:8.}]];
            let metrics = font_horizontal_metrics(&strokes, 2.);
            assert_eq!(metrics, FontHorizontalMetrics{right:maxx*2.,left_shift:shift*2.,advance:advance*2.});
            assert_eq!(strokes[0][0].y, 2.);
        }
        assert_eq!(font_horizontal_metrics(&[], 1.).advance, 0.);
        assert_eq!(font_baseline_offset(20., 1.), 15.);
        assert_eq!(font_baseline_offset(20., 1.2-1.), 20.*0.75*(1.2-1.));
    }
    #[test]
    fn spaces_take_a_latin_word_gap_and_full_width_spaces_take_one_em() {
        assert_eq!(space_advance(' ', 12.2, None), 12.2*SPACE_ADVANCE_EM);
        assert!(space_advance(' ', 12.2, None) < 12.2*0.35, "半角空格不应占半个字身");
        assert_eq!(space_advance('\u{3000}', 12.2, None), 12.2);
        assert_eq!(space_advance('\t', 12.2, None), 12.2*SPACE_ADVANCE_EM);
    }
    #[test]
    fn a_document_space_width_overrides_the_default_only_for_plain_whitespace() {
        assert_eq!(space_advance(' ', 12.2, Some(1.5)), 1.5);
        assert_eq!(space_advance('\t', 12.2, Some(0.)), 0.);
        assert_eq!(space_advance('\u{3000}', 12.2, Some(1.5)), 12.2, "全角空格始终一个字身");
        assert_eq!(space_advance(' ', 12.2, Some(f64::NAN)), 12.2*SPACE_ADVANCE_EM);
        assert_eq!(space_advance(' ', 12.2, Some(-1.)), 12.2*SPACE_ADVANCE_EM);
    }
}
