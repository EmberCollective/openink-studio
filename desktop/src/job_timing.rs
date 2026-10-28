//! Ideal motion time from our generated G-code, excluding acceleration and transport.
#[derive(Debug)]
pub struct Profile {
    pub total_seconds: f64,
    /// Entry i is the ideal elapsed time through line i (not physical ACK completion).
    pub cumulative_seconds: Vec<f64>,
    pub draw_mm: f64,
    pub travel_mm: f64,
    pub z_mm: f64,
}

pub fn profile(lines: &[String], start: [f64; 3]) -> Result<Profile, String> {
    if !start.iter().all(|v| v.is_finite()) {
        return Err("Timing start must be finite".into());
    }
    let mut result = Profile {
        total_seconds: 0.,
        cumulative_seconds: Vec::with_capacity(lines.len()),
        draw_mm: 0.,
        travel_mm: 0.,
        z_mm: 0.,
    };
    let mut at = start;
    let mut absolute = true;
    let mut feed = None;
    for line in lines {
        let mut coordinates = [None; 3];
        let mut movement = false;
        let mut dwell = false;
        let mut pause = 0.;
        for word in line.split_whitespace() {
            match word {
                "G21" | "G94" | "G54" => {}
                "G90" => absolute = true,
                "G91" => absolute = false,
                "G1" => movement = true,
                "G4" => dwell = true,
                _ => {
                    let value = word
                        .get(1..)
                        .ok_or("Invalid timing word")?
                        .parse::<f64>()
                        .map_err(|_| format!("Unsupported timing word: {word}"))?;
                    if !value.is_finite() {
                        return Err("Timing values must be finite".into());
                    }
                    match word.as_bytes()[0] {
                        b'X' => coordinates[0] = Some(value),
                        b'Y' => coordinates[1] = Some(value),
                        b'Z' => coordinates[2] = Some(value),
                        b'F' if value > 0. => feed = Some(value),
                        b'P' if value >= 0. => pause = value,
                        _ => return Err(format!("Unsupported timing word: {word}")),
                    }
                }
            }
        }
        if movement && dwell
            || coordinates.iter().any(Option::is_some) && !movement
            || pause > 0. && !dwell
        {
            return Err("Unsupported timing motion or dwell".into());
        }
        if movement {
            let mut next = at;
            for axis in 0..3 {
                if let Some(value) = coordinates[axis] {
                    next[axis] = if absolute { value } else { at[axis] + value };
                }
            }
            let xy = (next[0] - at[0]).hypot(next[1] - at[1]);
            let z = (next[2] - at[2]).abs();
            if at[2] > 0. {
                result.draw_mm += xy;
            } else {
                result.travel_mm += xy;
            }
            result.z_mm += z;
            result.total_seconds +=
                xy.hypot(z) / feed.ok_or("Timing movement has no positive feed")? * 60.;
            at = next;
        }
        if dwell {
            result.total_seconds += pause;
        }
        if !result.total_seconds.is_finite() {
            return Err("Estimated duration is not finite".into());
        }
        result.cumulative_seconds.push(result.total_seconds);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn lines(s: &str) -> Vec<String> {
        s.lines().map(str::to_owned).collect()
    }
    #[test]
    fn actual_start_modal_feed_and_unequal_segments() {
        let p = profile(&lines("G21\nG90\nG94\nG54\nG1 X13 Y24 F300\nG1 Z2 F120\nG1 X14 F60\nG91\nG1 X9\nG4 P0.5\nG90\nG1 Z0 F120"), [10.,20.,0.]).unwrap();
        assert!((p.total_seconds - 13.5).abs() < 1e-9);
        assert_eq!((p.travel_mm, p.draw_mm, p.z_mm), (5., 10., 4.));
        assert_eq!(p.cumulative_seconds[6] - p.cumulative_seconds[5], 1.);
        assert_eq!(p.cumulative_seconds[8] - p.cumulative_seconds[7], 9.);
    }
    #[test]
    fn rejects_unknown_modes_invalid_feed_and_nonfinite_values() {
        for code in [
            "G20",
            "G93",
            "G0 X1 F100",
            "G1 X1",
            "G1 X1 F0",
            "G1 XNaN F100",
            "G4 P-1",
        ] {
            assert!(profile(&lines(code), [0.; 3]).is_err(), "{code}");
        }
        assert!(profile(&[], [f64::NAN, 0., 0.]).is_err());
    }
    #[test]
    fn actual_job_depth_and_each_feed_control_ideal_duration() {
        let p = profile(
            &lines("G1 X10 F600\nG1 Z10 F300\nG1 X30 F1200\nG1 Z0 F300"),
            [0.; 3],
        )
        .unwrap();
        assert_eq!(p.total_seconds, 6.);
        assert_eq!(p.cumulative_seconds, vec![1., 3., 4., 6.]);
        let faster = profile(
            &lines("G1 X10 F1200\nG1 Z2 F600\nG1 X30 F2400\nG1 Z0 F600"),
            [0.; 3],
        )
        .unwrap();
        assert!((faster.total_seconds - 1.4).abs() < 1e-9);
    }
}
