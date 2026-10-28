//! Fixed paper coordinates. Jog changes the tip position, never this origin.
use crate::{device::Job, model::Point};
// User-authorized A4 software limits; physical travel remains unverified.
pub(crate) const AXIS_LIMITS_MM: [f64; 2] = [210., 297.];
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct Registration {
    pub scale: f64,
    pub rotation_deg: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matrix: Option<[f64; 4]>,
}
impl Default for Registration {
    fn default() -> Self {
        Self {
            scale: 1.,
            rotation_deg: 0.,
            matrix: None,
        }
    }
}
impl Registration {
    pub fn validate(self) -> Result<Self, String> {
        if !self.scale.is_finite()
            || !(0.1..=10.).contains(&self.scale)
            || !self.rotation_deg.is_finite()
            || self.rotation_deg.abs() > 180.
        {
            return Err(
                "Registration requires scale 0.1..10 and rotation -180..180 degrees".into(),
            );
        }
        if let Some([a,b,c,d]) = self.matrix {
            let det = a*d-b*c;
            let trace = a*a+b*b+c*c+d*d;
            let largest = (trace + (trace*trace-4.*det*det).max(0.).sqrt()) / 2.;
            let smallest = det*det/largest;
            if ![a,b,c,d,det,largest,smallest].iter().all(|v| v.is_finite())
                || det <= 0. || smallest < 0.01 || largest > 100. {
                return Err("Three-point mapping must preserve orientation with axis scales 0.1..10".into());
            }
        }
        Ok(self)
    }
    pub(crate) fn point(self, canvas: Point, origin: [f64; 2]) -> Result<[f64; 2], String> {
        self.validate()?;
        let (sin, cos) = self.rotation_deg.to_radians().sin_cos();
        let (x, y) = (canvas.x - origin[0], origin[1] - canvas.y);
        let [a,b,c,d] = self.matrix.unwrap_or([self.scale*cos,-self.scale*sin,self.scale*sin,self.scale*cos]);
        let work = [a*x+b*y,c*x+d*y];
        if !work.iter().all(|v| v.is_finite()) || (0..2).any(|a| work[a].abs() > AXIS_LIMITS_MM[a])
        {
            return Err(
                "Registered target exceeds finite A4 work envelope (X 210 mm, Y 297 mm)".into(),
            );
        }
        Ok(work)
    }
    pub(crate) fn solve(origin: [f64; 2], second: Point, actual: [f64; 3]) -> Result<Self, String> {
        check_travel([0.; 3], [actual[0], actual[1]])?;
        let nominal = [second.x - origin[0], origin[1] - second.y];
        let a = nominal[0].hypot(nominal[1]);
        let b = actual[0].hypot(actual[1]);
        if ![a, b, actual[2]].iter().all(|v| v.is_finite())
            || a < 100.
            || b < 1.
            || actual[2].abs() > 0.05
        {
            return Err("Registration points must be at least 100 mm apart on paper, with a distinct raised actual second point".into());
        }
        let angle = (actual[1].atan2(actual[0]) - nominal[1].atan2(nominal[0])).to_degrees();
        Self {
            scale: b / a,
            rotation_deg: (angle + 180.).rem_euclid(360.) - 180.,
            matrix: None,
        }
        .validate()
    }
    pub(crate) fn solve_preserving_scale(origin: [f64; 2], second: Point, actual: [f64; 3], scales: [f64; 2]) -> Result<Self, String> {
        check_travel([0.; 3], [actual[0], actual[1]])?;
        let [sx, sy] = scales;
        let nominal = [(second.x - origin[0]) * sx, (origin[1] - second.y) * sy];
        if ![sx, sy, actual[0], actual[1], actual[2]].iter().all(|v| v.is_finite())
            || !(0.1..=10.).contains(&sx) || !(0.1..=10.).contains(&sy)
            || nominal[0].hypot(nominal[1]) < 1. || actual[0].hypot(actual[1]) < 1. || actual[2].abs() > 0.05 {
            return Err("Scale-preserving registration requires valid axis scales and a distinct raised actual point".into());
        }
        let angle = (nominal[0] * actual[1] - nominal[1] * actual[0])
            .atan2(nominal[0] * actual[0] + nominal[1] * actual[1]);
        let (sin, cos) = angle.sin_cos();
        Self {
            scale: (sx + sy) / 2.,
            rotation_deg: angle.to_degrees(),
            matrix: Some([sx * cos, -sy * sin, sx * sin, sy * cos]),
        }
        .validate()
    }
    pub(crate) fn validate_three_points(origin: [f64;2], second: [f64;2], third: [f64;2]) -> Result<(),String> {
        let u = [second[0]-origin[0], origin[1]-second[1]];
        let v = [third[0]-origin[0], origin[1]-third[1]];
        let lengths = [u[0].hypot(u[1]),v[0].hypot(v[1])];
        if !origin.iter().chain(second.iter()).chain(third.iter()).all(|n| n.is_finite())
            || lengths.iter().any(|n| *n < 100.)
            || (u[0]*v[1]-u[1]*v[0]).abs() < lengths[0]*lengths[1]*0.15 {
            return Err("Three calibration points require both baselines >=100 mm and a non-collinear triangle (sine >=0.15)".into());
        }
        Ok(())
    }
    pub(crate) fn solve_three(origin: [f64;2], second: [f64;2], third: [f64;2], actual_second: [f64;3], actual_third: [f64;3]) -> Result<Self,String> {
        Self::validate_three_points(origin,second,third)?;
        for actual in [actual_second,actual_third] {
            check_travel([0.;3],[actual[0],actual[1]])?;
            if !actual[2].is_finite() || actual[2].abs() > 0.05 { return Err("Confirm each point with the pen raised".into()); }
        }
        let u = [second[0]-origin[0],origin[1]-second[1]];
        let v = [third[0]-origin[0],origin[1]-third[1]];
        let det = u[0]*v[1]-v[0]*u[1];
        let [x,y] = [actual_second,actual_third];
        let matrix = [(x[0]*v[1]-y[0]*u[1])/det,(-x[0]*v[0]+y[0]*u[0])/det,
                      (x[1]*v[1]-y[1]*u[1])/det,(-x[1]*v[0]+y[1]*u[0])/det];
        Self {scale: matrix[0].hypot(matrix[2]),rotation_deg: matrix[2].atan2(matrix[0]).to_degrees(),matrix:Some(matrix)}.validate()
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Calibration {
    pub origin: [f64; 2],
    pub wco: [f64; 3],
    pub registration: Registration,
}
pub(crate) fn work_point(canvas: Point, origin: [f64; 2]) -> Result<[f64; 2], String> {
    if ![canvas.x, canvas.y, origin[0], origin[1]]
        .iter()
        .all(|v| v.is_finite())
    {
        return Err("Canvas/origin coordinates must be finite".into());
    }
    let work = [canvas.x - origin[0], origin[1] - canvas.y];
    if (0..2).any(|axis| work[axis].abs() > AXIS_LIMITS_MM[axis]) {
        return Err("Target exceeds the fixed-origin A4 envelope (X 210 mm, Y 297 mm)".into());
    }
    Ok(work)
}
pub(crate) fn check_travel(current: [f64; 3], target: [f64; 2]) -> Result<(), String> {
    if !current.iter().all(|v| v.is_finite()) || !target.iter().all(|v| v.is_finite()) {
        return Err("Missing finite current/target position".into());
    }
    if (0..2).any(|axis| (target[axis] - current[axis]).abs() > AXIS_LIMITS_MM[axis]) {
        return Err("Travel from the current tip exceeds A4 limits (X 210 mm, Y 297 mm)".into());
    }
    Ok(())
}
pub(crate) fn offsets_match(actual: Option<[f64; 3]>, calibration: &Calibration) -> bool {
    actual.is_some_and(|v| {
        (0..3).all(|a| v[a].is_finite() && (v[a] - calibration.wco[a]).abs() <= 0.005)
    })
}
pub(crate) fn check_job_travel(
    job: &Job,
    origin: [f64; 2],
    current: [f64; 3],
) -> Result<(), String> {
    for point in job
        .document
        .strokes
        .iter()
        .filter(|s| s.len() >= 2)
        .flatten()
    {
        check_travel(current, work_point(*point, origin)?)?
    }
    Ok(())
}
pub(crate) fn canvas_job(job: &Job, origin: [f64; 2]) -> Result<Vec<String>, String> {
    registered_job(job, origin, Registration::default())
}
pub(crate) fn registered_job(
    job: &Job,
    origin: [f64; 2],
    registration: Registration,
) -> Result<Vec<String>, String> {
    let mut transformed = job.clone();
    for stroke in &mut transformed.document.strokes {
        for point in stroke {
            let work = registration.point(*point, origin)?;
            *point = Point {
                x: work[0],
                y: -work[1],
            };
        }
    }
    let first = transformed
        .document
        .strokes
        .iter()
        .find(|s| s.len() >= 2)
        .ok_or("No drawable strokes")?[0];
    let mut lines = crate::device::build_job(&transformed, [first.x, -first.y, 0.])?;
    lines.insert(3, "G54".into());
    Ok(lines)
}
pub(crate) fn check_registered_travel(
    job: &Job,
    calibration: &Calibration,
    current: [f64; 3],
) -> Result<(), String> {
    for point in job
        .document
        .strokes
        .iter()
        .filter(|s| s.len() >= 2)
        .flatten()
    {
        check_travel(
            current,
            calibration.registration.point(*point, calibration.origin)?,
        )?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Document;
    #[test]
    fn preserving_axis_scales_recomputes_only_rotation() {
        let origin = [10., 20.];
        let second = Point { x: 110., y: 20. };
        let solved = Registration::solve_preserving_scale(origin, second, [0., 80., 0.], [0.8, 1.2]).unwrap();
        assert!((solved.rotation_deg - 90.).abs() < 1e-9);
        let [a, b, c, d] = solved.matrix.unwrap();
        assert!(a.abs() < 1e-12 && (b + 1.2).abs() < 1e-12 && (c - 0.8).abs() < 1e-12 && d.abs() < 1e-12);
        let mapped = solved.point(second, origin).unwrap();
        assert!(mapped[0].abs() < 1e-9 && (mapped[1] - 80.).abs() < 1e-9);
        assert!(Registration::solve_preserving_scale(origin, second, [80., 0., 0.], [0., 1.]).is_err());
    }
    #[test]
    fn three_points_recover_independent_scales_rotation_and_same_job_mapping() {
        let (s,c) = 12_f64.to_radians().sin_cos();
        let expected = Registration {scale:1.2,rotation_deg:12.,matrix:Some([1.2*c,-0.8*s,1.2*s,0.8*c])};
        let origin = [10.,10.];
        let second = [110.,10.]; let third = [10.,160.];
        let measure = |p:[f64;2]| {let q=expected.point(Point{x:p[0],y:p[1]},origin).unwrap();[q[0],q[1],0.]};
        let solved = Registration::solve_three(origin,second,third,measure(second),measure(third)).unwrap();
        for (a,b) in solved.matrix.unwrap().iter().zip(expected.matrix.unwrap()) { assert!((a-b).abs()<1e-10); }
        let job=Job{document:Document{name:"affine".into(),width_mm:210.,height_mm:297.,strokes:vec![vec![Point{x:30.,y:50.},Point{x:40.,y:70.}]]},feed:1200.,travel_feed:1500.,z_feed:300.,z_down:4.};
        let target=solved.point(job.document.strokes[0][1],origin).unwrap();
        let lines=registered_job(&job,origin,solved).unwrap();
        assert!(lines.contains(&format!("G1 X{:.3} Y{:.3} F1200",target[0],target[1])));
        let legacy:Registration=serde_json::from_str(r#"{"scale":1.2,"rotation_deg":12}"#).unwrap();
        assert!(legacy.matrix.is_none());
    }
    #[test]
    fn three_points_reject_collinearity_reflection_bad_scale_and_lowered_pen() {
        assert!(Registration::solve_three([0.,0.],[100.,0.],[200.,1.],[100.,0.,0.],[200.,1.,0.]).is_err());
        assert!(Registration::solve_three([0.,0.],[100.,0.],[0.,150.],[100.,0.,0.],[0.,150.,0.]).is_err());
        assert!(Registration::solve_three([0.,0.],[100.,0.],[0.,150.],[100.,0.,0.],[0.,-150.,4.]).is_err());
        assert!(Registration::solve_three([0.,0.],[100.,0.],[0.,150.],[0.1,0.,0.],[0.,-150.,0.]).is_err());
        assert!(Registration{scale:1.,rotation_deg:0.,matrix:Some([1.,f64::NAN,0.,1.])}.validate().is_err());
    }
    #[test]
    fn registration_solves_uniform_rotation_scale_and_rejects_short_points() {
        let r = Registration::solve([20., 30.], Point { x: 120., y: 30. }, [0., 120., 0.]).unwrap();
        assert!((r.scale - 1.2).abs() < 1e-9);
        assert!((r.rotation_deg - 90.).abs() < 1e-9);
        assert!(Registration::solve([0.; 2], Point { x: 99., y: 0. }, [99., 0., 0.]).is_err());
        assert!(Registration::solve([0.; 2], Point { x: 100., y: 0. }, [0.; 3]).is_err());
        assert!(Registration::solve([0.; 2], Point { x: 100., y: 0. }, [100., 0., 4.]).is_err());
        assert!(Registration {
            scale: f64::NAN,
            rotation_deg: 0.,
            matrix: None,
        }
        .validate()
        .is_err());
    }
    #[test]
    fn registered_job_uses_same_rotated_scaled_fixed_origin_as_move_to() {
        let job = Job {
            document: Document {
                name: "registration".into(),
                width_mm: 210.,
                height_mm: 297.,
                strokes: vec![vec![Point { x: 30., y: 40. }, Point { x: 40., y: 50. }]],
            },
            feed: 1200.,
            travel_feed: 1500.,
            z_feed: 300.,
            z_down: 4.,
        };
        let registration = Registration {
            scale: 1.2,
            rotation_deg: 90.,
            matrix: None,
        };
        let lines = registered_job(&job, [20., 30.], registration).unwrap();
        assert!(lines.iter().any(|s| s == "G1 X12.000 Y12.000 F1500"));
        assert!(lines.iter().any(|s| s == "G1 X24.000 Y24.000 F1200"));
        assert_eq!(
            registration
                .point(Point { x: 20., y: 30. }, [20., 30.])
                .unwrap(),
            [0., 0.]
        );
    }
    #[test]
    fn fixed_mapping_does_not_depend_on_current_tip() {
        assert_eq!(
            work_point(Point { x: 40., y: 70. }, [10., 100.]).unwrap(),
            [30., 30.]
        );
        assert!(check_travel([-195., 0., 0.], [195., 0.]).is_err());
    }
    #[test]
    fn canvas_job_preserves_page_placement_and_bounds() {
        let job = Job {
            document: Document {
                name: "fixed".into(),
                width_mm: 20.,
                height_mm: 20.,
                strokes: vec![vec![Point { x: 40., y: 70. }, Point { x: 50., y: 80. }]],
            },
            feed: 1200.,
            travel_feed: 1500.,
            z_feed: 300.,
            z_down: 4.,
        };
        let lines = canvas_job(&job, [10., 100.]).unwrap();
        assert!(lines.iter().any(|s| s == "G1 X30.000 Y30.000 F1500"));
        assert!(lines.iter().any(|s| s == "G1 X40.000 Y20.000 F1200"));
        assert!(lines.iter().any(|s| s == "G54"));
        assert!(canvas_job(&job, [-195., 100.]).is_err());
        assert!(check_job_travel(&job, [10., 100.], [-195., 0., 0.]).is_err());
    }

    #[test]
    fn a4_bottom_point_and_axis_limits_are_executable() {
        let mut job = Job {
            document: Document {
                name: "A4 PDF fixed-origin fit".into(),
                width_mm: 210.,
                height_mm: 297.,
                strokes: vec![vec![Point { x: 10., y: 10. }, Point { x: 30., y: 268. }]],
            },
            feed: 1200.,
            travel_feed: 1500.,
            z_feed: 300.,
            z_down: 4.,
        };
        let lines = canvas_job(&job, [210., 0.]).unwrap();
        assert!(lines.iter().any(|s| s == "G1 X-180.000 Y-268.000 F1200"));
        assert!(check_job_travel(&job, [210., 0.], [0.; 3]).is_ok());
        assert!(work_point(Point { x: 210., y: 297. }, [0.; 2]).is_ok());
        assert!(check_travel([0.; 3], [210., -297.]).is_ok());
        assert!(check_travel([0.; 3], [210.01, 0.]).is_err());
        assert!(check_travel([0.; 3], [0., -297.01]).is_err());
        job.document.strokes[0][1].y = 297.01;
        assert!(canvas_job(&job, [0., 0.]).is_err());
        assert!(check_job_travel(&job, [0., 0.], [0.; 3]).is_err());
    }
}
