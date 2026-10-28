use crate::model::{Document, Point, Stroke};
use crate::stroke_merge;
use std::collections::{BTreeMap, BTreeSet};

pub struct Refined {
    pub document: Document,
    pub added_bridges: Vec<Vec<Point>>,
    pub removed_overlap_mm: f64,
}

fn distance(a: Point, b: Point) -> f64 {
    (a.x - b.x).hypot(a.y - b.y)
}
fn point(a: Point, b: Point, t: f64) -> Point {
    if t == 0. {
        a
    } else if t == 1. {
        b
    } else {
        Point {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
        }
    }
}
fn cells(a: Point, b: Point, size: f64) -> BTreeSet<(i64, i64)> {
    let steps = ((b.x - a.x).abs().max((b.y - a.y).abs()) / size)
        .ceil()
        .max(1.) as usize;
    (0..=steps)
        .map(|i| {
            let p = point(a, b, i as f64 / steps as f64);
            ((p.x / size).floor() as i64, (p.y / size).floor() as i64)
        })
        .collect()
}

struct SegmentIndex {
    size: f64,
    grid: BTreeMap<(i64, i64), Vec<usize>>,
    segments: Vec<(Point, Point)>,
}
impl SegmentIndex {
    fn new(document: &Document) -> Self {
        let extent = document
            .strokes
            .iter()
            .flatten()
            .map(|p| p.x.abs().max(p.y.abs()))
            .fold(1., f64::max);
        Self {
            size: (extent / 1000.).max(1.),
            grid: BTreeMap::new(),
            segments: Vec::new(),
        }
    }
    fn insert(&mut self, a: Point, b: Point) {
        let id = self.segments.len();
        self.segments.push((a, b));
        for cell in cells(a, b, self.size) {
            self.grid.entry(cell).or_default().push(id);
        }
    }
    fn uncovered(&self, a: Point, b: Point, epsilon: f64) -> Vec<(f64, f64)> {
        let length = distance(a, b);
        let dx = (b.x - a.x) / length;
        let dy = (b.y - a.y) / length;
        let mut candidates = BTreeSet::new();
        for (x, y) in cells(a, b, self.size) {
            for ox in -1..=1 {
                for oy in -1..=1 {
                    if let Some(ids) = self.grid.get(&(x + ox, y + oy)) {
                        candidates.extend(ids.iter().copied());
                    }
                }
            }
        }
        let mut covered = Vec::new();
        for id in candidates {
            let (c, d) = self.segments[id];
            let cross = |p: Point| ((p.x - a.x) * dy - (p.y - a.y) * dx).abs();
            if cross(c) > epsilon || cross(d) > epsilon {
                continue;
            }
            let project = |p: Point| ((p.x - a.x) * dx + (p.y - a.y) * dy) / length;
            let c = project(c);
            let d = project(d);
            let lo = c.min(d).max(0.);
            let hi = c.max(d).min(1.);
            if hi > lo {
                covered.push((lo, hi));
            }
        }
        covered.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut cursor = 0.;
        let mut ranges = Vec::new();
        for (lo, hi) in covered {
            if lo > cursor {
                ranges.push((cursor, lo));
            }
            cursor = cursor.max(hi);
        }
        if cursor < 1. {
            ranges.push((cursor, 1.));
        }
        ranges
    }
}

/// Independently verify original ink coverage, allowing only 1e-8 mm numerical error.
pub fn covers(original: &Document, candidate: &Document) -> bool {
    if [original, candidate].iter().any(|d| {
        d.strokes
            .iter()
            .flatten()
            .any(|p| !p.x.is_finite() || !p.y.is_finite() || p.x.abs() > 1e9 || p.y.abs() > 1e9)
    }) {
        return false;
    }
    let mut index = SegmentIndex::new(candidate);
    index.size = index.size.max(SegmentIndex::new(original).size);
    for s in &candidate.strokes {
        for pair in s.windows(2) {
            if pair[0] != pair[1] {
                index.insert(pair[0], pair[1]);
            }
        }
    }
    original.strokes.iter().all(|s| {
        s.windows(2).all(|p| {
            let length = distance(p[0], p[1]);
            length == 0.
                || index
                    .uncovered(p[0], p[1], 1e-8)
                    .iter()
                    .all(|(lo, hi)| (hi - lo) * length <= 1e-8)
        })
    })
}

fn dedup(document: &Document) -> (Document, f64) {
    let mut index = SegmentIndex::new(document);
    let mut output = Document {
        strokes: Vec::new(),
        ..document.clone()
    };
    let mut removed = 0.;
    for source in &document.strokes {
        if source.len() < 2 {
            output.strokes.push(source.clone());
            continue;
        }
        let mut stroke = vec![source[0]];
        for pair in source.windows(2) {
            let a = pair[0];
            let b = pair[1];
            let length = distance(a, b);
            if length == 0. {
                stroke.push(b);
                continue;
            }
            let ranges = index.uncovered(a, b, 1e-9);
            let retained: f64 = ranges.iter().map(|(lo, hi)| hi - lo).sum();
            removed += length * (1. - retained).max(0.);
            for (lo, hi) in ranges {
                let first = point(a, b, lo);
                let last = point(a, b, hi);
                if stroke.last().copied() != Some(first) {
                    if stroke.len() > 1 {
                        output.strokes.push(std::mem::take(&mut stroke));
                    }
                    stroke = vec![first];
                }
                stroke.push(last);
                index.insert(first, last);
                if hi < 1. {
                    output.strokes.push(std::mem::take(&mut stroke));
                }
            }
            if retained == 0. && stroke.len() > 1 {
                output.strokes.push(std::mem::take(&mut stroke));
            }
        }
        if stroke.len() > 1 {
            output.strokes.push(stroke);
        }
    }
    (output, removed)
}

fn root(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// Aggressive candidates explicitly report newly drawn bridges; callers apply the total-time gate.
#[allow(clippy::too_many_arguments)]
pub fn refine(
    document: &Document,
    allow_reverse: bool,
    feed: f64,
    travel_feed: f64,
    z_feed: f64,
    z_down: f64,
    max_gap_mm: f64,
    deduplicate: bool,
) -> Result<Refined, String> {
    if ![feed, travel_feed, z_feed]
        .iter()
        .all(|v| v.is_finite() && *v > 0.)
        || !z_down.is_finite()
        || !(0.0..=10.).contains(&z_down)
        || !max_gap_mm.is_finite()
        || !(0.0..=1.).contains(&max_gap_mm)
    {
        return Err(
            "Refinement requires positive finite feeds, Z depth 0..10 mm and gap 0..1 mm".into(),
        );
    }
    // Validate before indexing coordinates or computing lengths.
    if !document.width_mm.is_finite()
        || !document.height_mm.is_finite()
        || document
            .strokes
            .iter()
            .flatten()
            .any(|p| !p.x.is_finite() || !p.y.is_finite() || p.x.abs() > 1e9 || p.y.abs() > 1e9)
    {
        return Err(
            "Refinement requires finite page dimensions and coordinates within 1e9 mm".into(),
        );
    }
    let (document, removed_overlap_mm) = if deduplicate {
        dedup(document)
    } else {
        (document.clone(), 0.)
    };
    let document = stroke_merge::merge(&document, allow_reverse)?;
    let mut endpoints: Vec<_> = document
        .strokes
        .iter()
        .enumerate()
        .filter(|(_, s)| s.len() > 1)
        .flat_map(|(i, s)| [(s[0], i, 0usize), (*s.last().unwrap(), i, 1usize)])
        .collect();
    endpoints.sort_by(|a, b| a.0.x.total_cmp(&b.0.x));
    let mut candidates = Vec::new();
    for (index, &(a, i, end_a)) in endpoints.iter().enumerate() {
        for &(b, j, end_b) in &endpoints[index + 1..] {
            if b.x - a.x > max_gap_mm {
                break;
            }
            if i == j || (!allow_reverse && end_a == end_b) {
                continue;
            }
            let gap = distance(a, b);
            let gain = (2. * z_down / z_feed + gap / travel_feed - gap / feed) * 60.;
            if gap <= max_gap_mm && gain > 0. {
                candidates.push((gain, i, end_a, j, end_b, a, b));
            }
        }
    }
    // shortcut: greedy endpoint matching is not globally optimal; revisit if measured savings justify matching search.
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut links = vec![[None; 2]; document.strokes.len()];
    let mut parent: Vec<_> = (0..links.len()).collect();
    let mut added_bridges = Vec::new();
    for (_, i, end_a, j, end_b, a, b) in candidates {
        if links[i][end_a].is_some() || links[j][end_b].is_some() {
            continue;
        }
        let left = root(&mut parent, i);
        let right = root(&mut parent, j);
        if left == right {
            continue;
        }
        parent[left] = right;
        links[i][end_a] = Some((j, end_b));
        links[j][end_b] = Some((i, end_a));
        if a != b {
            added_bridges.push(vec![a, b]);
        }
    }
    let mut output = Document {
        strokes: Vec::new(),
        ..document.clone()
    };
    let mut seen = vec![false; links.len()];
    for i in 0..links.len() {
        if seen[i] {
            continue;
        }
        if document.strokes[i].len() < 2 {
            seen[i] = true;
            output.strokes.push(document.strokes[i].clone());
            continue;
        }
        let entry = if links[i][0].is_none() {
            0
        } else if allow_reverse && links[i][1].is_none() {
            1
        } else {
            continue;
        };
        let mut current = i;
        let mut entry = entry;
        let mut stroke: Stroke = Vec::new();
        loop {
            seen[current] = true;
            if entry == 0 {
                stroke.extend(document.strokes[current].iter().copied());
            } else {
                stroke.extend(document.strokes[current].iter().rev().copied());
            }
            if let Some((next, next_entry)) = links[current][1 - entry] {
                current = next;
                entry = next_entry;
            } else {
                break;
            }
        }
        output.strokes.push(stroke);
    }
    Ok(Refined {
        document: output,
        added_bridges,
        removed_overlap_mm,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document(paths: &[&[(f64, f64)]]) -> Document {
        Document {
            name: "test".into(),
            width_mm: 100.,
            height_mm: 100.,
            strokes: paths
                .iter()
                .map(|s| s.iter().map(|&(x, y)| Point { x, y }).collect())
                .collect(),
        }
    }
    fn run(d: &Document, reverse: bool, deduplicate: bool) -> Refined {
        refine(d, reverse, 1500., 2500., 3000., 4., 0.3, deduplicate).unwrap()
    }
    fn length(d: &Document) -> f64 {
        d.strokes
            .iter()
            .flat_map(|s| s.windows(2))
            .map(|s| distance(s[0], s[1]))
            .sum()
    }
    #[test]
    fn coverage_accepts_resplitting_but_rejects_missing_ink_and_crossings() {
        let original = document(&[&[(0., 0.), (10., 0.)]]);
        let split = document(&[&[(0., 0.), (3., 0.)], &[(3., 0.), (10., 0.)]]);
        assert!(covers(&original, &split));
        assert!(covers(&split, &original));
        let missing = document(&[&[(0., 0.), (3., 0.)], &[(3.0001, 0.), (10., 0.)]]);
        assert!(!covers(&original, &missing));
        assert!(!covers(&original, &document(&[&[(5., -5.), (5., 5.)]])));
    }

    #[test]
    fn partial_and_reverse_full_overlap_keep_coverage() {
        let d = document(&[
            &[(0., 0.), (10., 0.)],
            &[(5., 0.), (15., 0.)],
            &[(10., 0.), (0., 0.)],
        ]);
        let r = run(&d, true, true);
        assert!((r.removed_overlap_mm - 15.).abs() < 1e-8);
        assert!((length(&r.document) - 15.).abs() < 1e-8);
        assert!(covers(&d, &r.document));
        assert!(r.added_bridges.is_empty());
        assert_eq!(run(&d, true, false).removed_overlap_mm, 0.);
    }
    #[test]
    fn crossing_and_parallel_ink_are_not_overlap() {
        let d = document(&[
            &[(0., 0.), (10., 0.)],
            &[(5., -5.), (5., 5.)],
            &[(0., 0.001), (10., 0.001)],
        ]);
        let r = run(&d, false, true);
        assert_eq!(r.removed_overlap_mm, 0.);
        assert!(length(&r.document) >= 30.);
    }
    #[test]
    fn speed_weight_and_gap_limit_control_bridges() {
        let d = document(&[&[(0., 0.), (1., 0.)], &[(1.2, 0.), (2., 0.)]]);
        let r = run(&d, false, false);
        assert_eq!(r.added_bridges.len(), 1);
        assert_eq!(r.document.strokes.len(), 1);
        let slow = refine(&d, false, 1., 2500., 3000., 4., 0.3, false).unwrap();
        assert!(slow.added_bridges.is_empty());
        assert_eq!(slow.document.strokes.len(), 2);
        assert!(refine(&d, false, 1500., 2500., 3000., 4., 0.1, false)
            .unwrap()
            .added_bridges
            .is_empty());
    }
    #[test]
    fn no_reverse_keeps_every_directed_segment() {
        let d = document(&[&[(0., 0.), (1., 0.)], &[(2., 0.), (1.2, 0.)]]);
        assert!(run(&d, false, false).added_bridges.is_empty());
        let r = run(&d, true, false);
        assert_eq!(r.added_bridges.len(), 1);
        let chain = document(&[
            &[(2., 0.), (3., 0.)],
            &[(0., 0.), (1., 0.)],
            &[(1.2, 0.), (1.8, 0.)],
        ]);
        let r = run(&chain, false, false);
        assert_eq!(r.document.strokes.len(), 1);
        assert!(r.document.strokes[0].windows(2).all(|p| p[1].x >= p[0].x));
    }
    #[test]
    fn validates_all_parameters_and_nonfinite_geometry() {
        let d = document(&[&[(0., 0.), (1., 0.)]]);
        for gap in [-0.1, 1.1, f64::NAN] {
            assert!(refine(&d, true, 1500., 2500., 3000., 4., gap, true).is_err());
        }
        assert!(refine(&d, true, 0., 2500., 3000., 4., 0.3, true).is_err());
        assert!(refine(&d, true, 1500., 2500., f64::INFINITY, 4., 0.3, true).is_err());
        assert!(refine(&d, true, 1500., 2500., 3000., -1., 0.3, true).is_err());
        let mut invalid = d;
        invalid.strokes[0][0].x = f64::NAN;
        assert!(run_error(&invalid));
    }
    fn run_error(d: &Document) -> bool {
        refine(d, true, 1500., 2500., 3000., 4., 0.3, true).is_err()
    }
}
