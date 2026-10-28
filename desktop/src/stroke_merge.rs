use crate::model::{Document, Point};
use std::collections::{BTreeMap, BTreeSet};

/// Join exact endpoints and existing interior vertices; traverse every original segment once.
/// Small gaps deliberately remain separate.
pub fn merge(document: &Document, allow_reverse: bool) -> Result<Document, String> {
    if !document.width_mm.is_finite()
        || !document.height_mm.is_finite()
        || document
            .strokes
            .iter()
            .flatten()
            .any(|p| !p.x.is_finite() || !p.y.is_finite())
    {
        return Err("Stroke merging requires finite coordinates and page dimensions".into());
    }
    let mut vertices = BTreeMap::new();
    let key = |p: Point| {
        (
            if p.x == 0.0 { 0 } else { p.x.to_bits() },
            if p.y == 0.0 { 0 } else { p.y.to_bits() },
        )
    };
    let endpoints: BTreeSet<_> = document
        .strokes
        .iter()
        .flat_map(|s| s.first().into_iter().chain(s.last()))
        .map(|&p| key(p))
        .collect();
    let mut split = Document {
        strokes: Vec::new(),
        ..document.clone()
    };
    for stroke in &document.strokes {
        if stroke.is_empty() {
            split.strokes.push(Vec::new());
            continue;
        }
        let mut piece = vec![stroke[0]];
        for (i, &point) in stroke.iter().enumerate().skip(1) {
            piece.push(point);
            if i + 1 < stroke.len() && endpoints.contains(&key(point)) {
                split
                    .strokes
                    .push(std::mem::replace(&mut piece, vec![point]));
            }
        }
        split.strokes.push(piece);
    }
    let document = &split;
    let mut edges = Vec::new();
    for (index, stroke) in document.strokes.iter().enumerate() {
        if let (Some(&first), Some(&last)) = (stroke.first(), stroke.last()) {
            let next = vertices.len();
            let a = *vertices.entry(key(first)).or_insert(next);
            let next = vertices.len();
            let b = *vertices.entry(key(last)).or_insert(next);
            edges.push((a, b, Some(index)));
        }
    }
    let hub = vertices.len();
    let mut adjacency = vec![Vec::new(); hub + 1];
    let mut balance = vec![0isize; hub];
    for &(a, b, _) in &edges {
        if allow_reverse {
            balance[a] += 1;
            balance[b] += 1;
        } else {
            balance[a] += 1;
            balance[b] -= 1;
        }
    }
    // Virtual edges balance each component without drawing or repeating an edge.
    for (vertex, degree) in balance.into_iter().enumerate() {
        if allow_reverse {
            if degree % 2 != 0 {
                edges.push((hub, vertex, None));
            }
        } else if degree > 0 {
            for _ in 0..degree {
                edges.push((hub, vertex, None));
            }
        } else {
            for _ in 0..-degree {
                edges.push((vertex, hub, None));
            }
        }
    }
    for (id, &(a, b, _)) in edges.iter().enumerate() {
        adjacency[a].push((id, false));
        if allow_reverse {
            adjacency[b].push((id, true));
        }
    }
    let mut used = vec![false; edges.len()];
    let mut output = document.clone();
    output.strokes.clear();
    for start in std::iter::once(hub).chain(0..hub) {
        let mut stack = vec![(start, None)];
        let mut circuit = Vec::new();
        while let Some(&(vertex, _)) = stack.last() {
            while adjacency[vertex].last().is_some_and(|&(id, _)| used[id]) {
                adjacency[vertex].pop();
            }
            if let Some((id, reverse)) = adjacency[vertex].pop() {
                used[id] = true;
                let (a, b, _) = edges[id];
                stack.push((if reverse { a } else { b }, Some((id, reverse))));
            } else if let Some((_, Some(incoming))) = stack.pop() {
                circuit.push(incoming);
            }
        }
        let mut stroke = Vec::new();
        for (id, reverse) in circuit.into_iter().rev() {
            if let Some(index) = edges[id].2 {
                let source = &document.strokes[index];
                if reverse {
                    stroke.extend(source.iter().rev().copied());
                } else {
                    stroke.extend(source.iter().copied());
                }
            } else if !stroke.is_empty() {
                output.strokes.push(std::mem::take(&mut stroke));
            }
        }
        if !stroke.is_empty() {
            output.strokes.push(stroke);
        }
    }
    output
        .strokes
        .extend(document.strokes.iter().filter(|s| s.is_empty()).cloned());
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(paths: &[&[(f64, f64)]]) -> Document {
        Document {
            name: "test".into(),
            width_mm: 10.0,
            height_mm: 10.0,
            strokes: paths
                .iter()
                .map(|s| s.iter().map(|&(x, y)| Point { x, y }).collect())
                .collect(),
        }
    }

    fn segments(document: &Document, directed: bool) -> Vec<((u64, u64), (u64, u64))> {
        let mut result = Vec::new();
        for stroke in &document.strokes {
            for pair in stroke.windows(2) {
                if pair[0] == pair[1] {
                    continue;
                }
                let a = (pair[0].x.to_bits(), pair[0].y.to_bits());
                let b = (pair[1].x.to_bits(), pair[1].y.to_bits());
                result.push(if !directed && b < a { (b, a) } else { (a, b) });
            }
        }
        result.sort_unstable();
        result
    }

    #[test]
    fn graph_cases_preserve_all_ink_and_minimize_trails() {
        let cases: Vec<(Document, usize)> = vec![
            (
                doc(&[&[(0., 0.), (1., 0.)], &[(1.000001, 0.), (2., 0.)]]),
                2,
            ),
            (
                doc(&[
                    &[(0., 0.), (1., 0.)],
                    &[(1., 0.), (2., 0.)],
                    &[(1., 0.), (1., 1.)],
                ]),
                2,
            ),
            (
                doc(&[
                    &[(0., 0.), (1., 0.)],
                    &[(1., 0.), (1., 1.)],
                    &[(1., 1.), (0., 0.)],
                ]),
                1,
            ),
            (
                doc(&[
                    &[(0., 0.), (0.5, 1.), (1., 0.)],
                    &[(0., 0.), (0.5, 2.), (1., 0.)],
                ]),
                1,
            ),
            (
                doc(&[
                    &[(0., 0.), (1., 0.)],
                    &[(2., 0.), (1., 0.)],
                    &[(2., 0.), (3., 0.)],
                ]),
                1,
            ),
        ];
        for (input, expected) in cases {
            let output = merge(&input, true).unwrap();
            assert_eq!(output.strokes.len(), expected);
            assert_eq!(segments(&input, false), segments(&output, false));
            assert_eq!(
                input.strokes.iter().map(Vec::len).sum::<usize>(),
                output.strokes.iter().map(Vec::len).sum::<usize>()
            );
        }
    }

    #[test]
    fn directed_merge_preserves_direction_and_handles_branches_and_cycles() {
        let input = doc(&[
            &[(0., 0.), (1., 0.)],
            &[(1., 0.), (2., 0.)],
            &[(1., 0.), (1., 1.)],
            &[(1., 1.), (1., 0.)],
            &[(3., 0.), (2., 0.)],
        ]);
        let output = merge(&input, false).unwrap();
        assert_eq!(output.strokes.len(), 2);
        assert_eq!(segments(&input, true), segments(&output, true));
    }

    #[test]
    fn joins_existing_interior_vertices_without_changing_segments() {
        let input = doc(&[
            &[(0., 0.), (1., 0.), (1., 1.), (0., 0.)],
            &[(1., 0.), (2., 0.)],
        ]);
        let output = merge(&input, true).unwrap();
        assert_eq!(output.strokes.len(), 1);
        assert_eq!(segments(&input, false), segments(&output, false));
    }

    #[test]
    fn does_not_split_segment_interiors_or_bridge_gaps() {
        let input = doc(&[
            &[(0., 0.), (3., 0.)],
            &[(1., 0.), (1., 1.)],
            &[(2., 1e-9), (2., 1.)],
        ]);
        let output = merge(&input, true).unwrap();
        assert_eq!(output.strokes.len(), 3);
        assert_eq!(segments(&input, false), segments(&output, false));
    }

    #[test]
    fn preserves_degenerate_paths_and_rejects_nonfinite_values() {
        let input = doc(&[&[], &[(1., 1.)], &[(2., 2.), (2., 2.)]]);
        let output = merge(&input, true).unwrap();
        assert_eq!(output.strokes.len(), 3);
        assert_eq!(output.strokes.iter().map(Vec::len).sum::<usize>(), 3);
        let mut invalid = input;
        invalid.strokes.push(vec![Point { x: f64::NAN, y: 0. }]);
        assert!(merge(&invalid, true).is_err());
        invalid.strokes.pop();
        invalid.width_mm = f64::INFINITY;
        assert!(merge(&invalid, false).is_err());
    }
}
