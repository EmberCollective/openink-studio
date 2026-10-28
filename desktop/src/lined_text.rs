//! Place original font coordinates against confirmed paper baselines, without bbox re-alignment.
use crate::{glyphs, import::{self, ImportOptions}, model::{Document, Point, Stroke}};
#[cfg(feature = "private-gfont")]
use crate::legacy_font;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GuideLine { pub id: String, pub start: [f64; 2], pub end: [f64; 2] }
#[derive(Clone, Debug, Deserialize)]
pub struct FontSelection { pub path: String, pub weight: f64 }
#[derive(Clone, Debug, Deserialize)]
pub struct TextOptions {
    pub font_mode: String, pub path: String, pub selections: Vec<FontSelection>, pub text: String,
    pub size_mm: f64, pub spacing_mm: f64, pub guide_lines: Vec<GuideLine>, pub start_line: usize,
    pub baseline_offset_mm: f64, pub legacy_baseline: f64, pub legacy_percent: f64,
    pub legacy_seed: u64, pub centerline: bool, pub options: ImportOptions,
    pub width_mm: f64, pub height_mm: f64,
}
#[derive(Clone)]
struct Letter { strokes: Vec<Stroke>, advance: f64 }

fn layout(text: &str, guides: &[GuideLine], start: usize, spacing: f64, offset: f64,
    width: f64, height: f64, mut letter: impl FnMut(char) -> Result<Letter, String>) -> Result<Document, String> {
    let mut strokes: Vec<(usize, Stroke)> = vec![];
    let (mut row, mut cursor, mut count) = (start, 0., 0usize);
    for ch in text.chars().filter(|c| *c != '\r') {
        if ch == '\n' { row += 1; cursor = 0.; continue; }
        let glyph = letter(ch)?;
        let minx = glyph.strokes.iter().flatten().map(|p| p.x).fold(0., f64::min);
        let maxx = glyph.strokes.iter().flatten().map(|p| p.x).fold(glyph.advance, f64::max);
        let needed = maxx - minx;
        loop {
            let line = guides.get(row).ok_or("文字超出已确认的横线；请增加页面、减少内容或调整字号，未插入残缺文字")?;
            let dx = line.end[0] - line.start[0]; let dy = line.end[1] - line.start[1];
            let length = dx.hypot(dy);
            if cursor + needed > length + 1e-7 {
                if cursor == 0. { return Err(format!("字符 {ch} 宽于第 {} 条横线，请调整字号", row + 1)); }
                row += 1; cursor = 0.; continue;
            }
            let (tx, ty) = (dx / length, dy / length);
            for stroke in &glyph.strokes {
                count += stroke.len();
                if count > 2_000_000 { return Err("文字路径超过两百万个点".into()); }
                let transformed = stroke.iter().map(|p| {
                    let along = cursor - minx + p.x; let normal = p.y - offset;
                    Point { x: line.start[0] + tx * along - ty * normal, y: line.start[1] + ty * along + tx * normal }
                }).collect();
                strokes.push((row, transformed));
            }
            cursor += glyph.advance - minx + spacing;
            break;
        }
    }

    // A confirmed rule can sit close to a page edge. Fit each used row as one
    // unit so its glyphs keep a common baseline while the page remains the
    // only writable boundary.
    for fitted_row in 0..guides.len() {
        let row_points = || strokes.iter().filter(move |(r, _)| *r == fitted_row).flat_map(|(_, s)| s.iter());
        let (mut minx, mut maxx, mut miny, mut maxy) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for p in row_points() { minx=minx.min(p.x); maxx=maxx.max(p.x); miny=miny.min(p.y); maxy=maxy.max(p.y); }
        if !minx.is_finite() { continue; }
        if maxx - minx > width + 1e-6 || maxy - miny > height + 1e-6 {
            return Err("文字笔迹宽于整张画布，请调整字号、字间距或减少内容".into());
        }
        let shift_x = if minx < 0. { -minx } else if maxx > width { width - maxx } else { 0. };
        let shift_y = if miny < 0. { -miny } else if maxy > height { height - maxy } else { 0. };
        for (_, stroke) in strokes.iter_mut().filter(|(r, _)| *r == fitted_row) {
            for p in stroke { p.x += shift_x; p.y += shift_y; }
        }
    }
    for (_, stroke) in &strokes {
        if stroke.iter().any(|p| !p.x.is_finite() || !p.y.is_finite() || p.x < -1e-6 || p.y < -1e-6 || p.x > width+1e-6 || p.y > height+1e-6) {
            return Err("文字笔迹超出页面，请调整起始横线、字号或离线距离".into());
        }
    }
    import::validate(Document { name: "沿横线文字".into(), width_mm: width, height_mm: height, strokes: strokes.into_iter().map(|(_, stroke)| stroke).collect() })
}
pub fn compose(o: &TextOptions) -> Result<Document, String> {
    if ![o.size_mm,o.spacing_mm,o.baseline_offset_mm,o.legacy_baseline,o.legacy_percent,o.width_mm,o.height_mm].iter().all(|v|v.is_finite())
        || !(0.1..=100.).contains(&o.size_mm) || !(0.0..=100.).contains(&o.spacing_mm)
        || !(0.0..=100.).contains(&o.baseline_offset_mm) || !(0.0..=4.).contains(&o.legacy_baseline)
        || !(1.0..=500.).contains(&o.legacy_percent) || o.width_mm<=0. || o.width_mm>210. || o.height_mm<=0. || o.height_mm>297.
        || o.text.trim().is_empty() || o.text.chars().count()>5000 || o.guide_lines.is_empty() || o.guide_lines.len()>1000 || o.start_line>=o.guide_lines.len() || o.selections.len()>64 {
        return Err("沿线文字参数、横线数量或页面尺寸无效".into());
    }
    for g in &o.guide_lines {
        if [g.start,g.end].iter().any(|p|!p.iter().all(|v|v.is_finite())||p[0]<0.||p[0]>o.width_mm||p[1]<0.||p[1]>o.height_mm)
            || g.end[0]<=g.start[0] || (g.end[1]-g.start[1]).abs()>(g.end[0]-g.start[0])*0.25 {
            return Err("横线必须是页面内从左到右的有效近水平线段".into());
        }
    }
    let mut cache: HashMap<char, Letter> = HashMap::new();
    #[cfg(not(feature = "private-gfont"))]
    if o.font_mode == "legacy" { return Err("此版本不支持原版 gfont 字体；已有画布笔迹仍可使用".into()); }
    #[cfg(feature = "private-gfont")]
    let mut legacy = vec![];
    #[cfg(feature = "private-gfont")]
    if o.font_mode=="legacy" {
        for s in &o.selections {
            if !s.weight.is_finite()||s.weight<0. { return Err("字库权重无效".into()); }
            if s.weight>0. { legacy.push((legacy_font::load(Path::new(&s.path))?,s.weight)); }
        }
        if legacy.is_empty() { return Err("请先选择原版字库".into()); }
    }
    let glyph_font=if o.font_mode=="glyph" {Some(glyphs::load(Path::new(&o.path))?)}else{None};
    if !["legacy","glyph","regular"].contains(&o.font_mode.as_str()) { return Err("不支持的字体来源".into()); }
    #[cfg(feature = "private-gfont")]
    let mut random=legacy_font::Random(o.legacy_seed);
    layout(&o.text,&o.guide_lines,o.start_line,o.spacing_mm,o.baseline_offset_mm,o.width_mm,o.height_mm,|ch| {
        if ch.is_whitespace() { return Ok(Letter { strokes:vec![], advance:o.size_mm*if o.font_mode=="legacy" {o.legacy_percent/100.*0.3}else{0.5} }); }
        #[cfg(feature = "private-gfont")]
        if o.font_mode=="legacy" {
            let candidates:Vec<_>=legacy.iter().filter(|(f,_)|ch as u32<=65535&&f.glyphs.contains_key(&(ch as u16))).collect();
            let total:f64=candidates.iter().map(|(_,w)|*w).sum();
            if candidates.is_empty()||!total.is_finite() { return Err(format!("字库缺字或权重无效：{ch}；未插入残缺文字")); }
            let mut ticket=random.unit()*total;
            let mut choice=*candidates.last().unwrap();
            for candidate in candidates { if ticket<candidate.1 {choice=candidate;break;} ticket-=candidate.1; }
            let scale=o.size_mm*o.legacy_percent/100./choice.0.summary.size as f64;
            let mut strokes=choice.0.glyphs[&(ch as u16)].strokes();
            for p in strokes.iter_mut().flatten(){p.x*=scale;p.y=p.y*scale+o.size_mm*0.75*(o.legacy_baseline-1.);}
            let max=strokes.iter().flatten().map(|p|p.x).fold(0.,f64::max);
            return Ok(Letter{strokes,advance:max.max(o.size_mm*0.1)});
        }
        if let Some(glyph)=cache.get(&ch){return Ok(glyph.clone());}
        let glyph=if let Some(font)=&glyph_font {
            let g=font.glyphs.get(&ch.to_string()).ok_or_else(||format!("本地字库缺字：{ch}"))?;
            let scale=o.size_mm/g.height_mm;
            Letter{advance:g.advance_mm*scale,strokes:g.strokes.iter().map(|s|s.iter().map(|p|Point{x:p.x*scale,y:p.y*scale-o.size_mm}).collect()).collect()}
        }else{
            let mut doc=if o.centerline {import::font_centerline(Path::new(&o.path),&ch.to_string(),o.size_mm,&o.options,true)?}
                else {let mut d=import::font_text(Path::new(&o.path),&ch.to_string(),o.size_mm)?;for p in d.strokes.iter_mut().flatten(){p.y-=o.size_mm;}d};
            Letter{advance:doc.width_mm,strokes:std::mem::take(&mut doc.strokes)}
        };
        cache.insert(ch,glyph.clone());Ok(glyph)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lined_text_document(font_mode:String,path:String,selections:Vec<FontSelection>,text:String,size_mm:f64,spacing_mm:f64,
    guide_lines:Vec<GuideLine>,start_line:usize,baseline_offset_mm:f64,legacy_baseline:f64,legacy_percent:f64,legacy_seed:u64,
    centerline:bool,options:ImportOptions,width_mm:f64,height_mm:f64)->Result<Document,String>{
    tauri::async_runtime::spawn_blocking(move||compose(&TextOptions{font_mode,path,selections,text,size_mm,spacing_mm,guide_lines,start_line,baseline_offset_mm,legacy_baseline,legacy_percent,legacy_seed,centerline,options,width_mm,height_mm})).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests{
 use super::*;
 fn line(y:f64)->GuideLine{GuideLine{id:y.to_string(),start:[10.,y],end:[25.,y]}}
 fn letter(ch:char)->Result<Letter,String>{Ok(Letter{advance:8.,strokes:vec![vec![Point{x:0.,y:if ch=='A'{-8.}else{-4.}},Point{x:6.,y:0.}]]})}
 #[test]
 #[cfg(not(feature = "private-gfont"))]
 fn public_build_rejects_private_font_before_loading_files(){
  let options=TextOptions{font_mode:"legacy".into(),path:String::new(),selections:vec![FontSelection{path:"must-not-be-read.gfont".into(),weight:1.}],text:"A".into(),size_mm:10.,spacing_mm:1.,guide_lines:vec![line(20.)],start_line:0,baseline_offset_mm:0.,legacy_baseline:1.,legacy_percent:100.,legacy_seed:1,centerline:false,options:ImportOptions::default(),width_mm:100.,height_mm:100.};
  assert!(!crate::commands::private_gfont_available());
  assert!(compose(&options).unwrap_err().contains("此版本不支持"));
 }
 #[test]fn real_baselines_and_nonuniform_rows(){let d=layout("AB\nA",&[line(20.),line(31.),line(48.)],0,1.,0.5,100.,100.,letter).unwrap();assert_eq!(d.strokes[0][1].y,19.5);assert_eq!(d.strokes[1][1].y,30.5);assert_eq!(d.strokes[2][1].y,47.5);assert_eq!(d.strokes[0][0].y,11.5);assert_eq!(d.strokes[1][0].y,26.5);}
 #[test]fn overflow_is_error_not_dropped_text(){assert!(layout("AAA",&[line(20.)],0,1.,0.,100.,100.,letter).is_err());}
 #[test]fn slanted_line_rotates_whole_glyph(){let g=GuideLine{id:"a".into(),start:[10.,20.],end:[110.,30.]};let d=layout("A",&[g],0,0.,0.,200.,100.,letter).unwrap();assert!((d.strokes[0][1].y-(20.+6./10100_f64.sqrt()*10.)).abs()<1e-6);}
 #[test]fn first_nonempty_row_fits_inside_page_without_rejecting(){let d=layout("A",&[line(20.),line(2.)],1,0.,0.,100.,100.,letter).unwrap();assert!(d.strokes.iter().flatten().all(|p|p.y>=0.&&p.y<=100.));}
}
