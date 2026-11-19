//! 让同一个字每次出现略有不同：整字的大小/倾斜 + 逐笔画的伸缩与起笔位置。
//! 只在 OpenInk 字包（glyph）排版时使用；普通 TTF / 原版 gfont 不涉及。
use crate::inkfont::Random;
use crate::model::Stroke;

/// 允许的差异强度上限（百分比）。超过会把字拉得不像字。
pub const MAX_PERCENT: f64 = 15.;

pub fn valid(percent: f64) -> bool {
    percent.is_finite() && (0.0..=MAX_PERCENT).contains(&percent)
}

/// 一个字实例的全部笔画调用一次：
/// 1) 每条笔画绕自身中心小幅度缩放（横笔画偏水平、竖笔画偏垂直，副轴减半，短笔画再减半），
///    并各自做很小的起笔位置偏移——真人写同一个字，每笔的落点也不会完全重合；
/// 2) 整字绕中心轻微缩放与倾斜，这是肉眼最容易看出的「同一个字不一样」。
/// 所有幅度都随强度线性变化且受控，骨架仍保留，字不会散。
pub fn vary_strokes(strokes: &mut [Stroke], percent: f64, random: &mut Random) {
    if percent <= 0. {
        return;
    }
    let amount = percent / 100.;
    for stroke in strokes.iter_mut() {
        if stroke.len() < 2 {
            continue;
        }
        let (mut minx, mut miny, mut maxx, mut maxy) =
            (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for p in stroke.iter() {
            if !p.x.is_finite() || !p.y.is_finite() {
                continue;
            }
            minx = minx.min(p.x);
            miny = miny.min(p.y);
            maxx = maxx.max(p.x);
            maxy = maxy.max(p.y);
        }
        let (w, h) = (maxx - minx, maxy - miny);
        if !w.is_finite() || !h.is_finite() || !maxx.is_finite() {
            continue;
        }
        let (cx, cy) = ((minx + maxx) / 2., (miny + maxy) / 2.);
        let horizontal = w >= h;
        // 短笔画（点、小勾）幅度再减半，避免一个点被拉成一条线。
        let damp = if (w * w + h * h).sqrt() < 2. { 0.5 } else { 1. };
        let sx = 1. + (random.unit() * 2. - 1.) * amount * damp * if horizontal { 1. } else { 0.45 };
        let sy = 1. + (random.unit() * 2. - 1.) * amount * damp * if horizontal { 0.45 } else { 1. };
        // 每条笔画的落点轻微错开（15% 强度时约 ±0.38mm），不做整字平移，字形不会散。
        let shift_x = (random.unit() * 2. - 1.) * percent * 0.025;
        let shift_y = (random.unit() * 2. - 1.) * percent * 0.025;
        for p in stroke.iter_mut() {
            p.x = cx + (p.x - cx) * sx + shift_x;
            p.y = cy + (p.y - cy) * sy + shift_y;
        }
    }
    // 整字级：轻微大小变化 + 倾斜（15% 强度时约 ±7.5%、±3°）。
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
    if !minx.is_finite() || !maxx.is_finite() {
        return;
    }
    let (cx, cy) = ((minx + maxx) / 2., (miny + maxy) / 2.);
    let scale = 1. + (random.unit() * 2. - 1.) * amount * 0.5;
    let angle = (random.unit() * 2. - 1.) * (percent * 0.2_f64).to_radians();
    let (cos, sin) = (angle.cos(), angle.sin());
    for p in strokes.iter_mut().flatten() {
        let (x, y) = ((p.x - cx) * scale, (p.y - cy) * scale);
        p.x = cx + x * cos - y * sin;
        p.y = cy + x * sin + y * cos;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Point;

    fn sample() -> Vec<Stroke> {
        vec![
            vec![Point { x: 0., y: 0. }, Point { x: 8., y: 0. }],   // 横
            vec![Point { x: 4., y: 0. }, Point { x: 4., y: 12. }],  // 竖
            vec![Point { x: 1., y: 10. }, Point { x: 1.2, y: 10.3 }], // 点
        ]
    }

    fn centers(strokes: &[Stroke]) -> Vec<(f64, f64)> {
        strokes
            .iter()
            .map(|s| {
                let xs = s.iter().map(|p| p.x).collect::<Vec<_>>();
                let ys = s.iter().map(|p| p.y).collect::<Vec<_>>();
                (
                    (xs.iter().cloned().fold(f64::INFINITY, f64::min)
                        + xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max)) / 2.,
                    (ys.iter().cloned().fold(f64::INFINITY, f64::min)
                        + ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max)) / 2.,
                )
            })
            .collect()
    }

    #[test]
    fn zero_strength_leaves_the_glyph_untouched() {
        let original = sample();
        let mut varied = original.clone();
        vary_strokes(&mut varied, 0., &mut Random::new());
        assert_eq!(varied, original);
    }

    #[test]
    fn variation_stays_small_and_keeps_the_skeleton() {
        let original = sample();
        let before = centers(&original);
        let mut varied = original.clone();
        vary_strokes(&mut varied, MAX_PERCENT, &mut Random::new());
        let after = centers(&varied);
        // 每条笔画只轻微错开落点（含整字旋转带来的位移），不能散架。
        for (a, b) in before.iter().zip(after.iter()) {
            assert!((a.0 - b.0).abs() < 1.5 && (a.1 - b.1).abs() < 1.5,
                "笔画位置偏移必须很小：{a:?} → {b:?}");
        }
        assert!(varied.iter().flatten().all(|p| p.x.is_finite() && p.y.is_finite()));
        // 整字外框变化受控（笔画拉伸 15% + 整字缩放 7.5% + 倾斜）。
        for (before, after) in original.iter().zip(varied.iter()) {
            let w0 = before.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max)
                - before.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
            let w1 = after.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max)
                - after.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
            if w0 > 1e-9 {
                let ratio = w1 / w0;
                assert!((0.65..=1.35).contains(&ratio), "宽度变化超出受控范围：{ratio}");
            }
        }
    }

    #[test]
    fn whole_glyph_size_and_slant_differ_between_occurrences() {
        let size = |source: &[Stroke]| -> (f64, f64) {
            let xs = source.iter().flatten().map(|p| p.x).collect::<Vec<_>>();
            let ys = source.iter().flatten().map(|p| p.y).collect::<Vec<_>>();
            (xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - xs.iter().cloned().fold(f64::INFINITY, f64::min),
             ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - ys.iter().cloned().fold(f64::INFINITY, f64::min))
        };
        let (mut a, mut b) = (sample(), sample());
        vary_strokes(&mut a, MAX_PERCENT, &mut Random::new());
        vary_strokes(&mut b, MAX_PERCENT, &mut Random::new());
        assert_ne!(size(&a), size(&b), "整字大小/倾斜应有可见差异");
    }

    #[test]
    fn repeated_characters_get_different_shapes() {
        let first = {
            let mut s = sample();
            vary_strokes(&mut s, 8., &mut Random::new());
            s
        };
        let second = {
            let mut s = sample();
            vary_strokes(&mut s, 8., &mut Random::new());
            s
        };
        assert_ne!(first, second, "同一个字两次出现应有可见差异");
    }

    #[test]
    fn percent_range_is_enforced() {
        assert!(valid(0.) && valid(8.) && valid(MAX_PERCENT));
        assert!(!valid(-1.) && !valid(MAX_PERCENT + 1.) && !valid(f64::NAN));
    }
}
