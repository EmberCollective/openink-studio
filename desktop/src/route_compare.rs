use crate::{
    device::{self, Job},
    model::{Document, Point},
    route_opt, stroke_merge, stroke_refine,
};
use serde::Serialize;
use std::{collections::BTreeMap, time::Instant};

#[derive(Serialize)]
pub struct Variant {
    pub id: String,
    pub label: String,
    pub document: Document,
    pub stroke_owners: Vec<String>,
    pub strokes: usize,
    pub draw_mm: f64,
    pub travel_mm: f64,
    pub z_mm: f64,
    pub estimated_seconds: f64,
    pub compute_ms: f64,
    pub geometry_preserved: bool,
    pub coverage_preserved: bool,
    pub added_bridges: Vec<Vec<Point>>,
    pub removed_overlap_mm: f64,
    pub savings_percent: f64,
    pub eligible: bool,
}
#[derive(Serialize)]
pub struct Comparison {
    pub variants: Vec<Variant>,
    pub recommended: String,
}

pub struct Options {
    pub max_gap_mm: f64,
    pub deduplicate: bool,
    pub trajectory_enabled: bool,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            max_gap_mm: 0.,
            deduplicate: false,
            trajectory_enabled: true,
        }
    }
}
fn worth_recommending(baseline: f64, candidate: f64) -> bool {
    baseline.is_finite()
        && candidate.is_finite()
        && baseline > 0.
        && candidate >= 0.
        && candidate <= baseline * 0.95
}

fn point_key(p: Point) -> (u64, u64) {
    (
        if p.x == 0. { 0 } else { p.x.to_bits() },
        if p.y == 0. { 0 } else { p.y.to_bits() },
    )
}
// Exact segment multiset catches missing ink, added bridges and repeated drawing.
fn ink(d: &Document) -> BTreeMap<((u64, u64), (u64, u64)), usize> {
    let mut result = BTreeMap::new();
    for s in &d.strokes {
        for pair in s.windows(2) {
            let a = point_key(pair[0]);
            let b = point_key(pair[1]);
            if a != b {
                *result
                    .entry(if a < b { (a, b) } else { (b, a) })
                    .or_default() += 1;
            }
        }
    }
    result
}

fn measure(job: &Job, start: Option<Point>) -> Result<(f64, f64, f64, f64), String> {
    let lines = device::build_job(job, [0.; 3])?;
    let profile = crate::job_timing::profile(&lines, [0.; 3])?;
    let draw = profile.draw_mm;
    let mut travel = profile.travel_mm;
    let z = profile.z_mm;
    let mut seconds = profile.total_seconds;
    if let Some(start) = start {
        let first = job.document.strokes.iter().find(|s| s.len() > 1).unwrap()[0];
        let initial = (first.x - start.x).hypot(first.y - start.y);
        travel += initial;
        seconds += initial / job.travel_feed * 60.;
    }
    if !seconds.is_finite() {
        return Err("Estimated duration is not finite".into());
    }
    Ok((draw, travel, z, seconds))
}

#[cfg(test)]
pub fn compare(
    job: Job,
    start: Option<Point>,
    allow_reverse: bool,
    official_baseline: bool,
    owners: Vec<String>,
) -> Result<Comparison, String> {
    compare_with_options(
        job,
        start,
        allow_reverse,
        official_baseline,
        owners,
        Options::default(),
    )
}

pub fn compare_with_options(
    job: Job,
    start: Option<Point>,
    allow_reverse: bool,
    official_baseline: bool,
    mut owners: Vec<String>,
    options: Options,
) -> Result<Comparison, String> {
    if !options.max_gap_mm.is_finite() || !(0.0..=1.0).contains(&options.max_gap_mm) {
        return Err("连接距离必须在0–1 mm范围内".into());
    }
    if start.is_some_and(|p| !p.x.is_finite() || !p.y.is_finite()) {
        return Err("Start coordinates must be finite".into());
    }
    if owners.is_empty() {
        owners = vec![String::new(); job.document.strokes.len()];
    }
    if owners.len() != job.document.strokes.len() {
        return Err("Material ownership does not match paths".into());
    }
    let reference = ink(&job.document);
    let make = |id: &str,
                label: &str,
                document: Document,
                stroke_owners: Vec<String>,
                ms: f64|
     -> Result<Variant, String> {
        let geometry_preserved = reference == ink(&document);
        let coverage_preserved =
            geometry_preserved || stroke_refine::covers(&job.document, &document);
        let (draw_mm, travel_mm, z_mm, estimated_seconds) = measure(
            &Job {
                document: document.clone(),
                ..job.clone()
            },
            start,
        )?;
        Ok(Variant {
            id: id.into(),
            label: label.into(),
            strokes: document.strokes.iter().filter(|s| s.len() > 1).count(),
            document,
            stroke_owners,
            draw_mm,
            travel_mm,
            z_mm,
            estimated_seconds,
            compute_ms: ms,
            geometry_preserved,
            coverage_preserved,
            added_bridges: vec![],
            removed_overlap_mm: 0.,
            savings_percent: 0.,
            eligible: false,
        })
    };
    let original = make(
        "original",
        if official_baseline {
            "官方原始笔顺"
        } else {
            "原始拟合"
        },
        job.document.clone(),
        owners.clone(),
        0.,
    )?;
    let timer = Instant::now();
    let current = route_opt::optimize(&job.document, start, allow_reverse, job.travel_feed)?;
    let current_ms = timer.elapsed().as_secs_f64() * 1000.;
    let current_owners = current
        .stroke_order
        .iter()
        .map(|&i| owners[i].clone())
        .collect();
    let current = make(
        "current",
        "当前路径优化",
        current.document,
        current_owners,
        current_ms,
    )?;
    let timer = Instant::now();
    let mut groups: Vec<(String, Document)> = vec![];
    for (stroke, owner) in job.document.strokes.iter().zip(&owners) {
        let index = groups
            .iter()
            .position(|(id, _)| id == owner)
            .unwrap_or_else(|| {
                groups.push((
                    owner.clone(),
                    Document {
                        strokes: vec![],
                        ..job.document.clone()
                    },
                ));
                groups.len() - 1
            });
        groups[index].1.strokes.push(stroke.clone());
    }
    let mut merged = Document {
        strokes: vec![],
        ..job.document.clone()
    };
    let mut merged_owners = vec![];
    for (owner, group) in &groups {
        let result = stroke_merge::merge(&group, allow_reverse)?;
        merged_owners.extend(std::iter::repeat_n(owner.clone(), result.strokes.len()));
        merged.strokes.extend(result.strokes);
    }
    let merged = route_opt::optimize(&merged, start, allow_reverse, job.travel_feed)?;
    let merged_ms = timer.elapsed().as_secs_f64() * 1000.;
    let merged_owners = merged
        .stroke_order
        .iter()
        .map(|&i| merged_owners[i].clone())
        .collect();
    let merged = make(
        "merged",
        "连续笔画合并",
        merged.document,
        merged_owners,
        merged_ms,
    )?;
    let mut variants = vec![original, current, merged];
    if options.max_gap_mm > 0. || options.deduplicate {
        let timer = Instant::now();
        let mut refined = Document {
            strokes: vec![],
            ..job.document.clone()
        };
        let mut refined_owners = vec![];
        let mut bridges = vec![];
        let mut removed = 0.;
        for (owner, group) in &groups {
            let result = stroke_refine::refine(
                group,
                allow_reverse,
                job.feed,
                job.travel_feed,
                job.z_feed,
                job.z_down,
                options.max_gap_mm,
                options.deduplicate,
            )?;
            refined_owners.extend(std::iter::repeat_n(
                owner.clone(),
                result.document.strokes.len(),
            ));
            refined.strokes.extend(result.document.strokes);
            bridges.extend(result.added_bridges);
            removed += result.removed_overlap_mm;
        }
        let optimized = route_opt::optimize(&refined, start, allow_reverse, job.travel_feed)?;
        let optimized_owners = optimized
            .stroke_order
            .iter()
            .map(|&i| refined_owners[i].clone())
            .collect();
        let mut variant = make(
            "aggressive",
            "加权连笔与重叠去重",
            optimized.document,
            optimized_owners,
            timer.elapsed().as_secs_f64() * 1000.,
        )?;
        variant.added_bridges = bridges;
        variant.removed_overlap_mm = removed;
        variants.push(variant);
    }
    let baseline_index = if options.trajectory_enabled { 1 } else { 0 };
    let baseline = variants[baseline_index].estimated_seconds;
    for v in &mut variants {
        v.savings_percent = if baseline > 0. {
            (baseline - v.estimated_seconds) / baseline * 100.
        } else {
            0.
        };
        v.eligible = matches!(v.id.as_str(), "merged" | "aggressive")
            && v.coverage_preserved;
    }
    let recommended = variants
        .iter()
        .filter(|v| v.eligible && worth_recommending(baseline, v.estimated_seconds))
        .min_by(|a, b| a.estimated_seconds.total_cmp(&b.estimated_seconds))
        .map_or_else(|| variants[baseline_index].id.clone(), |v| v.id.clone());
    Ok(Comparison {
        variants,
        recommended,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn five_percent_recommendation_is_against_selected_live_baseline() {
        assert!(!worth_recommending(100., 95.01));
        assert!(worth_recommending(100., 95.));
        assert!(worth_recommending(100., 94.99));
        assert!(!worth_recommending(0., 0.));
        assert!(!worth_recommending(f64::INFINITY, 1.));
        let mut j = job();
        j.z_feed = 3000.;
        j.document.strokes = vec![
            vec![Point { x: 0., y: 0. }, Point { x: 1., y: 0. }],
            vec![Point { x: 100., y: 0. }, Point { x: 101., y: 0. }],
            vec![Point { x: 1.1, y: 0. }, Point { x: 2., y: 0. }],
        ];
        let make = |enabled| {
            compare_with_options(
                j.clone(),
                None,
                true,
                false,
                vec![],
                Options {
                    max_gap_mm: 0.3,
                    deduplicate: false,
                    trajectory_enabled: enabled,
                },
            )
            .unwrap()
        };
        let enabled = make(true);
        let disabled = make(false);
        assert_eq!(enabled.variants[1].savings_percent, 0.);
        assert_eq!(disabled.variants[0].savings_percent, 0.);
        assert!(disabled.variants[3].savings_percent > enabled.variants[3].savings_percent);
        assert!(enabled.variants[3].coverage_preserved);
        assert!(!enabled.variants[3].geometry_preserved);
        assert!(!enabled.variants[3].added_bridges.is_empty());
    }
    #[test]
    fn aggressive_connections_cannot_cross_materials() {
        let mut j = job();
        j.document.strokes[1][0].x = 10.1;
        let options = Options {
            max_gap_mm: 0.3,
            deduplicate: true,
            trajectory_enabled: true,
        };
        let r = compare_with_options(j, None, true, false, vec!["a".into(), "b".into()], options)
            .unwrap();
        assert!(r.variants[3].added_bridges.is_empty());
        assert_eq!(r.variants[3].strokes, 2);
        assert!(r.variants[3].eligible);
        assert!(r.variants[3].savings_percent < 5.);
        assert_eq!(r.recommended,"current");
        assert!(compare_with_options(
            job(),
            None,
            true,
            false,
            vec![],
            Options {
                max_gap_mm: 1.01,
                ..Options::default()
            }
        )
        .is_err());
    }
    fn job() -> Job {
        Job {
            document: Document {
                name: "test".into(),
                width_mm: 100.,
                height_mm: 100.,
                strokes: vec![
                    vec![Point { x: 0., y: 0. }, Point { x: 10., y: 0. }],
                    vec![Point { x: 10., y: 0. }, Point { x: 20., y: 0. }],
                ],
            },
            feed: 1500.,
            travel_feed: 2500.,
            z_feed: 300.,
            z_down: 4.,
        }
    }
    #[test]
    fn complete_time_includes_z_and_preserves_ink() {
        let r = compare(job(), None, true, false, vec![]).unwrap();
        assert_eq!(r.variants[0].strokes, 2);
        assert_eq!(r.variants[2].strokes, 1);
        assert!((r.variants[0].estimated_seconds - 4.).abs() < 1e-8);
        assert!((r.variants[2].estimated_seconds - 2.4).abs() < 1e-8);
        assert!(r.variants.iter().all(|v| v.geometry_preserved));
        assert_eq!(r.recommended, "merged");
    }
    #[test]
    fn materials_are_not_joined_and_invalid_depth_rejected() {
        let r = compare(job(), None, true, false, vec!["a".into(), "b".into()]).unwrap();
        assert_eq!(r.variants[2].strokes, 2);
        let mut j = job();
        j.z_down = 11.;
        assert!(compare(j, None, true, false, vec![]).is_err());
        let mut d = job().document;
        d.strokes.pop();
        assert_ne!(ink(&d), ink(&job().document));
    }

    #[test]
    #[ignore = "Offline benchmark needs local PDF, Python and AutoTrace"]
    fn actual_pdf_and_official_gfont_comparison() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut samples = Vec::new();
        for page in [1, 2] {
            let mut document = crate::import::import_file(
                &root.join("inko-inko.pdf"),
                &crate::import::ImportOptions {
                    page,
                    ..Default::default()
                },
            )
            .unwrap();
            let min_x = document
                .strokes
                .iter()
                .flatten()
                .map(|p| p.x)
                .fold(f64::INFINITY, f64::min);
            let min_y = document
                .strokes
                .iter()
                .flatten()
                .map(|p| p.y)
                .fold(f64::INFINITY, f64::min);
            let max_x = document
                .strokes
                .iter()
                .flatten()
                .map(|p| p.x)
                .fold(f64::NEG_INFINITY, f64::max);
            let max_y = document
                .strokes
                .iter()
                .flatten()
                .map(|p| p.y)
                .fold(f64::NEG_INFINITY, f64::max);
            let scale = (180. / (max_x - min_x).max(max_y - min_y)).min(1.);
            for p in document.strokes.iter_mut().flatten() {
                p.x = (p.x - min_x) * scale;
                p.y = (p.y - min_y) * scale;
            }
            document.width_mm = (max_x - min_x) * scale;
            document.height_mm = (max_y - min_y) * scale;
            samples.push((format!("PDF-page-{page}"), document, true, false));
        }
        #[cfg(feature = "private-gfont")]
        let legacy_gfont = root.join("fonts/Apollo_kvenjoy_Zl.gfont");
        #[cfg(feature = "private-gfont")]
        if legacy_gfont.exists() {
            // shortcut: gfont 仅本地保留；公开树无此文件时跳过该样本
            for text in ["永", "工实习"] {
                let composed = crate::legacy_font::compose(
                    &[crate::legacy_font::FontSelection {
                        path: legacy_gfont.to_string_lossy().into_owned(),
                        weight: 1.,
                    }],
                    text,
                    &crate::legacy_font::ComposeOptions::default(),
                )
                .unwrap();
                assert!(composed.missing.is_empty());
                samples.push((format!("Apollo-{text}"), composed.document, false, true));
            }
        }
        for (name, document, reverse, official) in samples {
            let endpoints: Vec<_> = document
                .strokes
                .iter()
                .enumerate()
                .flat_map(|(i, s)| s.first().into_iter().chain(s.last()).map(move |&p| (i, p)))
                .collect();
            let mut nearest = Vec::new();
            let mut interior_hits = 0;
            for &(owner, p) in &endpoints {
                nearest.push(
                    endpoints
                        .iter()
                        .filter(|(i, _)| *i != owner)
                        .map(|(_, q)| (p.x - q.x).hypot(p.y - q.y))
                        .fold(f64::INFINITY, f64::min),
                );
                interior_hits += document
                    .strokes
                    .iter()
                    .enumerate()
                    .filter(|(i, s)| *i != owner && s.len() > 2 && s[1..s.len() - 1].contains(&p))
                    .count();
            }
            nearest.sort_by(f64::total_cmp);
            let mut sorted_endpoints: Vec<_> = endpoints.iter().map(|&(_, p)| p).collect();
            sorted_endpoints.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
            sorted_endpoints.dedup();
            let mut segment_hits = 0;
            for s in &document.strokes {
                for pair in s.windows(2) {
                    let a = pair[0];
                    let b = pair[1];
                    let dx = b.x - a.x;
                    let dy = b.y - a.y;
                    let length = dx.hypot(dy);
                    if length == 0. {
                        continue;
                    }
                    let left = sorted_endpoints.partition_point(|p| p.x < a.x.min(b.x) - 1e-9);
                    let right = sorted_endpoints.partition_point(|p| p.x <= a.x.max(b.x) + 1e-9);
                    for &p in &sorted_endpoints[left..right] {
                        if p == a
                            || p == b
                            || p.y < a.y.min(b.y) - 1e-9
                            || p.y > a.y.max(b.y) + 1e-9
                        {
                            continue;
                        }
                        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (length * length);
                        if t > 0.
                            && t < 1.
                            && (p.x - a.x - t * dx).hypot(p.y - a.y - t * dy) <= 1e-9
                        {
                            segment_hits += 1;
                        }
                    }
                }
            }
            println!("SEGMENT_CONTACT {name} strict_interior_hits={segment_hits}");
            println!("CONTACT {name} endpoints={} internal_vertex_hits={} nearest_endpoint_median_mm={:.6} within_1e9={} within_001={} within_005={} within_01={} within_03={}", endpoints.len(), interior_hits, nearest[nearest.len()/2], nearest.iter().filter(|&&d|d<=1e-9).count(),nearest.iter().filter(|&&d|d<=0.01).count(), nearest.iter().filter(|&&d|d<=0.05).count(),nearest.iter().filter(|&&d|d<=0.1).count(),nearest.iter().filter(|&&d|d<=0.3).count());
            let result = compare(
                Job {
                    document,
                    feed: 1500.,
                    travel_feed: 2500.,
                    z_feed: 3000.,
                    z_down: 4.,
                },
                None,
                reverse,
                official,
                vec![],
            )
            .unwrap();
            for variant in &result.variants {
                assert!(
                    variant.geometry_preserved,
                    "{name}: {} changed geometry",
                    variant.id
                );
                println!("BENCH {name} {} strokes={} draw_mm={:.3} travel_mm={:.3} z_mm={:.3} estimated_s={:.3} compute_ms={:.3} geometry={} recommended={}",
                    variant.id, variant.strokes, variant.draw_mm, variant.travel_mm, variant.z_mm, variant.estimated_seconds, variant.compute_ms, variant.geometry_preserved, result.recommended);
            }
            assert!(result.variants[2].strokes <= result.variants[0].strokes);
        }
    }
    #[test]
    #[ignore = "Offline benchmark needs local PDF, Python and AutoTrace"]
    fn actual_pdf_aggressive_refinement_benchmark() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let out = root.join(".cache/refine-review");
        std::fs::create_dir_all(&out).unwrap();
        let mut results = Vec::new();
        let polylines = |paths: &[Vec<Point>], color: &str| -> String {
            paths.iter().filter(|s|s.len()>1).map(|s|format!("<polyline fill=\"none\" stroke=\"{color}\" stroke-width=\"0.08\" points=\"{}\"/>",s.iter().map(|p|format!("{},{}",p.x,p.y)).collect::<Vec<_>>().join(" "))).collect::<Vec<_>>().join("\n")
        };
        for page in [1, 2] {
            let mut document = crate::import::import_file(
                &root.join("inko-inko.pdf"),
                &crate::import::ImportOptions {
                    page,
                    ..Default::default()
                },
            )
            .unwrap();
            let min_x = document
                .strokes
                .iter()
                .flatten()
                .map(|p| p.x)
                .fold(f64::INFINITY, f64::min);
            let min_y = document
                .strokes
                .iter()
                .flatten()
                .map(|p| p.y)
                .fold(f64::INFINITY, f64::min);
            let max_x = document
                .strokes
                .iter()
                .flatten()
                .map(|p| p.x)
                .fold(f64::NEG_INFINITY, f64::max);
            let max_y = document
                .strokes
                .iter()
                .flatten()
                .map(|p| p.y)
                .fold(f64::NEG_INFINITY, f64::max);
            let scale = (180. / (max_x - min_x).max(max_y - min_y)).min(1.);
            for p in document.strokes.iter_mut().flatten() {
                p.x = (p.x - min_x) * scale;
                p.y = (p.y - min_y) * scale;
            }
            document.width_mm = (max_x - min_x) * scale;
            document.height_mm = (max_y - min_y) * scale;
            for gap in [0., 0.3, 0.6, 1.] {
                let result = compare_with_options(
                    Job {
                        document: document.clone(),
                        feed: 1500.,
                        travel_feed: 2500.,
                        z_feed: 3000.,
                        z_down: 4.,
                    },
                    None,
                    true,
                    false,
                    vec![],
                    Options {
                        max_gap_mm: gap,
                        deduplicate: true,
                        trajectory_enabled: true,
                    },
                )
                .unwrap();
                let raw = &result.variants[0];
                let current = &result.variants[1];
                let aggressive = result
                    .variants
                    .iter()
                    .find(|v| v.id == "aggressive")
                    .unwrap();
                let bridge_mm: f64 = aggressive
                    .added_bridges
                    .iter()
                    .flat_map(|s| s.windows(2))
                    .map(|p| (p[0].x - p[1].x).hypot(p[0].y - p[1].y))
                    .sum();
                assert!(stroke_refine::covers(&document, &aggressive.document));
                assert!(aggressive.coverage_preserved);
                assert_eq!(aggressive.eligible, aggressive.coverage_preserved);
                println!("AGGRESSIVE page={page} gap={gap:.1} raw_s={:.3} current_s={:.3} candidate_s={:.3} saved_pct={:.4} eligible={} raw_strokes={} candidate_strokes={} bridges={} bridge_mm={:.6} removed_overlap_mm={:.6} coverage={} compute_ms={:.3}",raw.estimated_seconds,current.estimated_seconds,aggressive.estimated_seconds,aggressive.savings_percent,aggressive.eligible,raw.strokes,aggressive.strokes,aggressive.added_bridges.len(),bridge_mm,aggressive.removed_overlap_mm,aggressive.coverage_preserved,aggressive.compute_ms);
                results.push(serde_json::json!({"page":page,"gap_mm":gap,"raw_seconds":raw.estimated_seconds,"current_seconds":current.estimated_seconds,"candidate_seconds":aggressive.estimated_seconds,"saved_percent":aggressive.savings_percent,"eligible":aggressive.eligible,"raw_strokes":raw.strokes,"candidate_strokes":aggressive.strokes,"bridges":aggressive.added_bridges.len(),"bridge_mm":bridge_mm,"removed_overlap_mm":aggressive.removed_overlap_mm,"coverage":aggressive.coverage_preserved,"compute_ms":aggressive.compute_ms}));
                if gap == 0.3 || gap == 1. {
                    let header=format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}mm\" height=\"{}mm\" viewBox=\"-1 -1 {} {}\"><rect x=\"-1\" y=\"-1\" width=\"100%\" height=\"100%\" fill=\"white\"/>",document.width_mm+2.,document.height_mm+2.,document.width_mm+2.,document.height_mm+2.);
                    std::fs::write(
                        out.join(format!("page-{page}-gap-{gap:.1}-overlay.svg")),
                        format!(
                            "{header}{}\n{}</svg>",
                            polylines(&document.strokes, "#999"),
                            polylines(&aggressive.added_bridges, "#e11d48")
                        ),
                    )
                    .unwrap();
                    std::fs::write(
                        out.join(format!("page-{page}-gap-{gap:.1}-candidate.svg")),
                        format!(
                            "{header}{}</svg>",
                            polylines(&aggressive.document.strokes, "#111")
                        ),
                    )
                    .unwrap();
                }
            }
        }
        std::fs::write(
            out.join("benchmark.json"),
            serde_json::to_string_pretty(&results).unwrap(),
        )
        .unwrap();
    }
}
