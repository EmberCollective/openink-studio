use crate::positioning::Registration;
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegistrationProfile {
    pub id: String,
    pub name: String,
    pub width_mm: f64,
    pub height_mm: f64,
    pub point1: [f64; 2],
    pub point2: [f64; 2],
    pub scale: f64,
    pub rotation_deg: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matrix: Option<[f64;4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point3: Option<[f64;2]>,
}

impl RegistrationProfile {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() || self.id.len() > 96 || !self.id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
            return Err("校准方案 ID 无效".into());
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 100 {
            return Err("请输入 1–100 字的校准方案名称".into());
        }
        if ![self.width_mm, self.height_mm].iter().all(|v| v.is_finite() && *v > 0.) {
            return Err("校准纸张尺寸无效".into());
        }
        for p in [Some(self.point1), Some(self.point2), self.point3].into_iter().flatten() {
            if !p.iter().all(|v| v.is_finite()) || p[0] < 0. || p[1] < 0. || p[0] > self.width_mm || p[1] > self.height_mm {
                return Err("两个定位点必须在纸张内".into());
            }
        }
        if (self.point2[0] - self.point1[0]).hypot(self.point2[1] - self.point1[1]) < 100. {
            return Err("两个定位点至少相距 100 mm".into());
        }
        Registration { scale: self.scale, rotation_deg: self.rotation_deg, matrix: self.matrix }.validate()?;
        if self.matrix.is_some() && self.point3.is_none() { return Err("三点校准方案缺少第三点".into()); }
        if let Some(third) = self.point3 { Registration::validate_three_points(self.point1,self.point2,third)?; }
        Ok(())
    }
}

fn directory() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
        .join("OpenInkStudio").join("registration-profiles")
}

fn save_at(directory: &Path, profile: &RegistrationProfile) -> Result<(), String> {
    profile.validate()?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let path = directory.join(format!("{}.json", profile.id));
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let temporary = directory.join(format!("{}.{}.{nonce}.tmp", profile.id, std::process::id()));
    let data = serde_json::to_vec_pretty(profile).map_err(|e| e.to_string())?;
    fs::write(&temporary, data).map_err(|e| e.to_string())?;
    fs::rename(&temporary, &path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("保存校准方案失败：{e}")
    })
}

fn list_at(directory: &Path) -> Result<Vec<RegistrationProfile>, String> {
    if !directory.exists() { return Ok(vec![]); }
    let mut profiles = vec![];
    for item in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let profile: RegistrationProfile = serde_json::from_slice(&bytes)
            .map_err(|e| format!("校准方案 {} 损坏：{e}", path.display()))?;
        profile.validate()?;
        profiles.push(profile);
    }
    profiles.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    Ok(profiles)
}

#[tauri::command]
pub fn list_registration_profiles() -> Result<Vec<RegistrationProfile>, String> {
    list_at(&directory())
}

#[tauri::command]
pub fn save_registration_profile(profile: RegistrationProfile) -> Result<(), String> {
    save_at(&directory(), &profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> RegistrationProfile {
        RegistrationProfile { id: "test-profile".into(), name: "A4 表格".into(), width_mm: 210., height_mm: 297., point1: [195., 15.], point2: [15., 282.], scale: 0.98, rotation_deg: 1.2, matrix: None, point3: None }
    }
    #[test]
    fn saved_profile_reloads_without_machine_session_coordinates() {
        let directory = std::env::temp_dir().join(format!("openink-registration-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let mut profile = profile();
        save_at(&directory, &profile).unwrap();
        profile.scale = 0.99;
        save_at(&directory, &profile).unwrap();
        let loaded = list_at(&directory).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].scale, 0.99);
        assert_eq!(loaded[0].point1, profile.point1);
        let json = serde_json::to_string(&loaded[0]).unwrap();
        assert!(!json.contains("wco") && !json.contains("position"));
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn profiles_reject_unsafe_names_close_points_and_invalid_geometry() {
        let mut p = profile();
        p.id = "../escape".into(); assert!(p.validate().is_err());
        p = profile(); p.point2 = [190., 20.]; assert!(p.validate().is_err());
        p = profile(); p.point1[0] = 211.; assert!(p.validate().is_err());
        p = profile(); p.scale = f64::NAN; assert!(p.validate().is_err());
        p = profile(); p.rotation_deg = f64::INFINITY; assert!(p.validate().is_err());
    }
    #[test]
    fn optional_three_point_profile_roundtrips_and_legacy_remains_readable() {
        let legacy=serde_json::to_value(profile()).unwrap();
        assert!(legacy.get("matrix").is_none());
        let mut p:RegistrationProfile=serde_json::from_value(legacy).unwrap();
        p.point3=Some([15.,15.]); p.matrix=Some([1.1,0.,0.,0.9]);p.validate().unwrap();
        let restored:RegistrationProfile=serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(restored.point3,p.point3);assert_eq!(restored.matrix,p.matrix);
        p.point3=Some([194.,16.]);assert!(p.validate().is_err());
        p.point3=None;assert!(p.validate().is_err());
    }
}
