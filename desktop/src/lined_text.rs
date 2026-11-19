//! Place original font coordinates against confirmed paper baselines, without bbox re-alignment.
use crate::model::TextJitter;
use crate::text_rules::{RuleRequest, RuleRandom};
use crate::{glyphs, import::{self, ImportOptions}, model::{Document, Point, Stroke, TextDocument}};
#[cfg(feature = "private-gfont")]
use crate::legacy_font;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GuideLine { pub id: String, pub start: [f64; 2], pub end: [f64; 2] }
#[derive(Clone, Debug, Deserialize)]
pub struct FontSelection { pub path: String, pub weight: f64 }
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Alignment { #[default] Left, Center, Right, Justify }
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Paragraph {
    #[serde(default)] pub indent_mm: f64,
    #[serde(default)] pub alignment: Alignment,
}
#[derive(Clone, Debug, Deserialize)]
pub struct TextOptions {
    pub font_mode: String, pub path: String, pub selections: Vec<FontSelection>, pub text: String,
    pub size_mm: f64, pub spacing_mm: f64, pub guide_lines: Vec<GuideLine>, pub start_line: usize,
    pub baseline_offset_mm: f64, pub legacy_baseline: f64, pub legacy_percent: f64,
    pub legacy_seed: u64, pub centerline: bool, pub options: ImportOptions,
    pub width_mm: f64, pub height_mm: f64,
    /// 空格宽度（毫米）。留空时按字号折算，见 [`crate::model::space_advance`]。
    #[serde(default)] pub space_mm: Option<f64>,
    /// 字包字形按墨迹底部吸附基准线；小符号与下伸字母保持原位。
    #[serde(default)] pub auto_baseline: bool,
    /// 同字差异强度（百分比，0–15）。仅 glyph 字包生效，让同一个字每次出现略有不同。
    #[serde(default)] pub stroke_variation: Option<f64>,
    /// 笔锋（仅 glyph 字包）：把单线笔画变成两端收尖的轮廓或加起收笔尖角。
    #[serde(default)] pub stroke_tip: Option<crate::stroke_tip::TipSettings>,
    #[serde(default)] pub jitter: TextJitter,
    #[serde(default)] pub rules: Option<RuleRequest>,
    #[serde(default)] pub paragraph: Paragraph,
}
#[derive(Clone)]
struct Letter { strokes: Vec<Stroke>, advance: f64 }

fn layout_with_groups(text: &str, guides: &[GuideLine], start: usize, spacing: f64, offset: f64,
    width: f64, height: f64, mut jitter: TextJitter, rules: Option<&RuleRequest>, paragraph: &Paragraph, mut letter: impl FnMut(char) -> Result<Letter, String>) -> Result<(Document, Vec<u32>), String> {
    if let Some(r)=rules {r.validate(text)?;}
    let mut random=RuleRandom(jitter.seed);
    let mut row_column=0usize;
    let mut row_random=None;
    let mut strokes: Vec<(usize, usize, Stroke)> = vec![];
    let mut row_widths = HashMap::new();
    let mut wrapped = std::collections::HashSet::new();
    let mut paragraph_start = true;
    let (mut row, mut cursor, mut count) = (start, 0., 0usize);
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;
    // 英文等以空白分词的文本，换行时把整个单词挪到下一行；中文这类连续非 ASCII
    // 文本没有词边界，仍逐字换行。单词比整行还长时只尝试搬一次，随后退回逐字换行。
    struct WordState { start: usize, cursor: f64, strokes: usize, count: usize, row_width: Option<(f64, usize)> }
    let mut word: Option<WordState> = None;
    let mut moved: std::collections::HashSet<usize> = std::collections::HashSet::new();
    while index < chars.len() {
        let ch = chars[index];
        if ch=='\r' { index += 1; continue; }
        if ch == '\n' { row += 1; cursor = 0.; row_column=0; row_random=None; paragraph_start=true; word=None; moved.clear(); index += 1; continue; }
        if ch.is_ascii() && !ch.is_ascii_whitespace() && word.is_none() {
            word = Some(WordState { start: index, cursor, strokes: strokes.len(), count, row_width: row_widths.get(&row).copied() });
        }
        let mut glyph = letter(ch)?;
        let setting=rules.map(|r|r.settings(ch,index)).unwrap_or_default();
        let spacing_factor=if rules.is_some(){random.apply(&setting,&mut glyph.strokes)}else{1.};
        let horizontal=random.sample(setting.horizontal.unwrap_or([0.;2]));
        let left=setting.left.unwrap_or(0.);let right=setting.right.unwrap_or(0.);
        let minx = glyph.strokes.iter().flatten().map(|p| p.x).fold(0., f64::min);
        let maxx = glyph.strokes.iter().flatten().map(|p| p.x).fold(glyph.advance, f64::max);
        let needed = maxx - minx + left + right;
        let (mut rewound, mut skipped) = (false, false);
        loop {
            let line = guides.get(row).ok_or("文字超出已确认的横线；请增加页面、减少内容或调整字号，未插入残缺文字")?;
            let dx = line.end[0] - line.start[0]; let dy = line.end[1] - line.start[1];
            let length = dx.hypot(dy);
            let (first,amplitude,wavelength)=*row_random.get_or_insert_with(|| {
                if let Some(r)=rules.filter(|r|r.selection.is_none()) {(random.sample(r.rule.first_offset),random.sample(r.rule.wave_amplitude),random.sample(r.rule.wave_length))}else{(0.,0.,1.)}
            });
            let leading=if row_column==0 {first + if paragraph_start {paragraph.indent_mm} else {0.}}else{0.};
            if cursor + leading + needed > length + 1e-7 {
                if row_column == 0 { return Err(format!("字符 {ch} 加上首行缩进宽于第 {} 条横线，请调整字号或缩进", row + 1)); }
                // 行尾空白不该被带到下一行行首，直接换行并丢掉这个空格。
                if ch.is_whitespace() && glyph.strokes.is_empty() {
                    wrapped.insert(row);
                    row += 1; cursor = 0.; row_column=0; row_random=None; word=None;
                    skipped = true; break;
                }
                // 行首就开始的超长单词不该把整行清空再搬一次，交给逐字换行。
                let can_move = word.as_ref().is_some_and(|w| w.start < index && w.cursor > 1e-7 && !moved.contains(&w.start));
                if can_move {
                    let w = word.take().unwrap();
                    moved.insert(w.start);
                    strokes.truncate(w.strokes); count = w.count;
                    if let Some(v) = w.row_width { row_widths.insert(row, v); } else { row_widths.remove(&row); }
                    wrapped.insert(row);
                    row += 1; cursor = 0.; row_column=0; row_random=None;
                    index = w.start;
                    rewound = true; break;
                }
                wrapped.insert(row);
                row += 1; cursor = 0.; row_column=0; row_random=None; word=None; continue;
            }
            let (tx, ty) = (dx / length, dy / length);
            let mut placed = vec![];
            for stroke in &glyph.strokes {
                count += stroke.len();
                if count > 2_000_000 { return Err("文字路径超过两百万个点".into()); }
                let transformed = stroke.iter().map(|p| {
                    let along = cursor + leading + left - minx + p.x + horizontal; let normal = p.y - offset + amplitude*(std::f64::consts::TAU*row_column as f64/wavelength).sin();
                    Point { x: line.start[0] + tx * along - ty * normal, y: line.start[1] + ty * along + tx * normal }
                }).collect();
                placed.push(transformed);
            }
            jitter.apply(&mut placed);
            strokes.extend(placed.into_iter().map(|stroke| (row, row_column, stroke)));
            row_widths.insert(row, (cursor + leading + needed, row_column + 1));
            cursor += leading + left + glyph.advance.max(maxx) - minx + spacing*spacing_factor + right;
            row_column+=1;
            paragraph_start=false;
            break;
        }
        if rewound { continue; }
        if skipped { word = None; index += 1; continue; }
        if !ch.is_ascii() || ch.is_ascii_whitespace() { word = None; }
        index += 1;
    }

    for (row, column, stroke) in &mut strokes {
        let line = &guides[*row];
        let dx = line.end[0] - line.start[0]; let dy = line.end[1] - line.start[1];
        let length = dx.hypot(dy);
        let (used, columns) = row_widths[row];
        let remaining = (length - used).max(0.);
        let shift = match paragraph.alignment {
            Alignment::Left => 0., Alignment::Center => remaining / 2., Alignment::Right => remaining,
            Alignment::Justify if wrapped.contains(row) && columns > 1 => remaining * *column as f64 / (columns - 1) as f64,
            Alignment::Justify => 0.,
        };
        for point in stroke { point.x += shift * dx / length; point.y += shift * dy / length; }
    }

    // A confirmed rule can sit close to a page edge. Fit each used row as one
    // unit so its glyphs keep a common baseline while the page remains the
    // only writable boundary.
    for fitted_row in 0..guides.len() {
        let row_points = || strokes.iter().filter(move |(r, _, _)| *r == fitted_row).flat_map(|(_, _, s)| s.iter());
        let (mut minx, mut maxx, mut miny, mut maxy) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for p in row_points() { minx=minx.min(p.x); maxx=maxx.max(p.x); miny=miny.min(p.y); maxy=maxy.max(p.y); }
        if !minx.is_finite() { continue; }
        if maxx - minx > width + 1e-6 || maxy - miny > height + 1e-6 {
            return Err("文字笔迹宽于整张画布，请调整字号、字间距或减少内容".into());
        }
        let shift_x = if minx < 0. { -minx } else if maxx > width { width - maxx } else { 0. };
        let shift_y = if miny < 0. { -miny } else if maxy > height { height - maxy } else { 0. };
        for (_, _, stroke) in strokes.iter_mut().filter(|(r, _, _)| *r == fitted_row) {
            for p in stroke { p.x += shift_x; p.y += shift_y; }
        }
    }
    for (_, _, stroke) in &strokes {
        if stroke.iter().any(|p| !p.x.is_finite() || !p.y.is_finite() || p.x < -1e-6 || p.y < -1e-6 || p.x > width+1e-6 || p.y > height+1e-6) {
            return Err("文字笔迹超出页面，请调整起始横线、字号或离线距离".into());
        }
    }
    // 笔画按「行-列」连续产出：同一个字的笔画相邻，换字才会换 (row, column)。
    // 把每段连续的 (row, column) 编成一个字组，供前端双击选整字。
    let mut groups = Vec::with_capacity(strokes.len());
    let mut previous: Option<(usize, usize)> = None;
    let mut group = 0u32;
    for (row, column, _) in &strokes {
        if previous != Some((*row, *column)) { group = group.wrapping_add(1); previous = Some((*row, *column)); }
        groups.push(group);
    }
    let document = import::validate(Document { name: "排版文字".into(), width_mm: width, height_mm: height, strokes: strokes.into_iter().map(|(_, _, stroke)| stroke).collect() })?;
    Ok((document, groups))
}
/// 兼容旧调用：只取文档，丢弃字符分组。
fn layout(text: &str, guides: &[GuideLine], start: usize, spacing: f64, offset: f64,
    width: f64, height: f64, jitter: TextJitter, rules: Option<&RuleRequest>, paragraph: &Paragraph, letter: impl FnMut(char) -> Result<Letter, String>) -> Result<Document, String> {
    layout_with_groups(text, guides, start, spacing, offset, width, height, jitter, rules, paragraph, letter).map(|(document, _)| document)
}
pub fn compose_with_groups(o: &TextOptions) -> Result<(Document, Vec<u32>), String> {
    if !o.paragraph.indent_mm.is_finite() || !(0.0..=1000.).contains(&o.paragraph.indent_mm) {
        return Err("段落缩进必须是 0–1000 mm 的有限数值".into());
    }
    o.jitter.validate()?;
    if let Some(percent) = o.stroke_variation {
        if !crate::stroke_variation::valid(percent) {
            return Err("同字差异强度必须是 0–15% 的有限数值".into());
        }
    }
    if let Some(tip) = &o.stroke_tip {
        if !crate::stroke_tip::valid(tip) {
            return Err("笔锋参数无效：宽度 0.05–2mm、起收锋 0–0.5、样式 outline/taper".into());
        }
    }
    if let Some(r)=&o.rules {r.validate(&o.text)?;}
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
    let mut glyph_random = crate::inkfont::Random::new();
    if !["legacy","glyph","regular"].contains(&o.font_mode.as_str()) { return Err("不支持的字体来源".into()); }
    #[cfg(feature = "private-gfont")]
    let mut random=legacy_font::Random(o.legacy_seed);
    layout_with_groups(&o.text,&o.guide_lines,o.start_line,o.spacing_mm,o.baseline_offset_mm,o.width_mm,o.height_mm,o.jitter,o.rules.as_ref(),&o.paragraph,|ch| {
        if ch.is_whitespace() { return Ok(Letter { strokes:vec![], advance:if o.font_mode=="legacy" {o.size_mm*o.legacy_percent/100.*0.3}else{crate::model::space_advance(ch,o.size_mm,o.space_mm)} }); }
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
            for p in strokes.iter_mut().flatten(){p.x*=scale;p.y=p.y*scale+crate::model::font_baseline_offset(o.size_mm,o.legacy_baseline-1.);}
            let max=crate::model::font_horizontal_metrics(&strokes,1.).right;
            return Ok(Letter{strokes,advance:max.max(o.size_mm*0.1)});
        }
        if glyph_font.is_none() { if let Some(glyph)=cache.get(&ch){return Ok(glyph.clone());} }
        let glyph=if let Some(font)=&glyph_font {
            let g=font.choose(ch, &mut glyph_random).ok_or_else(||format!("本地字库缺字：{ch}"))?;
            let scale=o.size_mm/g.height_mm;
            // 先缩放成字身坐标，再逐笔画做微小随机拉伸：这样后面的 minx/maxx、
            // 推进量与页面越界校验都基于变换后的真实墨迹。
            let mut body:Vec<Stroke>=g.strokes.iter().map(|s|s.iter().map(|p|Point{x:p.x*scale,y:p.y*scale}).collect()).collect();
            if let Some(percent)=o.stroke_variation.filter(|v|*v>0.) {
                crate::stroke_variation::vary_strokes(&mut body, percent, &mut glyph_random);
            }
            if let Some(tip)=&o.stroke_tip {
                crate::stroke_tip::apply_tips(&mut body, tip);
            }
            let baseline=o.size_mm*font.baseline_ratio.unwrap_or(1.);
            let mut shift=-baseline;
            if o.auto_baseline {
                let mut min_y=f64::INFINITY; let mut max_y=f64::NEG_INFINITY;
                for p in g.strokes.iter().flatten() { min_y=min_y.min(p.y); max_y=max_y.max(p.y); }
                let descender=matches!(ch,'g'|'p'|'q'|'y'|'j');
                if max_y.is_finite() && min_y.is_finite() && max_y-min_y>=4. && !descender {
                    // 用扰动后的墨迹底部吸附，避免拉伸后离基准线偏一点。
                    let bottom=body.iter().flatten().map(|p|p.y).fold(f64::NEG_INFINITY,f64::max);
                    if bottom.is_finite() { shift=-bottom; }
                }
            }
            for p in body.iter_mut().flatten() { p.y+=shift; }
            Letter{advance:g.advance_mm*scale,strokes:body}
        }else{
            let mut doc=if o.centerline {import::font_centerline(Path::new(&o.path),&ch.to_string(),o.size_mm,&o.options,true)?}
                else {let mut d=import::font_text(Path::new(&o.path),&ch.to_string(),o.size_mm)?;for p in d.strokes.iter_mut().flatten(){p.y-=o.size_mm;}d};
            Letter{advance:doc.width_mm,strokes:std::mem::take(&mut doc.strokes)}
        };
        cache.insert(ch,glyph.clone());Ok(glyph)
    })
}
/// 兼容旧调用：只取文档，丢弃字符分组。
pub fn compose(o: &TextOptions) -> Result<Document, String> {
    compose_with_groups(o).map(|(document, _)| document)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lined_text_document(font_mode:String,path:String,selections:Vec<FontSelection>,text:String,size_mm:f64,spacing_mm:f64,
    guide_lines:Vec<GuideLine>,start_line:usize,baseline_offset_mm:f64,legacy_baseline:f64,legacy_percent:f64,legacy_seed:u64,
    centerline:bool,options:ImportOptions,width_mm:f64,height_mm:f64,jitter:Option<TextJitter>,rules:Option<RuleRequest>,paragraph:Option<Paragraph>,space_mm:Option<f64>,auto_baseline:Option<bool>,stroke_variation:Option<f64>,stroke_tip:Option<crate::stroke_tip::TipSettings>)->Result<TextDocument,String>{
    tauri::async_runtime::spawn_blocking(move||compose_with_groups(&TextOptions{font_mode,path,selections,text,size_mm,spacing_mm,guide_lines,start_line,baseline_offset_mm,legacy_baseline,legacy_percent,legacy_seed,centerline,options,width_mm,height_mm,space_mm,auto_baseline:auto_baseline.unwrap_or(false),stroke_variation,stroke_tip,jitter:jitter.unwrap_or_default(),rules,paragraph:paragraph.unwrap_or_default()})).await.map_err(|e|e.to_string())?
        .map(|(document, groups)| TextDocument { document, groups })
}

#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn paragraph_indent_wraps_only_continuations_and_restarts_after_newline(){
  let guides:Vec<_>=(0..5).map(|i|GuideLine{id:i.to_string(),start:[10.,20.+i as f64*15.],end:[40.,20.+i as f64*15.]}).collect();
  let p=Paragraph{indent_mm:10.,alignment:Alignment::Left};
  let d=layout("AAAA\nA",&guides,0,1.,0.,100.,100.,TextJitter::default(),None,&p,letter).unwrap();
  assert_eq!(d.strokes.iter().map(|s|(s[0].x,s[1].y)).collect::<Vec<_>>(),vec![(20.,20.),(29.,20.),(10.,35.),(19.,35.),(20.,50.)]);
  let p=Paragraph{indent_mm:30.,..p};
  assert!(layout("A",&guides,0,1.,0.,100.,100.,TextJitter::default(),None,&p,letter).is_err());
 }
 #[test]fn alignment_uses_line_extent_and_justifies_only_wrapped_rows(){
  let guides:Vec<_>=(0..4).map(|i|GuideLine{id:i.to_string(),start:[10.,20.+i as f64*15.],end:[40.,20.+i as f64*15.]}).collect();
  for (alignment,expected) in [(Alignment::Left,10.),(Alignment::Center,16.5),(Alignment::Right,23.)] {
   let d=layout("AA",&guides,0,1.,0.,100.,100.,TextJitter::default(),None,&Paragraph{indent_mm:0.,alignment},letter).unwrap();
   assert_eq!(d.strokes[0][0].x,expected);
  }
  let d=layout("AAAA\nAA",&guides,0,1.,0.,100.,100.,TextJitter::default(),None,&Paragraph{indent_mm:0.,alignment:Alignment::Justify},letter).unwrap();
  assert_eq!(d.strokes.iter().map(|s|s[0].x).collect::<Vec<_>>(),vec![10.,21.,32.,10.,10.,19.]);
  let slanted=GuideLine{id:"slope".into(),start:[10.,20.],end:[40.,23.]};
  let d=layout("A",&[slanted],0,0.,0.,100.,100.,TextJitter::default(),None,&Paragraph{indent_mm:0.,alignment:Alignment::Right},letter).unwrap();
  assert!((d.strokes[0][1].x-(40.-2./1.01_f64.sqrt())).abs()<1e-8);
  assert!((d.strokes[0][1].y-(23.-0.2/1.01_f64.sqrt())).abs()<1e-8);
 }
 fn line(y:f64)->GuideLine{GuideLine{id:y.to_string(),start:[10.,y],end:[25.,y]}}
 fn letter(ch:char)->Result<Letter,String>{Ok(Letter{advance:8.,strokes:vec![vec![Point{x:0.,y:if ch=='A'{-8.}else{-4.}},Point{x:6.,y:0.}]]})}
 #[test]fn character_groups_split_strokes_per_glyph(){
  let guides:Vec<_>=(0..3).map(|i|GuideLine{id:i.to_string(),start:[10.,20.+i as f64*15.],end:[90.,20.+i as f64*15.]}).collect();
  let (doc,groups)=layout_with_groups("AB\nA",&guides,0,1.,0.,100.,100.,TextJitter::default(),None,&Paragraph::default(),letter).unwrap();
  assert_eq!(doc.strokes.len(),3);
  assert_eq!(groups,vec![1,2,3],"每个字一组，换行也另起一组");
 }
 #[test]fn character_rules_preserve_scope_spacing_and_seed(){
  use crate::text_rules::{RuleSet, CharacterRule};
  let request=RuleRequest{rule:RuleSet{id:"one".into(),name:"test".into(),general:CharacterRule{baseline:Some(2.),left:Some(1.),right:Some(1.),..Default::default()},overrides:vec![],first_offset:[3.;2],wave_amplitude:[2.;2],wave_length:[4.;2]},selection:Some([1,2])};
  let guide=GuideLine{id:"1".into(),start:[10.,20.],end:[90.,20.]};
  let render=||layout("AAA",&[guide.clone()],0,1.,0.,100.,100.,TextJitter::default(),Some(&request),&Paragraph::default(),letter).unwrap();
  let a=render();assert_eq!(a.strokes,render().strokes);
  assert_eq!(a.strokes[0][1],Point{x:16.,y:20.});
  assert_eq!(a.strokes[1][1],Point{x:26.,y:18.});
  assert_eq!(a.strokes[2][1],Point{x:36.,y:20.});
 }
 #[test]
 #[cfg(not(feature = "private-gfont"))]
 fn public_build_rejects_private_font_before_loading_files(){
  let options=TextOptions{font_mode:"legacy".into(),path:String::new(),selections:vec![FontSelection{path:"must-not-be-read.gfont".into(),weight:1.}],text:"A".into(),size_mm:10.,spacing_mm:1.,guide_lines:vec![line(20.)],start_line:0,baseline_offset_mm:0.,legacy_baseline:1.,legacy_percent:100.,legacy_seed:1,centerline:false,options:ImportOptions::default(),width_mm:100.,height_mm:100.,space_mm:None,auto_baseline:false,stroke_variation:None,stroke_tip:None,jitter:TextJitter::default(),rules:None,paragraph:Paragraph::default()};
  assert!(!crate::commands::private_gfont_available());
  assert!(compose(&options).unwrap_err().contains("此版本不支持"));
 }
 #[test]fn real_baselines_and_nonuniform_rows(){let d=layout("AB\nA",&[line(20.),line(31.),line(48.)],0,1.,0.5,100.,100.,TextJitter::default(),None,&Paragraph::default(),letter).unwrap();assert_eq!(d.strokes[0][1].y,19.5);assert_eq!(d.strokes[1][1].y,30.5);assert_eq!(d.strokes[2][1].y,47.5);assert_eq!(d.strokes[0][0].y,11.5);assert_eq!(d.strokes[1][0].y,26.5);}
 #[test]fn negative_side_bearings_tighten_spacing_and_stay_on_page(){
  let request=RuleRequest{rule:crate::text_rules::RuleSet{id:"one".into(),name:"test".into(),general:crate::text_rules::CharacterRule{left:Some(-2.),right:Some(-1.),..Default::default()},overrides:vec![],first_offset:[0.;2],wave_amplitude:[0.;2],wave_length:[20.;2]},selection:None};
  let guide=GuideLine{id:"one".into(),start:[10.,20.],end:[90.,20.]};
  let d=layout("AA",&[guide],0,1.,0.,100.,100.,TextJitter::default(),Some(&request),&Paragraph::default(),letter).unwrap();
  assert_eq!(d.strokes[0][0].x,8.);assert_eq!(d.strokes[1][0].x,14.);
  let edge=GuideLine{id:"edge".into(),start:[0.,20.],end:[90.,20.]};
  let d=layout("AA",&[edge],0,1.,0.,100.,100.,TextJitter::default(),Some(&request),&Paragraph::default(),letter).unwrap();
  assert!(d.strokes.iter().flatten().all(|p|p.x>=0. && p.x<=100.));
 }
 #[test]fn overflow_is_error_not_dropped_text(){assert!(layout("AAA",&[line(20.)],0,1.,0.,100.,100.,TextJitter::default(),None,&Paragraph::default(),letter).is_err());}
 #[test]fn jitter_keeps_rows_in_page_and_rejects_oversized_ink(){
  let jitter=TextJitter{x_mm:2.,y_mm:2.,rotation_deg:10.,scale_percent:30.,..Default::default()};
  let a=layout("AA",&[line(2.),line(20.)],0,1.,0.,100.,100.,jitter,None,&Paragraph::default(),letter).unwrap();
  let b=layout("AA",&[line(2.),line(20.)],0,1.,0.,100.,100.,jitter,None,&Paragraph::default(),letter).unwrap();
  assert_eq!(a.strokes,b.strokes);
  assert!(a.strokes.iter().flatten().all(|p|p.x>=0.&&p.y>=0.&&p.x<=100.&&p.y<=100.));
  assert!(layout("A",&[line(20.)],0,1.,0.,1.,1.,jitter,None,&Paragraph::default(),letter).is_err());
 }
 #[test]fn slanted_line_rotates_whole_glyph(){let g=GuideLine{id:"a".into(),start:[10.,20.],end:[110.,30.]};let d=layout("A",&[g],0,0.,0.,200.,100.,TextJitter::default(),None,&Paragraph::default(),letter).unwrap();assert!((d.strokes[0][1].y-(20.+6./10100_f64.sqrt()*10.)).abs()<1e-6);}
 #[test]fn first_nonempty_row_fits_inside_page_without_rejecting(){let d=layout("A",&[line(20.),line(2.)],1,0.,0.,100.,100.,TextJitter::default(),None,&Paragraph::default(),letter).unwrap();assert!(d.strokes.iter().flatten().all(|p|p.y>=0.&&p.y<=100.));}

 fn word_guides(n:usize)->Vec<GuideLine>{(0..n).map(|i|GuideLine{id:i.to_string(),start:[10.,20.+i as f64*15.],end:[60.,20.+i as f64*15.]}).collect()}
 fn word_letter(ch:char)->Result<Letter,String>{
  if ch.is_whitespace(){return Ok(Letter{advance:4.,strokes:vec![]});}
  Ok(Letter{advance:8.,strokes:vec![vec![Point{x:0.,y:-4.},Point{x:6.,y:0.}]]})
 }
 #[test]fn english_word_moves_to_next_line_instead_of_splitting(){
  let d=layout("abc def",&word_guides(3),0,1.,0.,100.,100.,TextJitter::default(),None,&Paragraph::default(),word_letter).unwrap();
  assert_eq!(d.strokes.len(),6);
  assert_eq!(d.strokes.iter().filter(|s|(s[0].y-16.).abs()<1e-8).count(),3,"第一行只留 abc");
  assert_eq!(d.strokes.iter().filter(|s|(s[0].y-31.).abs()<1e-8).count(),3,"def 整体移到第二行");
  assert!((d.strokes[3][0].x-10.).abs()<1e-8,"单词从新行行首开始");
 }
 #[test]fn chinese_without_spaces_still_wraps_by_character(){
  let d=layout("一二三四五六七",&word_guides(3),0,1.,0.,100.,100.,TextJitter::default(),None,&Paragraph::default(),word_letter).unwrap();
  assert_eq!(d.strokes.len(),7);
  assert_eq!(d.strokes.iter().filter(|s|(s[0].y-16.).abs()<1e-8).count(),5);
  assert_eq!(d.strokes.iter().filter(|s|(s[0].y-31.).abs()<1e-8).count(),2);
 }
 #[test]fn a_single_word_longer_than_a_line_falls_back_to_character_wrap(){
  let d=layout("abcdefghij",&word_guides(3),0,1.,0.,100.,100.,TextJitter::default(),None,&Paragraph::default(),word_letter).unwrap();
  assert_eq!(d.strokes.len(),10);
  assert_eq!(d.strokes.iter().filter(|s|(s[0].y-16.).abs()<1e-8).count(),5,"行首超长词不清空第一行");
  assert_eq!(d.strokes.iter().filter(|s|(s[0].y-31.).abs()<1e-8).count(),5);
 }
}
