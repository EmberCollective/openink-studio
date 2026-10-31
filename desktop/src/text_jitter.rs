use super::Stroke;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TextJitter {
    pub x_mm: f64,
    pub x_mm_min: Option<f64>,
    pub y_mm: f64,
    pub y_mm_min: Option<f64>,
    pub rotation_deg: f64,
    pub rotation_deg_min: Option<f64>,
    pub scale_x_percent: f64,
    pub scale_x_percent_min: Option<f64>,
    pub scale_y_percent: f64,
    pub scale_y_percent_min: Option<f64>,
    pub scale_percent: f64,
    pub scale_percent_min: Option<f64>,
    pub seed: u64,
}

impl TextJitter {
    pub fn validate(&self) -> Result<(), String> {
        if [(self.x_mm_min,self.x_mm,20.), (self.y_mm_min,self.y_mm,20.), (self.rotation_deg_min,self.rotation_deg,180.),
            (self.scale_x_percent_min,self.scale_x_percent,50.), (self.scale_y_percent_min,self.scale_y_percent,50.), (self.scale_percent_min,self.scale_percent,50.)]
            .iter().any(|(min, max, limit)| {
                let min = min.unwrap_or(-*max);
                !min.is_finite() || !max.is_finite() || min < -*limit || *max > *limit || min > *max
            }) {
            return Err("抖动下限不能大于上限；位置范围 −20～20 mm，旋转 −180～180°，缩放变化 −50～50%".into());
        }
        Ok(())
    }

    pub fn apply(&mut self, strokes: &mut [Stroke]) {
        if [self.x_mm,self.y_mm,self.rotation_deg,self.scale_x_percent,self.scale_y_percent,self.scale_percent].iter().all(|v| *v == 0.)
            && [self.x_mm_min,self.y_mm_min,self.rotation_deg_min,self.scale_x_percent_min,self.scale_y_percent_min,self.scale_percent_min].iter().all(|v| v.unwrap_or(0.) == 0.) { return; }
        let (mut minx, mut miny, mut maxx, mut maxy) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for p in strokes.iter().flatten() {
            minx = minx.min(p.x); miny = miny.min(p.y); maxx = maxx.max(p.x); maxy = maxy.max(p.y);
        }
        if !minx.is_finite() { return; }
        let mut sample = |min: Option<f64>, max: f64| {
            self.seed = self.seed.wrapping_add(0x9e3779b97f4a7c15);
            let mut z = self.seed;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
            let min = min.unwrap_or(-max);
            min + ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64 * (max - min)
        };
        let (rx, ry, angle) = (sample(self.x_mm_min,self.x_mm), sample(self.y_mm_min,self.y_mm), sample(self.rotation_deg_min,self.rotation_deg));
        let (sx, sy, size) = (sample(self.scale_x_percent_min,self.scale_x_percent), sample(self.scale_y_percent_min,self.scale_y_percent), sample(self.scale_percent_min,self.scale_percent));
        let scale = 1. + size / 100.;
        let (sx, sy) = (scale * (1. + sx / 100.), scale * (1. + sy / 100.));
        let (sin, cos) = angle.to_radians().sin_cos();
        let (cx, cy) = ((minx + maxx) / 2., (miny + maxy) / 2.);
        for p in strokes.iter_mut().flatten() {
            let (x, y) = ((p.x - cx) * sx, (p.y - cy) * sy);
            p.x = cx + x * cos - y * sin + rx;
            p.y = cy + x * sin + y * cos + ry;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Point;
    #[test]
    fn asymmetric_and_fixed_intervals() {
        let original = vec![vec![Point{x:10.,y:10.}, Point{x:14.,y:10.}]];
        let mut settings = TextJitter { x_mm_min:Some(1.), x_mm:3., y_mm_min:Some(-4.), y_mm:-2., rotation_deg_min:Some(0.), rotation_deg:0., scale_percent_min:Some(10.), scale_percent:20., ..Default::default() };
        settings.validate().unwrap();
        for _ in 0..100 {
            let mut glyph=original.clone(); settings.apply(&mut glyph);
            let (a,b)=(glyph[0][0],glyph[0][1]);
            assert!((13.0..=15.).contains(&((a.x+b.x)/2.)));
            assert!((6.0..=8.).contains(&a.y));
            assert!((4.4..=4.8).contains(&(b.x-a.x)));
        }
        let mut fixed=TextJitter{x_mm_min:Some(2.),x_mm:2.,..Default::default()};
        let mut glyph=original.clone();fixed.apply(&mut glyph);
        assert_eq!(glyph[0][0],Point{x:12.,y:10.});
        assert!(TextJitter{x_mm_min:Some(3.),x_mm:2.,..Default::default()}.validate().is_err());
        assert!(TextJitter{x_mm_min:Some(f64::NAN),..Default::default()}.validate().is_err());
    }
    #[test]
    fn scales_are_independent_and_uniform_scale_preserves_aspect() {
        let original = vec![vec![Point{x:10.,y:10.}, Point{x:14.,y:16.}]];
        for axis in 0..3 {
            let mut settings = TextJitter::default();
            match axis { 0 => settings.scale_x_percent=30., 1 => settings.scale_y_percent=30., _ => settings.scale_percent=30. }
            for _ in 0..100 {
                let mut glyph=original.clone(); settings.apply(&mut glyph);
                let (a,b)=(glyph[0][0],glyph[0][1]);
                let (sx,sy)=((b.x-a.x)/4.,(b.y-a.y)/6.);
                assert!((0.7..=1.3).contains(&sx) && (0.7..=1.3).contains(&sy));
                assert!(((a.x+b.x)/2.-12.).abs()<1e-10 && ((a.y+b.y)/2.-13.).abs()<1e-10);
                match axis { 0 => assert_eq!(sy,1.), 1 => assert_eq!(sx,1.), _ => assert!((sx-sy).abs()<1e-10) }
            }
        }
        assert!(TextJitter{scale_percent:51.,..Default::default()}.validate().is_err());
    }
    #[test]
    fn rigid_bounded_repeatable_and_zero_is_unchanged() {
        let original = vec![vec![Point{x:10.,y:10.}, Point{x:14.,y:10.}]];
        let mut zero = original.clone();
        TextJitter::default().apply(&mut zero);
        assert_eq!(zero, original);
        let settings = TextJitter{x_mm:2.,y_mm:3.,rotation_deg:15.,seed:42,..Default::default()};
        let mut random = settings;
        let mut previous = original.clone();
        for _ in 0..100 {
            let mut glyph = original.clone(); random.apply(&mut glyph);
            let (a,b) = (glyph[0][0],glyph[0][1]);
            assert!(((b.x-a.x).hypot(b.y-a.y)-4.).abs()<1e-10);
            assert!(((a.x+b.x)/2.-12.).abs()<=2.);
            assert!(((a.y+b.y)/2.-10.).abs()<=3.);
            assert!((b.y-a.y).atan2(b.x-a.x).to_degrees().abs()<=15.);
            assert_ne!(glyph, previous); previous=glyph;
        }
        let mut a=original.clone(); let mut b=original;
        settings.clone().apply(&mut a); settings.clone().apply(&mut b);
        assert_eq!(a,b);
        for bad in [f64::NAN, f64::INFINITY, -1., 21.] {
            assert!(TextJitter{x_mm:bad,..settings}.validate().is_err());
        }
    }
}
