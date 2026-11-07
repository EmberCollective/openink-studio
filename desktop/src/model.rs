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
}
