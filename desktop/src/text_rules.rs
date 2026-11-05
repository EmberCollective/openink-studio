use crate::model::{Stroke, TextJitter};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CharacterRule {
    pub size: Option<[f64; 2]>,
    pub spacing: Option<[f64; 2]>,
    pub rotation: Option<[f64; 2]>,
    pub stretch_x: Option<[f64; 2]>,
    pub stretch_y: Option<[f64; 2]>,
    pub vertical: Option<[f64; 2]>,
    pub horizontal: Option<[f64; 2]>,
    pub baseline: Option<f64>,
    pub left: Option<f64>,
    pub right: Option<f64>,
}
impl CharacterRule {
    fn validate(&self) -> Result<(), String> {
        for (value, min, max) in [(self.size,50.,150.),(self.spacing,0.,200.),(self.rotation,-180.,180.),
            (self.stretch_x,50.,150.),(self.stretch_y,50.,150.),(self.vertical,-20.,20.),(self.horizontal,-20.,20.)] {
            if let Some(v)=value { interval(v,min,max)?; }
        }
        for (value,min) in [(self.baseline,-20.),(self.left,-20.),(self.right,-20.)] {
            if value.is_some_and(|v| !v.is_finite() || v<min || v>20.) {return Err("基准线或留白范围无效".into());}
        }
        Ok(())
    }
    fn inherit(&self, base:&Self)->Self {
        Self{size:self.size.or(base.size),spacing:self.spacing.or(base.spacing),rotation:self.rotation.or(base.rotation),
            stretch_x:self.stretch_x.or(base.stretch_x),stretch_y:self.stretch_y.or(base.stretch_y),vertical:self.vertical.or(base.vertical),
            horizontal:self.horizontal.or(base.horizontal),baseline:self.baseline.or(base.baseline),left:self.left.or(base.left),right:self.right.or(base.right)}
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CharacterOverride { pub characters:String, pub settings:CharacterRule }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleSet {
    pub id:String, pub name:String, pub general:CharacterRule, pub overrides:Vec<CharacterOverride>,
    pub first_offset:[f64;2], pub wave_amplitude:[f64;2], pub wave_length:[f64;2],
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleRequest { pub rule:RuleSet, pub selection:Option<[usize;2]> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleLibrary { pub rules:Vec<RuleSet>, pub selected:String }
impl RuleLibrary {
    pub fn validate(&self)->Result<(),String>{
        let ids:std::collections::HashSet<_>=self.rules.iter().map(|r|r.id.as_str()).collect();
        if self.rules.len()>50 || ids.len()!=self.rules.len() || (!self.selected.is_empty() && !ids.contains(self.selected.as_str())) {return Err("字体规则集数量、标识或选择无效".into());}
        for rule in &self.rules {rule.validate()?;}
        Ok(())
    }
}
fn interval(v:[f64;2],min:f64,max:f64)->Result<(),String>{
    if v.iter().any(|n|!n.is_finite()) || v[0]<min || v[1]>max || v[0]>v[1] {Err("规则范围无效：下限不能大于上限".into())}else{Ok(())}
}
impl RuleSet {
    pub fn validate(&self)->Result<(),String>{
        if self.id.is_empty() || self.id.len()>100 || self.name.trim().is_empty() || self.name.chars().count()>80 || self.overrides.len()>100 {return Err("规则名称或数量无效".into());}
        self.general.validate()?;
        let mut chars=std::collections::HashSet::new();
        for entry in &self.overrides {
            if entry.characters.is_empty() || entry.characters.chars().count()>500 {return Err("请输入适用字符（最多 500 个）".into());}
            for ch in entry.characters.chars(){if ch.is_control() || !chars.insert(ch){return Err("字符规则重复或包含换行".into());}}
            entry.settings.validate()?;
        }
        interval(self.first_offset,0.,20.)?; interval(self.wave_amplitude,0.,20.)?; interval(self.wave_length,1.,500.)
    }
}
impl RuleRequest {
    pub fn validate(&self,text:&str)->Result<(),String>{
        self.rule.validate()?;
        if self.selection.is_some_and(|[a,b]|a>=b || b>text.chars().count()){return Err("文字选区已失效，请重新选择".into());}
        Ok(())
    }
    pub fn settings(&self,ch:char,index:usize)->CharacterRule {
        if self.selection.is_some_and(|[a,b]|index<a || index>=b){return CharacterRule::default();}
        self.rule.overrides.iter().find(|r|r.characters.contains(ch)).map(|r|r.settings.inherit(&self.rule.general)).unwrap_or_else(||self.rule.general.clone())
    }
}
pub struct RuleRandom(pub u64);
impl RuleRandom {
    pub fn sample(&mut self,[lo,hi]:[f64;2])->f64{
        self.0=self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z=self.0;z=(z^(z>>30)).wrapping_mul(0xbf58476d1ce4e5b9);z=(z^(z>>27)).wrapping_mul(0x94d049bb133111eb);
        lo+((z^(z>>31))>>11) as f64/(1u64<<53) as f64*(hi-lo)
    }
    pub fn apply(&mut self,r:&CharacterRule,strokes:&mut [Stroke])->f64{
        let size=self.sample(r.size.unwrap_or([100.;2]))-100.;
        let sx=self.sample(r.stretch_x.unwrap_or([100.;2]))-100.;
        let sy=self.sample(r.stretch_y.unwrap_or([100.;2]))-100.;
        let angle=self.sample(r.rotation.unwrap_or([0.;2]));
        let vertical=self.sample(r.vertical.unwrap_or([0.;2]))-r.baseline.unwrap_or(0.);
        TextJitter{scale_percent:size,scale_percent_min:Some(size),scale_x_percent:sx,scale_x_percent_min:Some(sx),scale_y_percent:sy,scale_y_percent_min:Some(sy),rotation_deg:angle,rotation_deg_min:Some(angle),y_mm:vertical,y_mm_min:Some(vertical),..Default::default()}.apply(strokes);
        self.sample(r.spacing.unwrap_or([100.;2]))/100.
    }
}
#[cfg(test)]mod tests{
    use super::*;use crate::model::Point;
    fn rule()->RuleSet{RuleSet{id:"a".into(),name:"normal".into(),general:CharacterRule::default(),overrides:vec![],first_offset:[0.;2],wave_amplitude:[0.;2],wave_length:[20.;2]}}
    #[test]fn scope_and_override_and_baseline(){
        let mut r=rule();r.general.rotation=Some([5.;2]);r.overrides.push(CharacterOverride{characters:"A".into(),settings:CharacterRule{baseline:Some(2.),..Default::default()}});
        let request=RuleRequest{rule:r,selection:Some([1,2])};request.validate("AA").unwrap();
        assert_eq!(request.settings('A',0).rotation,None);assert_eq!(request.settings('A',1).rotation,Some([5.;2]));
        let mut strokes=vec![vec![Point{x:0.,y:0.},Point{x:2.,y:0.}]];
        RuleRandom(1).apply(&CharacterRule{baseline:Some(2.),..Default::default()},&mut strokes);assert_eq!(strokes[0][0].y,-2.);
    }
    #[test]fn rejects_bad_ranges_duplicates_and_selection(){
        let mut r=rule();r.general.size=Some([110.,90.]);assert!(r.validate().is_err());r.general.size=None;
        r.overrides.push(CharacterOverride{characters:"AA".into(),settings:CharacterRule::default()});assert!(r.validate().is_err());
        assert!(RuleRequest{rule:rule(),selection:Some([1,3])}.validate("A😀").is_err());
    }
}
