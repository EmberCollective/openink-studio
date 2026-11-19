//! 笔锋：写字机是单线模型（Point 只有 x,y，笔尖宽度固定），无法直接写出墨迹粗细。
//! 这里用两种「几何上的锋」来模拟手写感：
//! - outline：把每条中心线扩成两端收尖、中间略宽的闭合轮廓，机器沿轮廓走一圈；
//! - taper：仍是单线，只在起笔加一个顿点、收笔加一个小挑锋，路径几乎不长。
//! 两种都保持「一条输入笔画 → 一条输出笔画」，所以分组、已书写标记等按下标对齐的数组不会错位。
use crate::model::{Point, Stroke};
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TipSettings {
    /// "outline" | "taper"
    #[serde(default = "default_style")]
    pub style: String,
    /// 轮廓最大全宽 / 单线锋的偏移幅度（mm）
    pub width_mm: f64,
    /// 起锋长度占笔画全长的比例 0–0.5
    pub start: f64,
    /// 收锋长度占笔画全长的比例 0–0.5
    pub end: f64,
}

fn default_style() -> String { "outline".into() }

pub fn valid(t: &TipSettings) -> bool {
    (t.style == "outline" || t.style == "taper")
        && t.width_mm.is_finite() && (0.05..=2.0).contains(&t.width_mm)
        && t.start.is_finite() && (0.0..=0.5).contains(&t.start)
        && t.end.is_finite() && (0.0..=0.5).contains(&t.end)
}

fn tangent(stroke: &[Point], i: usize) -> (f64, f64) {
    let n = stroke.len();
    let (a, b) = if i == 0 { (0, 1) } else if i == n - 1 { (n - 2, n - 1) } else { (i - 1, i + 1) };
    (stroke[b].x - stroke[a].x, stroke[b].y - stroke[a].y)
}

fn normal(stroke: &[Point], i: usize) -> (f64, f64) {
    let (dx, dy) = tangent(stroke, i);
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-9 { (0., 0.) } else { (-dy / len, dx / len) }
}

fn arclength(stroke: &[Point]) -> Vec<f64> {
    let mut out = vec![0.; stroke.len()];
    for i in 1..stroke.len() {
        let dx = stroke[i].x - stroke[i - 1].x;
        let dy = stroke[i].y - stroke[i - 1].y;
        out[i] = out[i - 1] + (dx * dx + dy * dy).sqrt();
    }
    out
}

/// 宽度包络：起笔、收笔处线性收到 0，中段保持全宽，于是两端是尖的。
fn envelope(t: f64, start: f64, end: f64) -> f64 {
    let rise = if start > 1e-9 { (t / start).min(1.) } else { 1. };
    let fall = if end > 1e-9 { ((1. - t) / end).min(1.) } else { 1. };
    rise.min(fall).max(0.)
}

fn outline(stroke: &Stroke, t: &TipSettings) -> Stroke {
    let n = stroke.len();
    let lengths = arclength(stroke);
    let total = *lengths.last().unwrap_or(&0.);
    if total < 1e-9 { return stroke.clone(); }
    let mut left = Vec::with_capacity(n);
    let mut right = Vec::with_capacity(n);
    for i in 0..n {
        let (nx, ny) = normal(stroke, i);
        let half = t.width_mm * 0.5 * envelope(lengths[i] / total, t.start, t.end);
        left.push(Point { x: stroke[i].x + nx * half, y: stroke[i].y + ny * half });
        right.push(Point { x: stroke[i].x - nx * half, y: stroke[i].y - ny * half });
    }
    let closed = left[0];
    let mut out = left;
    out.extend(right.into_iter().rev());
    out.push(closed);
    out
}

fn taper(stroke: &Stroke, t: &TipSettings) -> Stroke {
    let n = stroke.len();
    let (sx, sy) = normal(stroke, 0);
    let (ex, ey) = normal(stroke, n - 1);
    let (dx, dy) = tangent(stroke, 0);
    let len = (dx * dx + dy * dy).sqrt();
    let (ux, uy) = if len > 1e-9 { (dx / len, dy / len) } else { (0., 0.) };
    let reach = t.width_mm * t.start.max(t.end).max(0.2);
    let mut out = Vec::with_capacity(n + 2);
    // 起笔顿锋：先落在一个斜后方的小点，再进入笔画，形成尖的起笔。
    out.push(Point { x: stroke[0].x - ux * reach + sx * reach * 0.6,
                     y: stroke[0].y - uy * reach + sy * reach * 0.6 });
    out.extend_from_slice(stroke);
    // 收笔挑锋：沿法线方向挑出一小截，末尾回到原收笔点附近形成尖。
    out.push(Point { x: stroke[n - 1].x + ex * reach, y: stroke[n - 1].y + ey * reach });
    out
}

/// 逐笔画生成笔锋。输出笔画数与输入严格一致（1:1）。
pub fn apply_tips(strokes: &mut [Stroke], t: &TipSettings) {
    for stroke in strokes.iter_mut() {
        if stroke.len() < 2 { continue; }
        *stroke = if t.style == "taper" { taper(stroke, t) } else { outline(stroke, t) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line() -> Stroke {
        vec![Point { x: 0., y: 0. }, Point { x: 5., y: 0. }, Point { x: 10., y: 0. }]
    }
    fn settings(style: &str) -> TipSettings {
        TipSettings { style: style.into(), width_mm: 0.6, start: 0.2, end: 0.25 }
    }

    #[test]
    fn outline_is_a_closed_two_sided_stroke_with_sharp_ends() {
        let mut strokes = vec![line()];
        apply_tips(&mut strokes, &settings("outline"));
        assert_eq!(strokes.len(), 1, "笔画数必须保持 1:1");
        let s = &strokes[0];
        assert_eq!(s.len(), 2 * 3 + 1);
        assert_eq!(s.first(), s.last(), "闭合轮廓首尾点相同");
        assert_eq!(s[0], Point { x: 0., y: 0. }, "起笔收尖于原起点");
        assert_eq!(s[3], Point { x: 10., y: 0. }, "收笔收尖于原终点");
        assert!(s[1].y.abs() > 1e-9 || s[2].y.abs() > 1e-9, "中段应有宽度");
    }

    #[test]
    fn taper_keeps_a_single_open_line_and_only_adds_two_points() {
        let mut strokes = vec![line()];
        apply_tips(&mut strokes, &settings("taper"));
        let s = &strokes[0];
        assert_eq!(s.len(), 5);
        assert_eq!(s[1], Point { x: 0., y: 0. });
        assert_eq!(s[3], Point { x: 10., y: 0. });
        assert_ne!(s.first(), s.last(), "单线尖锋不是闭合轮廓");
    }

    #[test]
    fn short_and_degenerate_strokes_are_left_alone() {
        let mut strokes = vec![vec![Point { x: 1., y: 1. }], vec![Point { x: 2., y: 2. }, Point { x: 2., y: 2. }]];
        let before = strokes.clone();
        apply_tips(&mut strokes, &settings("outline"));
        assert_eq!(strokes, before);
    }

    #[test]
    fn parameters_are_validated() {
        assert!(valid(&settings("outline")) && valid(&settings("taper")));
        let mut bad = settings("outline"); bad.width_mm = 9.; assert!(!valid(&bad));
        let mut bad = settings("outline"); bad.start = 0.8; assert!(!valid(&bad));
        let mut bad = settings("outline"); bad.style = "weird".into(); assert!(!valid(&bad));
    }
}
