//! Open endpoint routing; only order and (optionally) stroke direction change.
use crate::model::{Document, Point};
use serde::Serialize;

#[derive(Serialize)]
pub struct OptimizationResult {
    pub document: Document,
    pub stroke_order: Vec<usize>,
    pub reversed: Vec<bool>,
    pub before_distance_mm: f64,
    pub after_distance_mm: f64,
    pub before_travel_seconds: f64,
    pub after_travel_seconds: f64,
    pub algorithm: String,
    pub exact: bool,
}
#[derive(Clone, Copy, Debug)]
struct Visit {
    index: usize,
    reverse: bool,
}
fn distance(a: Point, b: Point) -> f64 {
    (a.x - b.x).hypot(a.y - b.y)
}
fn endpoint(d: &Document, v: Visit, end: bool) -> Point {
    let s = &d.strokes[v.index];
    s[if end != v.reverse { s.len() - 1 } else { 0 }]
}
fn cost(d: &Document, route: &[Visit], start: Option<Point>) -> f64 {
    let mut p = start;
    route
        .iter()
        .map(|&v| {
            let c = p.map_or(0.0, |p| distance(p, endpoint(d, v, false)));
            p = Some(endpoint(d, v, true));
            c
        })
        .sum()
}
fn exact_route(d: &Document, ids: &[usize], start: Option<Point>, reverse: bool) -> Vec<Visit> {
    let n = ids.len();
    if n == 0 {
        return vec![];
    }
    let orientations = if reverse { 2 } else { 1 };
    let width = n * orientations;
    let mut dp = vec![f64::INFINITY; (1 << n) * width];
    let mut parent = vec![usize::MAX; dp.len()];
    let visit = |s: usize| Visit {
        index: ids[s / orientations],
        reverse: s % orientations == 1,
    };
    for s in 0..width {
        dp[(1 << (s / orientations)) * width + s] =
            start.map_or(0.0, |p| distance(p, endpoint(d, visit(s), false)));
    }
    for mask in 1usize..1 << n {
        for s in 0..width {
            let c = dp[mask * width + s];
            if !c.is_finite() {
                continue;
            }
            for t in 0..width {
                let bit = 1 << (t / orientations);
                if mask & bit != 0 {
                    continue;
                }
                let next = (mask | bit) * width + t;
                let candidate =
                    c + distance(endpoint(d, visit(s), true), endpoint(d, visit(t), false));
                if candidate < dp[next] {
                    dp[next] = candidate;
                    parent[next] = s;
                }
            }
        }
    }
    let mut mask = (1 << n) - 1;
    let mut s = (0..width)
        .min_by(|&a, &b| dp[mask * width + a].total_cmp(&dp[mask * width + b]))
        .unwrap();
    let mut out = Vec::with_capacity(n);
    loop {
        out.push(visit(s));
        let prev = parent[mask * width + s];
        mask ^= 1 << (s / orientations);
        if mask == 0 {
            break;
        }
        s = prev;
    }
    out.reverse();
    out
}
fn heuristic(d: &Document, ids: &[usize], start: Option<Point>, reverse: bool) -> Vec<Visit> {
    let mut used = vec![false; ids.len()];
    let mut route = Vec::with_capacity(ids.len());
    let mut p = start;
    for _ in ids {
        let mut best = (f64::INFINITY, 0, false);
        for (slot, &index) in ids.iter().enumerate() {
            if used[slot] {
                continue;
            }
            for rev in 0..if reverse { 2 } else { 1 } {
                let c = p.map_or(0.0, |p| {
                    distance(
                        p,
                        endpoint(
                            d,
                            Visit {
                                index,
                                reverse: rev == 1,
                            },
                            false,
                        ),
                    )
                });
                if c < best.0 {
                    best = (c, slot, rev == 1);
                }
            }
        }
        used[best.1] = true;
        let v = Visit {
            index: ids[best.1],
            reverse: best.2,
        };
        p = Some(endpoint(d, v, true));
        route.push(v);
    }
    // Reversing the sequence AND each stroke preserves all internal edge lengths.
    // A fixed evaluation cap bounds work for large imported pages.
    if reverse {
        let mut evaluations = 0usize;
        'passes: for _ in 0..8 {
            let mut changed = false;
            for i in 0..route.len() {
                for j in i..route.len() {
                    evaluations += 1;
                    if evaluations > 2_000_000 {
                        break 'passes;
                    }
                    let prev = if i == 0 {
                        start
                    } else {
                        Some(endpoint(d, route[i - 1], true))
                    };
                    let old = prev.map_or(0.0, |p| distance(p, endpoint(d, route[i], false)));
                    let new = prev.map_or(0.0, |p| distance(p, endpoint(d, route[j], true)));
                    let (old, new) = if j + 1 < route.len() {
                        let next = endpoint(d, route[j + 1], false);
                        (
                            old + distance(endpoint(d, route[j], true), next),
                            new + distance(endpoint(d, route[i], false), next),
                        )
                    } else {
                        (old, new)
                    };
                    if new + 1e-10 < old {
                        route[i..=j].reverse();
                        for v in &mut route[i..=j] {
                            v.reverse = !v.reverse;
                        }
                        changed = true;
                    }
                }
            }
            if !changed {
                break;
            }
        }
    }
    route
}
pub fn optimize(
    document: &Document,
    start: Option<Point>,
    allow_reverse: bool,
    travel_feed_mm_min: f64,
) -> Result<OptimizationResult, String> {
    if start.is_some_and(|p| !p.x.is_finite() || !p.y.is_finite())
        || !travel_feed_mm_min.is_finite()
        || travel_feed_mm_min <= 0.0
    {
        return Err("起点必须有限，空移速度必须为正有限数".into());
    }
    if document
        .strokes
        .iter()
        .flatten()
        .any(|p| !p.x.is_finite() || !p.y.is_finite())
    {
        return Err("路径包含非有限坐标".into());
    }
    let ids: Vec<_> = document
        .strokes
        .iter()
        .enumerate()
        .filter(|(_, s)| s.len() >= 2)
        .map(|(i, _)| i)
        .collect();
    let original: Vec<_> = ids
        .iter()
        .map(|&index| Visit {
            index,
            reverse: false,
        })
        .collect();
    let before = cost(document, &original, start);
    if !before.is_finite() {
        return Err("路径距离超出可计算范围".into());
    }
    let exact = ids.len() <= 12;
    let mut route = if exact {
        exact_route(document, &ids, start, allow_reverse)
    } else {
        heuristic(document, &ids, start, allow_reverse)
    };
    if cost(document, &route, start) > before {
        route = original;
    }
    let after = cost(document, &route, start);
    if !(before / travel_feed_mm_min * 60.0).is_finite()
        || !(after / travel_feed_mm_min * 60.0).is_finite()
    {
        return Err("空移时间超出可计算范围".into());
    }
    // Degenerate strokes have no device motion; retain them verbatim after drawable strokes.
    route.extend(
        document
            .strokes
            .iter()
            .enumerate()
            .filter(|(_, s)| s.len() < 2)
            .map(|(index, _)| Visit {
                index,
                reverse: false,
            }),
    );
    let mut output = document.clone();
    output.strokes = route
        .iter()
        .map(|v| {
            let mut s = document.strokes[v.index].clone();
            if v.reverse {
                s.reverse();
            }
            s
        })
        .collect();
    Ok(OptimizationResult {
        document: output,
        stroke_order: route.iter().map(|v| v.index).collect(),
        reversed: route.iter().map(|v| v.reverse).collect(),
        before_distance_mm: before,
        after_distance_mm: after,
        before_travel_seconds: before / travel_feed_mm_min * 60.0,
        after_travel_seconds: after / travel_feed_mm_min * 60.0,
        algorithm: if exact {
            "exact-oriented-open-tsp"
        } else if !allow_reverse {
            "nearest-neighbor"
        } else {
            "nearest-neighbor-bounded-2opt"
        }
        .into(),
        exact,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }
    fn doc(n: usize) -> Document {
        Document {
            name: "test".into(),
            width_mm: 200.,
            height_mm: 200.,
            strokes: (0..n)
                .map(|i| {
                    let x = ((i * 73) % 997) as f64;
                    vec![p(x, (i % 11) as f64), p(x + 3., (i % 13) as f64)]
                })
                .collect(),
        }
    }
    #[test]
    fn preserves_geometry_and_degenerates() {
        let mut d = doc(8);
        d.strokes.push(vec![]);
        d.strokes.push(vec![p(9., 4.)]);
        let r = optimize(&d, Some(p(20., 30.)), true, 1500.).unwrap();
        assert_eq!(r.document.strokes.len(), d.strokes.len());
        let mut indices = r.stroke_order.clone();
        indices.sort();
        assert_eq!(indices, (0..d.strokes.len()).collect::<Vec<_>>());
        for (i, s) in r.document.strokes.iter().enumerate() {
            let mut expected = d.strokes[r.stroke_order[i]].clone();
            if r.reversed[i] {
                expected.reverse();
            }
            assert_eq!(*s, expected);
        }
        assert!(r.after_distance_mm <= r.before_distance_mm);
    }
    fn oracle(d: &Document, remaining: Vec<usize>, start: Point, reverse: bool) -> f64 {
        if remaining.is_empty() {
            return 0.;
        }
        let mut best = f64::INFINITY;
        for slot in 0..remaining.len() {
            let mut rest = remaining.clone();
            let index = rest.remove(slot);
            for rev in 0..if reverse { 2 } else { 1 } {
                let v = Visit {
                    index,
                    reverse: rev == 1,
                };
                best = best.min(
                    distance(start, endpoint(d, v, false))
                        + oracle(d, rest.clone(), endpoint(d, v, true), reverse),
                );
            }
        }
        best
    }
    #[test]
    fn exact_matches_independent_permutation_oracle() {
        let d = doc(5);
        let start = p(111., 17.);
        for reverse in [false, true] {
            let r = optimize(&d, Some(start), reverse, 600.).unwrap();
            assert!(
                (r.after_distance_mm - oracle(&d, (0..5).collect(), start, reverse)).abs() < 1e-8
            );
            assert!(r.exact);
            if !reverse {
                assert!(r.reversed.iter().all(|v| !*v));
            }
        }
    }
    #[test]
    fn large_deterministic_and_no_worsening() {
        let d = doc(3000);
        let a = optimize(&d, Some(p(0., 0.)), true, 1500.).unwrap();
        let b = optimize(&d, Some(p(0., 0.)), true, 1500.).unwrap();
        assert_eq!(a.stroke_order, b.stroke_order);
        assert_eq!(a.reversed, b.reversed);
        assert!(a.after_distance_mm <= a.before_distance_mm);
        assert!(!a.exact);
    }
    #[test]
    fn invalid_and_empty() {
        let d = doc(0);
        assert_eq!(
            optimize(&d, Some(p(0., 0.)), true, 1500.)
                .unwrap()
                .after_distance_mm,
            0.
        );
        assert!(optimize(&d, Some(p(f64::NAN, 0.)), true, 1500.).is_err());
        assert!(optimize(&d, Some(p(0., 0.)), true, 0.).is_err());
        let mut bad = doc(1);
        bad.strokes[0][0].x = f64::INFINITY;
        assert!(optimize(&bad, Some(p(0., 0.)), true, 1.).is_err());
    }
    #[test]
    fn free_start_excludes_initial_travel_and_is_exact() {
        let d = doc(5);
        for reverse in [false, true] {
            let r = optimize(&d, None, reverse, 1500.).unwrap();
            let expected = (0..5)
                .flat_map(|i| (0..if reverse { 2 } else { 1 }).map(move |rev| (i, rev)))
                .map(|(i, rev)| {
                    let v = Visit {
                        index: i,
                        reverse: rev == 1,
                    };
                    oracle(
                        &d,
                        (0..5).filter(|&j| j != i).collect(),
                        endpoint(&d, v, true),
                        reverse,
                    )
                })
                .fold(f64::INFINITY, f64::min);
            assert!((r.after_distance_mm - expected).abs() < 1e-8);
        }
        assert_eq!(
            optimize(&doc(1), None, true, 1500.)
                .unwrap()
                .after_distance_mm,
            0.
        );
    }
    #[test]
    fn fixed_start_no_return_and_time_units() {
        let d = Document {
            name: "one".into(),
            width_mm: 10.,
            height_mm: 10.,
            strokes: vec![vec![p(3., 4.), p(100., 100.)]],
        };
        let r = optimize(&d, Some(p(0., 0.)), false, 60.).unwrap();
        assert_eq!(r.after_distance_mm, 5.);
        assert_eq!(r.after_travel_seconds, 5.);
    }
    // Read the emitted commands independently of the route cost implementation.
    // Controller coordinates are rounded to 0.001 mm by the real job builder.
    fn emitted_penup_distance(lines: &[String], mut xy: Point) -> f64 {
        let mut raised = true;
        let mut total = 0.;
        for line in lines {
            let mut next = xy;
            let mut moves_xy = false;
            for word in line.split_whitespace() {
                if let Some(value) = word.strip_prefix('Z') {
                    raised = value.parse::<f64>().unwrap() == 0.;
                } else if let Some(value) = word.strip_prefix('X') {
                    next.x = value.parse().unwrap();
                    moves_xy = true;
                } else if let Some(value) = word.strip_prefix('Y') {
                    next.y = value.parse().unwrap();
                    moves_xy = true;
                }
            }
            if moves_xy {
                if raised {
                    total += (xy.x - next.x).hypot(xy.y - next.y);
                }
                xy = next;
            }
        }
        total
    }
    fn assert_job_metrics_and_geometry(d: &Document, allow_reverse: bool) {
        let start = p(12.3, 24.7);
        for fixed in [false, true] {
            let r = optimize(d, fixed.then_some(start), allow_reverse, 1500.).unwrap();
            let mut indices = r.stroke_order.clone();
            indices.sort_unstable();
            assert_eq!(indices, (0..d.strokes.len()).collect::<Vec<_>>());
            for (slot, stroke) in r.document.strokes.iter().enumerate() {
                let mut expected = d.strokes[r.stroke_order[slot]].clone();
                if r.reversed[slot] {
                    assert!(allow_reverse);
                    expected.reverse();
                }
                assert_eq!(*stroke, expected);
            }
            for (document, expected) in [
                (d, r.before_distance_mm),
                (&r.document, r.after_distance_mm),
            ] {
                let job = crate::device::Job {
                    document: document.clone(),
                    feed: 1200.,
                    travel_feed: 1500.,
                    z_feed: 300.,
                    z_down: 4.,
                };
                let (lines, initial) = if fixed {
                    (
                        crate::device::build_canvas_job(&job, [0., 0.]).unwrap(),
                        p(start.x, -start.y),
                    )
                } else {
                    (crate::device::build_job(&job, [0.; 3]).unwrap(), p(0., 0.))
                };
                let emitted = emitted_penup_distance(&lines, initial);
                let drawable = document.strokes.iter().filter(|s| s.len() >= 2).count();
                assert!(
                    (emitted - expected).abs() <= drawable as f64 * 0.0015,
                    "emitted={emitted}, metric={expected}, fixed={fixed}"
                );
            }
        }
    }
    #[test]
    fn route_metrics_match_real_job_commands_in_both_start_modes() {
        for (n, reverse) in [(10, true), (20, false)] {
            let mut d = doc(n);
            for point in d.strokes.iter_mut().flatten() {
                point.x *= 0.1;
            }
            assert_job_metrics_and_geometry(&d, reverse);
        }
    }
    #[test]
    #[ignore = "Offline benchmark needs repository PDF, Python and AutoTrace"]
    fn actual_pdf_route_benchmark() {
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../inko-inko.pdf");
        for page in [1, 2] {
            let options = crate::import::ImportOptions {
                page,
                ..Default::default()
            };
            let d = crate::import::import_file(&source, &options).unwrap();
            let started = std::time::Instant::now();
            let r = optimize(&d, None, true, 1500.).unwrap();
            println!("inko-inko.pdf page={page} threshold=180 strokes={} before_mm={:.3} after_mm={:.3} saved_pct={:.2} estimated_before_s={:.3} estimated_after_s={:.3} optimizer_ms={:.3}", d.strokes.len(),r.before_distance_mm,r.after_distance_mm,100.0*(1.0-r.after_distance_mm/r.before_distance_mm),r.before_travel_seconds,r.after_travel_seconds,started.elapsed().as_secs_f64()*1000.0);
            assert!(r.after_distance_mm <= r.before_distance_mm);
            // Fit this imported page into the job builder's A4 software envelope;
            // all original points remain represented, with a uniform scale.
            let mut fitted = d.clone();
            let extent = fitted
                .strokes
                .iter()
                .flatten()
                .map(|p| p.x.abs().max(p.y.abs()))
                .fold(1., f64::max);
            for point in fitted.strokes.iter_mut().flatten() {
                point.x *= 100. / extent;
                point.y *= 100. / extent;
            }
            assert_job_metrics_and_geometry(&fitted, true);
            assert_job_metrics_and_geometry(&fitted, false);
        }
    }
    #[test]
    #[cfg(feature = "private-gfont")]
    fn official_gfont_direction_and_job_metrics_are_preserved() {
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fonts/Apollo_kvenjoy_Zl.gfont");
        if !source.exists() {
            // shortcut: gfont 仅本地保留；公开树无此文件时跳过
            return;
        }
        let composed = crate::legacy_font::compose(
            &[crate::legacy_font::FontSelection {
                path: source.to_string_lossy().into_owned(),
                weight: 1.,
            }],
            "永",
            &crate::legacy_font::ComposeOptions::default(),
        )
        .unwrap();
        assert!(composed.missing.is_empty());
        assert_job_metrics_and_geometry(&composed.document, false);
    }
}
