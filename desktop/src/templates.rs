//! Open template interface: local providers now; MCP adapters can implement it later.
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: String,
    pub width_mm: f64,
    pub height_mm: f64,
    pub margin_mm: f64,
    pub font_size_mm: f64,
    pub letter_spacing_mm: f64,
    pub lines: usize,
}

pub trait TemplateProvider {
    fn list(&self) -> Result<Vec<Template>, String>;
}

pub struct TemplateStore {
    directory: PathBuf,
}
impl TemplateStore {
    pub fn new() -> Self {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        Self {
            directory: base.join("OpenInkStudio").join("templates"),
        }
    }
    pub(crate) fn validate(t: &Template) -> Result<(), String> {
        if t.id.is_empty()
            || t.id.len() > 96
            || !t
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("模板ID仅允许英文字母、数字、下划线和短横线".into());
        }
        if t.name.trim().is_empty()
            || ![
                t.width_mm,
                t.height_mm,
                t.margin_mm,
                t.font_size_mm,
                t.letter_spacing_mm,
            ]
            .iter()
            .all(|v| v.is_finite())
            || t.width_mm <= 0.
            || t.height_mm <= 0.
            || t.width_mm > 1000.
            || t.height_mm > 1000.
            || t.margin_mm < 0.
            || t.margin_mm * 2. >= t.width_mm.min(t.height_mm)
            || t.font_size_mm <= 0.
            || t.letter_spacing_mm < 0.
            || t.lines == 0
            || t.lines > 1000
        {
            return Err("模板尺寸、边距或文字参数无效".into());
        }
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<Template>, String> {
        <Self as TemplateProvider>::list(self)
    }
    pub fn save(&self, t: &Template) -> Result<(), String> {
        Self::validate(t)?;
        if t.id.starts_with("builtin-") {
            return Err("请另存为自定义模板".into());
        }
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(t).map_err(|e| e.to_string())?;
        fs::write(self.directory.join(format!("{}.json", t.id)), bytes).map_err(|e| e.to_string())
    }
    pub fn delete(&self, id: &str) -> Result<(), String> {
        if id.starts_with("builtin-")
            || id.is_empty()
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("不能删除内置模板或非法ID".into());
        }
        fs::remove_file(self.directory.join(format!("{id}.json"))).map_err(|e| e.to_string())
    }
}
impl TemplateProvider for TemplateStore {
    fn list(&self) -> Result<Vec<Template>, String> {
        let mut items = vec![
            Template {
                id: "builtin-note".into(),
                name: "日常笔记".into(),
                description: "160 × 190 mm / 适合常规书写".into(),
                width_mm: 160.,
                height_mm: 190.,
                margin_mm: 8.,
                font_size_mm: 7.5,
                letter_spacing_mm: 1.,
                lines: 18,
            },
            Template {
                id: "builtin-square".into(),
                name: "方形画布".into(),
                description: "190 × 190 mm / 插画与自由排版".into(),
                width_mm: 190.,
                height_mm: 190.,
                margin_mm: 8.,
                font_size_mm: 10.,
                letter_spacing_mm: 1.,
                lines: 15,
            },
            Template {
                id: "builtin-a4".into(),
                name: "A4 文档".into(),
                description: "210 × 297 mm / 排版预览；实际轨迹需在设备范围内".into(),
                width_mm: 210.,
                height_mm: 297.,
                margin_mm: 15.,
                font_size_mm: 7.5,
                letter_spacing_mm: 1.,
                lines: 24,
            },
        ];
        if self.directory.exists() {
            for entry in fs::read_dir(&self.directory).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                let data = fs::read(&path).map_err(|e| e.to_string())?;
                let template: Template = serde_json::from_slice(&data)
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                Self::validate(&template)?;
                if !template.id.starts_with("builtin-") {
                    items.push(template)
                }
            }
        }
        Ok(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_path_traversal_and_invalid_layout() {
        let store = TemplateStore {
            directory: std::env::temp_dir().join("unused-openink-test"),
        };
        let mut t = store.list().unwrap()[0].clone();
        t.id = "../escape".into();
        assert!(store.save(&t).is_err());
        t.id = "test".into();
        t.margin_mm = 1000.;
        assert!(TemplateStore::validate(&t).is_err());
        assert!(store.delete("../escape").is_err());
    }
}
