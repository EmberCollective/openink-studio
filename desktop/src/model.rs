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
