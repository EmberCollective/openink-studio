//! Conservative GRBL worker. Construction never opens a port. Hardware behavior
//! is based on the 2026-10-25 Python executor; Rust is mock-tested only.
use crate::model::Document;
use crate::{
    model::Point,
    positioning::{self, Calibration, Registration},
};
use serde::{Deserialize, Serialize};
use serialport::SerialPortType;
use std::{
    collections::VecDeque,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PortInfo {
    pub name: String,
    pub description: String,
    pub preferred: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Status {
    pub state: String,
    pub position: Option<[f64; 3]>,
    pub wco: Option<[f64; 3]>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub document: Document,
    pub feed: f64,
    pub travel_feed: f64,
    pub z_feed: f64,
    #[serde(default = "default_z_down")]
    pub z_down: f64,
}
pub fn default_z_down() -> f64 {
    4.0
}
fn valid_z_down(depth: f64) -> bool {
    depth.is_finite() && (2.0..=10.0).contains(&depth)
}
#[derive(Debug)]
pub enum DeviceCommand {
    Scan,
    AutoConnect { swap_xy: bool },
    Connect { port: String, swap_xy: bool },
    Disconnect,
    Jog {
        x: f64,
        y: f64,
        feed: f64,
    },
    PenUp,
    PenDown {
        depth: f64,
    },
    Pause,
    Resume,
    Stop,
    Recover { port: String, swap_xy: bool },
    Calibrate {
        canvas_x: f64,
        canvas_y: f64,
        origin_x: f64,
        origin_y: f64,
        raised_confirmed: bool,
    },
    MoveTo {
        canvas_x: f64,
        canvas_y: f64,
        feed: f64,
    },
    BeginRegistration { canvas_x: f64, canvas_y: f64, preserve_scale: Option<[f64; 2]> },
    FinishRegistration { canvas_x: f64, canvas_y: f64 },
    CaptureRegistrationSecond { canvas_x: f64, canvas_y: f64 },
    FinishRegistrationThird { canvas_x: f64, canvas_y: f64 },
    CancelRegistration,
    ApplyRegistration { origin: [f64; 2], scale: f64, rotation_deg: f64, matrix: Option<[f64;4]> },
    ReturnOrigin,
    ConfirmManualOrigin { raised_confirmed: bool },
    ForgetCalibration(Sender<Result<(), String>>),
    SetRegistrationScale { scales: [f64; 2], reply: Sender<Result<(), String>> },
    ResetOrigin,
    AlignTopRight {
        width_mm: f64,
    },
    Run(Job),
}
#[derive(Clone, Debug)]
pub enum DeviceEvent {
    Ports(Vec<PortInfo>),
    Connected(String),
    Disconnected,
    Status(Status),
    Log(String),
    Error(String),
    JobRejected {
        reason: String,
        running: bool,
    },
    JobStarted {
        anchor: [f64; 3],
    },
    Timing {
        total_seconds: f64,
        cumulative_seconds: Vec<f64>,
    },
    Recovering(bool),
    Positioning(bool),
    CalibrationChanged {
        origin: Option<[f64; 2]>,
    },
    RegistrationChanged { scale: f64, rotation_deg: f64, matrix: Option<[f64;4]> },
    RegistrationPointCaptured { index: u8 },
    AutoOrigin(bool),
    Progress {
        sent: usize,
        total: usize,
    },
    StrokeCompleted { index: usize },
    Completed,
    Stopped,
    Paused(bool),
}
pub struct DeviceService {
    tx: Sender<DeviceCommand>,
    rx: Receiver<DeviceEvent>,
    events: Sender<DeviceEvent>,
    recovery: Arc<RecoveryGate>,
}
#[derive(Default)]
struct RecoveryGate {
    active: AtomicBool,
    stop_requested: AtomicBool,
}
impl DeviceService {
    pub fn new() -> Self {
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        let recovery = Arc::new(RecoveryGate::default());
        let worker_recovery = recovery.clone();
        let worker_events = events.clone();
        thread::spawn(move || worker(commands, worker_events, worker_recovery));
        Self {
            tx,
            rx,
            events,
            recovery,
        }
    }
    pub fn ports() -> Result<Vec<PortInfo>, String> {
        let mut ports: Vec<_> = serialport::available_ports()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|p| {
                let (description, preferred) = match p.port_type {
                    SerialPortType::UsbPort(u) => (
                        format!(
                            "{} {:04X}:{:04X}",
                            u.product.unwrap_or_default(),
                            u.vid,
                            u.pid
                        ),
                        u.vid == 0x1a86 && matches!(u.pid, 0x7523 | 0x5523),
                    ),
                    _ => ("Serial port".into(), false),
                };
                PortInfo {
                    name: p.port_name,
                    description,
                    preferred,
                }
            })
            .collect();
        ports.sort_by_key(|p| (!p.preferred, p.name.clone()));
        Ok(ports)
    }
    pub fn command(&self, c: DeviceCommand) {
        if let DeviceCommand::ForgetCalibration(reply) | DeviceCommand::SetRegistrationScale { reply, .. } = &c {
            if self.recovery.active.load(Ordering::SeqCst) {
                let _ = reply.send(Err("Controller recovery is in progress".into()));
                return;
            }
        }
        if self.recovery.active.load(Ordering::SeqCst) {
            match &c {
                DeviceCommand::Stop => {
                    self.recovery.stop_requested.store(true, Ordering::SeqCst);
                    return;
                }
                DeviceCommand::Run(_) => {
                    let _=self.events.send(DeviceEvent::JobRejected{reason:"Controller recovery is in progress; submit a new job after recovery completes".into(),running:false});
                    return;
                }
                DeviceCommand::Recover { .. }
                | DeviceCommand::Jog { .. }
                | DeviceCommand::PenUp
                | DeviceCommand::PenDown { .. }
                | DeviceCommand::Pause
                | DeviceCommand::Resume
                | DeviceCommand::Connect { .. }
                | DeviceCommand::AutoConnect { .. } => return,
                DeviceCommand::BeginRegistration { .. }
                | DeviceCommand::CancelRegistration
                | DeviceCommand::FinishRegistration { .. }
                | DeviceCommand::CaptureRegistrationSecond { .. }
                | DeviceCommand::FinishRegistrationThird { .. }
                | DeviceCommand::ApplyRegistration { .. }
                | DeviceCommand::Calibrate { .. }
                | DeviceCommand::ConfirmManualOrigin { .. }
                | DeviceCommand::ForgetCalibration(_)
                | DeviceCommand::SetRegistrationScale { .. }
                | DeviceCommand::ResetOrigin
                | DeviceCommand::AlignTopRight { .. }
                | DeviceCommand::MoveTo { .. }
                | DeviceCommand::ReturnOrigin => {
                    let _ = self.events.send(DeviceEvent::Error(
                        "Controller recovery is in progress; position controls are locked".into(),
                    ));
                    let _ = self.events.send(DeviceEvent::Positioning(false));
                    return;
                }
                _ => {}
            }
        }
        let _ = self.tx.send(c);
    }
    pub fn poll(&self) -> Vec<DeviceEvent> {
        self.rx.try_iter().collect()
    }
}
impl Default for DeviceService {
    fn default() -> Self {
        Self::new()
    }
}

/// Keep planning coordinates logical; only controller axis words are exchanged.
pub(crate) fn map_xy_axes(line: &str, swap_xy: bool) -> String {
    if !swap_xy { return line.to_owned(); }
    let mut bytes = line.as_bytes().to_vec();
    let mut comment = false;
    for i in 0..bytes.len() {
        match bytes[i] {
            b';' => break,
            b'(' => comment = true,
            b')' => comment = false,
            b'X' | b'Y' if !comment
                && (i == 0 || bytes[i - 1].is_ascii_whitespace())
                && bytes.get(i + 1).is_some_and(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.')) => {
                    bytes[i] = if bytes[i] == b'X' { b'Y' } else { b'X' };
                }
            _ => {}
        }
    }
    String::from_utf8(bytes).expect("ASCII axis replacement preserves UTF-8")
}

fn vector(s: &str, swap_xy: bool) -> Option<[f64; 3]> {
    let v: Vec<f64> = s
        .split(',')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    (v.len() == 3 && v.iter().all(|v| v.is_finite())).then(|| if swap_xy { [v[1], v[0], v[2]] } else { [v[0], v[1], v[2]] })
}
fn parse_status(s: &str, previous: &Status, swap_xy: bool) -> Option<Status> {
    let mut parts = s.strip_prefix('<')?.strip_suffix('>')?.split('|');
    let state = parts.next()?.to_string();
    let mut wpos = None;
    let mut mpos = None;
    let mut wco = previous.wco;
    for p in parts {
        if let Some(v) = p.strip_prefix("WPos:") {
            wpos = vector(v, swap_xy)
        }
        if let Some(v) = p.strip_prefix("MPos:") {
            mpos = vector(v, swap_xy)
        }
        if let Some(v) = p.strip_prefix("WCO:") {
            wco = vector(v, swap_xy)
        }
    }
    if wpos.is_none() {
        if let (Some(m), Some(o)) = (mpos, wco) {
            wpos = Some([m[0] - o[0], m[1] - o[1], m[2] - o[2]])
        }
    }
    Some(Status {
        state,
        position: wpos,
        wco,
    }) // This specific machine reports mm even with $13=1.
}

// GRBL parses feed rates as floats. Reject values that overflow or underflow
// that representation, while leaving actual motion limits to the firmware.
pub(crate) fn valid_feed(feed: f64) -> bool {
    feed.is_finite() && feed > 0.0 && (feed as f32).is_finite() && (feed as f32) > 0.0
}

pub fn build_job(job: &Job, anchor: [f64; 3]) -> Result<Vec<String>, String> {
    if !anchor.iter().all(|v| v.is_finite()) || anchor[2].abs() > 0.05 {
        return Err("Start at manually calibrated raised Z0".into());
    }
    if ![job.feed, job.travel_feed, job.z_feed]
        .into_iter()
        .all(valid_feed)
    {
        return Err("Feed must be positive, finite and representable by the controller".into());
    }
    if !valid_z_down(job.z_down) {
        return Err("Pen depth must be finite and within 2..=10 mm".into());
    }
    let strokes: Vec<_> = job
        .document
        .strokes
        .iter()
        .filter(|s| s.len() >= 2)
        .collect();
    let first = strokes.first().ok_or("No drawable strokes")?[0];
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for s in &strokes {
        for p in s.iter() {
            let d = [p.x - first.x, first.y - p.y];
            for a in 0..2 {
                if !d[a].is_finite() || d[a].abs() > positioning::AXIS_LIMITS_MM[a] {
                    return Err("Current-point offset exceeds A4 limits (X 210 mm, Y 297 mm)".into());
                }
                min[a] = min[a].min(d[a]);
                max[a] = max[a].max(d[a]);
            }
        }
    }
    if (0..2).any(|a| max[a] - min[a] > positioning::AXIS_LIMITS_MM[a]) {
        return Err("Job span exceeds A4 limits (X 210 mm, Y 297 mm)".into());
    }
    let up = format!("G1 G90 Z0.000 F{}", job.z_feed);
    let mut lines = vec!["G21".into(), "G90".into(), "G94".into(), up.clone()];
    for s in strokes {
        lines.push(up.clone());
        let p = s[0];
        lines.push(format!(
            "G1 X{:.3} Y{:.3} F{}",
            anchor[0] + p.x - first.x,
            anchor[1] + first.y - p.y,
            job.travel_feed
        ));
        lines.push(format!("G1 G90 Z{:.3} F{}", job.z_down, job.z_feed));
        for p in &s[1..] {
            lines.push(format!(
                "G1 X{:.3} Y{:.3} F{}",
                anchor[0] + p.x - first.x,
                anchor[1] + first.y - p.y,
                job.feed
            ));
        }
    }
    lines.push(up);
    Ok(lines)
}

// Existing pen-up lines terminate the preceding drawable stroke, including the final lift.
fn stroke_completion_boundaries(lines: &[String], document: &Document) -> VecDeque<(usize, usize)> {
    let mut indices = document.strokes.iter().enumerate()
        .filter(|(_, stroke)| stroke.len() >= 2).map(|(index, _)| index);
    let mut down = false;
    let mut boundaries = VecDeque::new();
    for (line_index, line) in lines.iter().enumerate() {
        if line.starts_with("G1 G90 Z") {
            if line.starts_with("G1 G90 Z0.000 ") {
                if down {
                    boundaries.push_back((line_index + 1, indices.next().unwrap()));
                }
                down = false;
            } else {
                down = true;
            }
        }
    }
    boundaries
}

// Controller-coordinate inference only: missed physical steps are not observable.
// Repeated/crossing segments choose the earliest match and delay confirmation.
#[derive(Default)]
struct MotionObserver {
    segments: Vec<(usize, [f64; 3], [f64; 3])>,
    completed_prefix: usize,
}
impl MotionObserver {
    fn new(lines: &[String], mut position: [f64; 3]) -> Self {
        let mut segments = vec![];
        for (index, line) in lines.iter().enumerate() {
            if !line.starts_with("G1 ") { continue; }
            let start = position;
            for word in line.split_whitespace() {
                if let Some(axis) = ["X", "Y", "Z"].iter().position(|axis| word.starts_with(axis)) {
                    if let Ok(value) = word[1..].parse::<f64>() { position[axis] = value; }
                }
            }
            segments.push((index + 1, start, position));
        }
        Self { segments, completed_prefix: 0 }
    }
    fn observe(&mut self, position: [f64; 3], dispatched: usize) -> usize {
        if let Some((line, _, _)) = self.segments.iter().find(|(line, start, end)| {
            *line > self.completed_prefix && *line <= dispatched
                && point_on_motion(position, *start, *end)
        }) {
            self.completed_prefix = self.completed_prefix.max(line - 1);
        }
        self.completed_prefix
    }
}
fn point_on_motion(point: [f64; 3], start: [f64; 3], end: [f64; 3]) -> bool {
    let direction = std::array::from_fn::<_, 3, _>(|axis| end[axis] - start[axis]);
    let length_squared: f64 = direction.iter().map(|v| v * v).sum();
    let fraction = if length_squared == 0. { 0. } else {
        (0..3).map(|axis| (point[axis] - start[axis]) * direction[axis]).sum::<f64>() / length_squared
    }.clamp(0., 1.);
    (0..3).map(|axis| (point[axis] - start[axis] - fraction * direction[axis]).powi(2))
        .sum::<f64>() <= 0.05_f64.powi(2)
}

/// Export relative XY without assuming any historical origin. Z stays absolute.
/// Feed limits belong to firmware; only defaults 1200/1500 and Z300
/// have the 2026-10-25 hardware evidence. This function never opens a port.
pub fn build_relative_job(job: &Job) -> Result<Vec<String>, String> {
    let absolute = build_job(job, [0.0; 3])?;
    let mut previous = [0.0; 2];
    let mut relative = Vec::with_capacity(absolute.len());
    for line in absolute {
        if line == "G90" {
            continue;
        }
        if line.starts_with("G1 X") {
            let parts: Vec<_> = line.split_whitespace().collect();
            let x = parts[1]
                .strip_prefix('X')
                .and_then(|s| s.parse::<f64>().ok())
                .ok_or("Invalid generated X")?;
            let y = parts[2]
                .strip_prefix('Y')
                .and_then(|s| s.parse::<f64>().ok())
                .ok_or("Invalid generated Y")?;
            relative.push(format!(
                "G1 G91 X{:.3} Y{:.3} {}",
                x - previous[0],
                y - previous[1],
                parts[3]
            ));
            previous = [x, y];
        } else {
            relative.push(line)
        }
    }
    Ok(relative)
}
pub fn build_canvas_job(job: &Job, origin: [f64; 2]) -> Result<Vec<String>, String> {
    positioning::canvas_job(job, origin)
}
#[derive(Clone, Copy, PartialEq)]
enum CalibrationPhase {
    Programming,
    Verify,
}
#[derive(Clone, Copy, PartialEq)]
enum MovePhase {
    Raising,
    WaitRaised,
    Travelling,
    WaitTarget,
}
enum PositioningOperation {
    Calibrate {
        origin: [f64; 2],
        registration: Registration,
        target: [f64; 3],
        phase: CalibrationPhase,
        started: Instant,
    },
    Move {
        target: [f64; 2],
        feed: f64,
        phase: MovePhase,
        started: Instant,
    },
}

trait Wire: Read + Write + Send {}
impl<T: Read + Write + Send> Wire for T {}
struct Link {
    port: Box<dyn Wire>,
    rx: Vec<u8>,
    swap_xy: bool,
}
impl Link {
    fn write(&mut self, b: &[u8]) -> Result<(), String> {
        if self.swap_xy {
            if let Ok(line) = std::str::from_utf8(b) {
                return self.port.write_all(map_xy_axes(line, true).as_bytes()).map_err(|e| e.to_string());
            }
        }
        self.port.write_all(b).map_err(|e| e.to_string())
    }
    fn lines(&mut self) -> Result<Vec<String>, String> {
        let mut b = [0; 4096];
        match self.port.read(&mut b) {
            Ok(n) => self.rx.extend_from_slice(&b[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(e.to_string()),
        }
        if self.rx.len() > 65536 {
            return Err("Oversized response".into());
        }
        let mut out = vec![];
        while let Some(i) = self.rx.iter().position(|c| *c == b'\n') {
            let line = self.rx.drain(..=i).collect::<Vec<_>>();
            let s = String::from_utf8_lossy(&line).trim().to_string();
            if !s.is_empty() {
                out.push(s)
            }
        }
        Ok(out)
    }
}
fn handshake_failure(
    identity: bool,
    ack: bool,
    status: Option<&Status>,
    observations: &[String],
) -> String {
    let mut missing = vec![];
    if !identity {
        missing.push("GRBL identity from $I/[VER:]")
    }
    if !ack {
        missing.push("$I acknowledgement")
    }
    if status.is_none() {
        missing.push("realtime status from ?")
    }
    let state = status.map(|s| s.state.as_str()).unwrap_or("unknown");
    let received = if observations.is_empty() {
        "no complete response".to_string()
    } else {
        observations.join("; ")
    };
    format!("Read-only GRBL handshake incomplete (missing: {}; controller state: {state}; received: {received}). Port closed without reset/unlock/resume. A previous hold may retain queued motion; inspect the machine before any explicit recovery",missing.join(", "))
}
fn open_link(name: &str, swap_xy: bool) -> Result<Link, String> {
    let mut port = serialport::new(name, 115200)
        .data_bits(serialport::DataBits::Eight)
        .parity(serialport::Parity::None)
        .stop_bits(serialport::StopBits::One)
        .flow_control(serialport::FlowControl::None)
        .timeout(Duration::from_millis(30))
        .open()
        .map_err(|e| e.to_string())?;
    port.write_data_terminal_ready(true)
        .map_err(|e| e.to_string())?;
    port.write_request_to_send(true)
        .map_err(|e| e.to_string())?;
    Ok(Link {
        port: Box::new(port),
        rx: vec![], swap_xy,
    })
}
fn connect(name: &str, swap_xy: bool) -> Result<(Link, Status), String> {
    let l = open_link(name, swap_xy)?;
    // Recovery starts with realtime status only, so a retained Hold cannot
    // swallow an identity query. Never resume the abandoned planner queue.
    let (l, _) = recover_session(l, Duration::from_secs(3), false, true)?;
    handshake(l, Duration::from_secs(3))
}

/// Execute one bounded preparation command, then require a fresh Idle report.
/// ACK alone only means accepted by the planner, never physical completion.
fn prepare_line(l: &mut Link, status: &mut Status, line: &str) -> Result<(), String> {
    prepare_line_cancel(l, status, line, None)
}
fn prepare_line_cancel(
    l: &mut Link,
    status: &mut Status,
    line: &str,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    check_preparation_cancel(cancel)?;
    l.write(format!("{line}\n").as_bytes())?;
    let end = Instant::now() + Duration::from_secs(5);
    let mut ack = false;
    let mut g54 = false;
    let mut query = Instant::now() - Duration::from_millis(100);
    while Instant::now() < end {
        check_preparation_cancel(cancel)?;
        let ack_before_batch = ack;
        for reply in l.lines()? {
            if reply == "ok" {
                if ack {
                    return Err("Duplicate ACK during pen/origin preparation".into());
                }
                ack = true;
                // Ask after the ACK, rather than accepting an earlier Idle.
                l.write(b"?")?;
            } else if reply.starts_with("error:")
                || reply.starts_with("ALARM:")
                || reply.starts_with("Grbl ")
            {
                return Err(format!("Preparation interrupted: {reply}"));
            } else if reply.starts_with("[GC:") {
                g54 = reports_g54(&reply);
            } else if let Some(s) = parse_status(&reply, status, l.swap_xy) {
                *status = s;
                if ack_before_batch && status.state == "Idle" {
                    if line == "$G" && !g54 {
                        return Err(
                            "Preparation requires active G54; origin was not changed".into()
                        );
                    }
                    return Ok(());
                }
                if status.state.starts_with("Hold") || status.state.starts_with("Alarm") {
                    return Err(format!("Preparation interrupted in {}", status.state));
                }
            }
        }
        if query.elapsed() >= Duration::from_millis(100) {
            l.write(b"?")?;
            query = Instant::now();
        }
    }
    Err("Pen/origin preparation timed out; old work will not resume".into())
}

fn check_preparation_cancel(cancel: Option<&AtomicBool>) -> Result<(), String> {
    if cancel.is_some_and(|v| v.load(Ordering::SeqCst)) {
        Err("Pen/origin preparation cancelled by Stop".into())
    } else {
        Ok(())
    }
}
fn wait_prepared_position(
    l: &mut Link,
    status: &mut Status,
    cancel: Option<&AtomicBool>,
    matches: impl Fn(&Status) -> bool,
) -> Result<(), String> {
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        check_preparation_cancel(cancel)?;
        l.write(b"?")?;
        let query_end = Instant::now() + Duration::from_millis(100);
        while Instant::now() < query_end {
            check_preparation_cancel(cancel)?;
            for reply in l.lines()? {
                if let Some(s) = parse_status(&reply, status, l.swap_xy) {
                    *status = s;
                    if status.state == "Idle" && matches(status) {
                        return Ok(());
                    }
                    if status.state.starts_with("Hold") || status.state.starts_with("Alarm") {
                        return Err("Pen preparation interrupted".into());
                    }
                } else if reply == "ok"
                    || reply.starts_with("error:")
                    || reply.starts_with("ALARM:")
                    || reply.starts_with("Grbl ")
                {
                    return Err(format!(
                        "Unexpected response while verifying pen position: {reply}"
                    ));
                }
            }
        }
    }
    Err("Requested pen/origin position was not verified before timeout".into())
}

fn raised_machine_z(status: &Status) -> Result<f64, String> {
    let p = status.position.ok_or("Missing pen position")?;
    let w = status
        .wco
        .ok_or("Missing work offset for physical pen height")?;
    if !p.iter().chain(w.iter()).all(|v| v.is_finite()) || !(-0.05..=10.05).contains(&p[2]) {
        return Err(
            "Pen height is outside the known 0..10 range; physical raised height is unknown".into(),
        );
    }
    Ok(w[2])
}

fn lift_to_machine_z(
    l: &mut Link,
    status: &mut Status,
    raised: f64,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    prepare_line_cancel(l, status, "G21", cancel)?;
    prepare_line_cancel(l, status, &format!("G90 G53 G1 Z{raised:.3} F300"), cancel)?;
    wait_prepared_position(l, status, cancel, |s| match (s.position, s.wco) {
        (Some(p), Some(w)) => (p[2] + w[2] - raised).abs() <= 0.05,
        _ => false,
    })
}

fn prepare_origin(
    l: &mut Link,
    status: &mut Status,
    origin: [f64; 2],
    cancel: &AtomicBool,
) -> Result<Calibration, String> {
    prepare_line_cancel(l, status, "$G", Some(cancel))?;
    let raised = raised_machine_z(status)?;
    lift_to_machine_z(l, status, raised, Some(cancel))?;
    prepare_line_cancel(l, status, "G54", Some(cancel))?;
    // XY stays physically stationary; only the work coordinate is redefined.
    prepare_line_cancel(l, status, "G10 L20 P1 X0 Y0 Z0", Some(cancel))?;
    prepare_line_cancel(l, status, "$G", Some(cancel))?;
    wait_prepared_position(l, status, Some(cancel), |s| {
        s.position
            .is_some_and(|p| p.iter().all(|v| v.abs() <= 0.01))
    })?;
    Ok(Calibration {
        origin,
        registration: Registration::default(),
        wco: status.wco.ok_or("Missing origin offset")?,
    })
}
fn capture_registration_position(
    l: &mut Link,
    status: &mut Status,
    confirmed: &Calibration,
) -> Result<[f64; 3], String> {
    // Confirmations may arrive while the pen is down. Lift to the established
    // raised plane and sample a fresh Idle XY report before accepting the point.
    status.wco = None;
    lift_to_machine_z(l, status, confirmed.wco[2], None)?;
    if !positioning::offsets_match(status.wco, confirmed) {
        return Err("Work offset changed; repeat registration".into());
    }
    status.position.ok_or_else(|| "Missing calibration point position".into())
}
fn verify_registration_origin(
    status: &Status,
    confirmed: &Calibration,
    cancel: &AtomicBool,
) -> Result<Calibration, String> {
    if cancel.load(Ordering::SeqCst) { return Err("Registration canceled".into()); }
    let current = status.position.ok_or("Missing registration position")?;
    if status.state != "Idle" || !current.iter().all(|v| v.is_finite()) || !positioning::offsets_match(status.wco, confirmed) || current[2].abs() > 0.05 {
        return Err("Registration requires a raised pen and verified work offset".into());
    }
    confirmed.registration.point(Point { x: confirmed.origin[0], y: confirmed.origin[1] }, confirmed.origin)?;
    // Point 1 already defines XY0; finishing must not rebase or move the tip.
    Ok(confirmed.clone())
}
fn handshake(mut l: Link, timeout: Duration) -> Result<(Link, Status), String> {
    // 2026-10-25 read-only hardware evidence: in Hold:0 this firmware still
    // answers realtime '?' but retains ordinary '$I\n' bytes in RX without
    // processing/ACKing them. Never add ordinary lines to a held controller.
    l.write(b"?")?;
    let mut end = Instant::now() + timeout;
    let mut identity_query_sent = false;
    let mut identity = false;
    let mut ack = false;
    let mut status = None;
    let mut observations = vec![];
    while Instant::now() < end {
        for s in l.lines()? {
            observations.push(s.clone());
            if observations.len() > 8 {
                observations.remove(0);
            }
            if s.starts_with("[VER:") || s.starts_with("Grbl 1.") {
                identity = true
            }
            if s == "ok" {
                if !identity_query_sent {
                    return Err("Unexpected stale ACK before identity query; no $I, reset, unlock or resume was sent. Inspect any queued controller commands before reconnecting".into());
                }
                if ack {
                    return Err("Extra ACK during handshake".into());
                }
                ack = true
            }
            if s.starts_with("error:") || s.starts_with("ALARM:") {
                return Err(format!("GRBL rejected the read-only connection query: {s}. No reset, unlock or resume was sent; inspect any retained hold/alarm before recovery"));
            }
            if let Some(st) = parse_status(&s, &status.clone().unwrap_or_default(), l.swap_xy) {
                status = Some(st)
            }
        }
        if let Some(st) = status.as_ref() {
            if st.state != "Idle" {
                return Err(format!("Controller is {}. Connection refused before further ordinary commands: $I was {}sent; old queued commands may remain. No reset, unlock or resume was sent. Manually confirm the machine and recover/inspect the retained queue before reconnecting",st.state,if identity_query_sent{"already "}else{"not "}));
            }
            if !identity_query_sent {
                l.write(b"$I\n")?;
                identity_query_sent = true;
                identity = false;
                end = Instant::now() + timeout;
            } else if identity && ack {
                return Ok((l, status.unwrap()));
            }
        }
    }
    let mut error = handshake_failure(identity, ack, status.as_ref(), &observations);
    if !identity_query_sent {
        error.push_str(" Identity query $I was not sent because no Idle status was confirmed.");
    }
    Err(error)
}

/// Discard pre-recovery host replies until a read timeout, then ask for a fresh
/// realtime status. In particular, old job ACKs never acknowledge the new $I.
fn discard_old_input(l: &mut Link, timeout: Duration) -> Result<(), String> {
    l.rx.clear();
    let end = Instant::now() + timeout;
    let mut buffer = [0u8; 4096];
    loop {
        match l.port.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                return Ok(())
            }
            Err(e) => return Err(format!("Cannot drain old controller replies: {e}")),
        }
        if Instant::now() >= end {
            return Err(
                "Old controller replies did not become quiet; recovery was not completed".into(),
            );
        }
    }
}
/// Only an explicit Stop/Recover calls this reset flow. Normal connection is
/// still read-only. Stop clears the old job without resuming it or moving Z.
fn recover_session(
    l: Link,
    timeout: Duration,
    request_hold: bool,
    allow_idle_without_reset: bool,
) -> Result<(Link, Status), String> {
    recover_session_with_reference(
        l,
        timeout,
        request_hold,
        allow_idle_without_reset,
        &mut None,
    )
}
fn recover_session_with_reference(
    l: Link,
    timeout: Duration,
    request_hold: bool,
    allow_idle_without_reset: bool,
    reference: &mut Option<f64>,
) -> Result<(Link, Status), String> {
    recover_session_impl(
        l,
        timeout,
        request_hold,
        allow_idle_without_reset,
        false,
        reference,
    )
}
fn recover_session_mode(
    l: Link,
    timeout: Duration,
    request_hold: bool,
    allow_idle_without_reset: bool,
    jog_cancel: bool,
) -> Result<(Link, Status), String> {
    recover_session_impl(
        l,
        timeout,
        request_hold,
        allow_idle_without_reset,
        jog_cancel,
        &mut None,
    )
}
fn recover_session_impl(
    mut l: Link,
    timeout: Duration,
    request_hold: bool,
    allow_idle_without_reset: bool,
    jog_cancel: bool,
    reference: &mut Option<f64>,
) -> Result<(Link, Status), String> {
    let mut hold_sent = request_hold && !jog_cancel;
    let mut cancel_sent = jog_cancel;
    if jog_cancel {
        l.write(b"\x85")?;
    } else if request_hold {
        l.write(b"!")?;
    }
    discard_old_input(&mut l, timeout)?;
    l.write(b"?")?;
    let end = Instant::now() + timeout;
    let mut last_query = Instant::now();
    let mut last_state = "unknown".to_string();
    let mut latest = Status::default();
    let settled = loop {
        if Instant::now() >= end {
            return Err(format!("Recovery could not confirm stationary Hold:0/Idle (last state: {last_state}); no reset was sent"));
        }
        let mut settled = None;
        for line in l.lines()? {
            if line.starts_with("ALARM:") {
                return Err(format!(
                    "Recovery refused while controller reports {line}; no unlock or reset was sent"
                ));
            }
            if let Some(status) = parse_status(&line, &latest, l.swap_xy) {
                latest = status.clone();
                last_state = status.state.clone();
                // Only the last status in this read batch can authorize a
                // reset. WCO is intermittent on the real controller: keep
                // polling stationary reports until the physical Z reference
                // can be established instead of rejecting the first Hold.
                settled = None;
                match status.state.as_str(){
                    "Hold:0"=>{settled=Some(status);},
                    "Idle"=>{
                        // Once we requested a running stop, require an actual
                        // Hold:0 confirmation. A delayed old Idle can never
                        // authorize resetting a machine still decelerating.
                        if !hold_sent {settled=Some(status);}
                    },
                    "Jog"=>{
                        settled=None;
                        if !cancel_sent && !hold_sent {l.write(b"\x85")?;cancel_sent=true;last_query=Instant::now()-Duration::from_millis(50);break}
                    },
                    "Run"|"Hold:1"=>{
                        settled=None;
                        if !hold_sent{l.write(b"!")?;hold_sent=true;last_query=Instant::now()-Duration::from_millis(50);break}
                    },
                    _=>return Err(format!("Recovery cannot reset controller in {}; wait for a stationary state and inspect the machine",status.state)),
                }
            }
            // Old ACKs, metadata and startup text are deliberately not used.
        }
        if let Some(status) = settled {
            if status
                .position
                .is_some_and(|p| p.iter().all(|v| v.is_finite()))
                && status.wco.is_some_and(|w| w.iter().all(|v| v.is_finite()))
            {
                break status;
            }
        }
        if last_query.elapsed() >= Duration::from_millis(50) {
            l.write(b"?")?;
            last_query = Instant::now();
        }
    };
    if allow_idle_without_reset && !hold_sent && !cancel_sent && settled.state == "Idle" {
        return Ok((l, settled));
    }
    let raised = match *reference {
        Some(z) => z,
        None => {
            let z = raised_machine_z(&settled)?;
            *reference = Some(z);
            z
        }
    };
    l.rx.clear();
    l.write(b"\x18")?;
    let end = Instant::now() + timeout;
    loop {
        if Instant::now() >= end {
            return Err("Controller reset was requested after stopping, but no new GRBL startup banner arrived; recovery is not complete".into());
        }
        let lines = l.lines()?;
        if lines.iter().any(|line| line.starts_with("Grbl ")) {
            // Everything before this new startup epoch (including old ACKs and
            // old status reports) is abandoned. The handshake asks afresh.
            l.rx.clear();
            let (mut l, mut status) = handshake(l, timeout)
                .map_err(|e| format!("Controller restarted but recovery handshake failed: {e}"))?;
            lift_to_machine_z(&mut l, &mut status, raised, None)?;
            // A reset may change work offsets: establish raised Z only after
            // the physical lift, never mistake reset-reported Z0 for pen-up.
            prepare_line(&mut l, &mut status, "G54")?;
            prepare_line(&mut l, &mut status, "G10 L20 P1 Z0")?;
            return Ok((l, status));
        }
    }
}
#[derive(Default)]
struct RecoveryCommands {
    stop: bool,
    disconnect: bool,
    discarded: usize,
}
fn discard_recovery_commands(commands: &Receiver<DeviceCommand>) -> RecoveryCommands {
    let mut out = RecoveryCommands::default();
    while let Ok(command) = commands.try_recv() {
        match command {
            DeviceCommand::Stop => out.stop = true,
            DeviceCommand::Disconnect => out.disconnect = true,
            _ => out.discarded += 1,
        }
    }
    out
}
fn worker(
    commands: Receiver<DeviceCommand>,
    events: Sender<DeviceEvent>,
    recovery: Arc<RecoveryGate>,
) {
    worker_loop(commands, events, None, recovery, None, None);
}
fn accept_ack(pending: &mut Option<Instant>) -> Result<(), String> {
    pending
        .take()
        .map(|_| ())
        .ok_or_else(|| "Unexpected ACK: stream synchronization lost".into())
}
fn ack_timed_out(pending: Option<Instant>, paused: bool, now: Instant) -> bool {
    !paused && pending.is_some_and(|t| now.saturating_duration_since(t) > Duration::from_secs(15))
}
fn reports_g54(line: &str) -> bool {
    line.strip_prefix("[GC:")
        .and_then(|s| s.strip_suffix(']'))
        .is_some_and(|s| s.split_whitespace().any(|word| word == "G54"))
}
/// A synchronized read-only preflight can refuse a job without faulting the
/// serial transport. None means wait for an intermittent GRBL WCO report.
fn check_preflight(
    job: &Job,
    status: &Status,
    modal_g54: bool,
    calibration: &Calibration,
) -> Result<Option<Vec<String>>, String> {
    if status.state != "Idle" {
        return Err(format!(
            "Cannot start: controller is {}; wait for Idle and inspect the machine",
            status.state
        ));
    }
    if !modal_g54 {
        return Err("Cannot start: $G did not confirm active G54; inspect the work coordinate system (no origin was changed)".into());
    }
    let Some(wco) = status.wco else {
        return Ok(None);
    };
    if !positioning::offsets_match(Some(wco), calibration) {
        return Err(format!("Cannot start: WCO is [{:.3}, {:.3}, {:.3}], different from the confirmed calibration; recalibrate the tip", wco[0], wco[1], wco[2]));
    }
    let Some(position) = status.position else {
        return Ok(None);
    };
    if position[2].is_finite() && position[2].abs() > 0.05 {
        return Err(format!("Cannot start: Z={:.3} mm; the pen must already be at calibrated raised Z0. Connection remains open; no automatic pen movement was sent", position[2]));
    }
    positioning::check_registered_travel(job, calibration, position)?;
    positioning::registered_job(job, calibration.origin, calibration.registration)
        .map(Some)
        .map_err(|reason| format!("Cannot start: {reason}"))
}
#[cfg(test)]
fn worker_inner(
    commands: Receiver<DeviceCommand>,
    events: Sender<DeviceEvent>,
    initial: Option<(Link, Status)>,
) {
    // Legacy protocol fixtures model an already calibrated zero-offset
    // session, with their drawable first point at canvas (5,8). Production
    // connections always start uncalibrated; new calibration tests use None.
    let calibration = initial.as_ref().map(|_| Calibration {
        origin: [5., 8.],
        wco: [0.; 3],
        registration: Registration::default(),
    });
    worker_loop(
        commands,
        events,
        initial,
        Arc::new(RecoveryGate::default()),
        calibration,
        None,
    );
}
fn worker_loop(
    commands: Receiver<DeviceCommand>,
    events: Sender<DeviceEvent>,
    initial: Option<(Link, Status)>,
    recovery: Arc<RecoveryGate>,
    initial_calibration: Option<Calibration>,
    initial_port: Option<String>,
) {
    let emit = |e| {
        let _ = events.send(e);
    };
    let mut swap_xy = initial.as_ref().is_some_and(|(link, _)| link.swap_xy);
    let mut link: Option<Link> = None;
    let mut connected_port: Option<String> = initial_port;
    let mut calibration = initial_calibration;
    let mut registration_pending = false;
    let mut registration_second: Option<([f64;2],[f64;3])> = None;
    let mut explicit_origin = calibration.is_some();
    let mut positioning_operation: Option<PositioningOperation> = None;
    let mut status = Status::default();
    if let Some((l, s)) = initial {
        link = Some(l);
        status = s;
    }
    let mut queue: VecDeque<String> = VecDeque::new();
    let mut pending: Option<Instant> = None;
    let mut paused = false;
    let mut running = false;
    let mut preflight: Option<Job> = None;
    let mut preflight_started: Option<Instant> = None;
    let mut modal = false;
    let mut finishing = false;
    let mut total = 0;
    let mut sent = 0;
    let mut stroke_boundaries: VecDeque<(usize, usize)> = VecDeque::new();
    let mut queried_job_prefix = 0;
    let mut motion_observer = MotionObserver::default();
    let mut last_query = Instant::now();
    let mut last_received = Instant::now();
    let mut held_after_stop = false;
    loop {
        let command = if link.is_none() {
            match commands.recv() {
                Ok(c) => Some(c),
                Err(_) => break,
            }
        } else {
            match commands.try_recv() {
                Ok(c) => Some(c),
                Err(mpsc::TryRecvError::Disconnected) => break,
                Err(_) => None,
            }
        };
        let mut fault = None;
        if let Some(c) = command {
            match c {
                DeviceCommand::Scan => match DeviceService::ports() {
                    Ok(p) => emit(DeviceEvent::Ports(p)),
                    Err(e) => emit(DeviceEvent::Error(e)),
                },
                DeviceCommand::Connect { .. } | DeviceCommand::AutoConnect { .. } if link.is_some() => emit(
                    DeviceEvent::Error("Disconnect before connecting again".into()),
                ),
                DeviceCommand::Connect { port: name, swap_xy: requested } => {
                    swap_xy = requested;
                    match connect(&name, swap_xy) {
                    Ok((l, s)) => {
                        link = Some(l);
                        connected_port = Some(name.clone());
                        last_received = Instant::now();
                        held_after_stop = s.state != "Idle";
                        status = s.clone();
                        calibration = None;
                        registration_pending = false; registration_second = None;
                        explicit_origin = false;
                        emit(DeviceEvent::AutoOrigin(true));
                        emit(DeviceEvent::CalibrationChanged { origin: None });
                        emit(DeviceEvent::Connected(name));
                        emit(DeviceEvent::Status(s));
                    }
                    Err(e) => emit(DeviceEvent::Error(e)),
                    }
                }
                DeviceCommand::AutoConnect { swap_xy: requested } => {
                    swap_xy = requested;
                    match DeviceService::ports() {
                    Ok(p) => {
                        let candidates: Vec<_> = p.into_iter().filter(|p| p.preferred).collect();
                        if candidates.len() != 1 {
                            emit(DeviceEvent::Error("Select a port explicitly: automatic matching requires exactly one CH340 candidate".into()))
                        } else {
                            let name = &candidates[0].name;
                            match connect(name, swap_xy) {
                                Ok((l, s)) => {
                                    link = Some(l);
                                    connected_port = Some(name.clone());
                                    last_received = Instant::now();
                                    held_after_stop = s.state != "Idle";
                                    status = s.clone();
                                    calibration = None;
                        registration_pending = false; registration_second = None;
                                    explicit_origin = false;
                                    emit(DeviceEvent::AutoOrigin(true));
                                    emit(DeviceEvent::CalibrationChanged { origin: None });
                                    emit(DeviceEvent::Connected(name.clone()));
                                    emit(DeviceEvent::Status(s))
                                }
                                Err(e) => emit(DeviceEvent::Error(e)),
                            }
                        }
                    }
                    Err(e) => emit(DeviceEvent::Error(e)),
                    }
                }
                DeviceCommand::Disconnect => {
                    let needs_hold = running
                        || positioning_operation.is_some()
                        || pending.is_some()
                        || !queue.is_empty()
                        || status.state != "Idle";
                    if needs_hold {
                        held_after_stop = true;
                        if let Some(l) = link.as_mut() {
                            let _ = l.write(b"!\x85");
                        }
                    }
                    link = None;
                    connected_port = None;
                    queue.clear();
                    pending = None;
                    preflight = None;
                    preflight_started = None;
                    running = false;
                    finishing = false;
                    paused = false;
                    positioning_operation = None;
                    calibration = None;
                        registration_pending = false; registration_second = None;
                    explicit_origin = false;
                    emit(DeviceEvent::AutoOrigin(true));
                    emit(DeviceEvent::Positioning(false));
                    emit(DeviceEvent::CalibrationChanged { origin: None });
                    emit(DeviceEvent::Disconnected)
                }
                DeviceCommand::Stop | DeviceCommand::Recover { .. } => {
                    let is_stop = matches!(c, DeviceCommand::Stop);
                    if is_stop && link.is_none() {
                        emit(DeviceEvent::Error("Cannot stop an offline session: use explicit recovery to discard the controller's old job and reconnect".into()));
                        emit(DeviceEvent::Recovering(false));
                        continue;
                    }
                    let target = match c {
                        DeviceCommand::Recover { port: name, swap_xy: requested } => {
                            if link.is_some() && requested != swap_xy {
                                emit(DeviceEvent::Error("Disconnect before changing the controller axis mapping".into()));
                                emit(DeviceEvent::Recovering(false));
                                continue;
                            }
                            swap_xy = requested;
                            Some(name)
                        },
                        _ => connected_port.clone(),
                    };
                    if !is_stop
                        && link.is_some()
                        && connected_port
                            .as_ref()
                            .zip(target.as_ref())
                            .is_some_and(|(a, b)| a != b)
                    {
                        emit(DeviceEvent::Error("Recovery target differs from the connected port; disconnect that session first".into()));
                        emit(DeviceEvent::Recovering(false));
                        continue;
                    }
                    let clean_idle = is_stop
                        && !running
                        && positioning_operation.is_none()
                        && pending.is_none()
                        && queue.is_empty()
                        && !paused
                        && status.state == "Idle";
                    let stop_jog = is_stop && !running && status.state == "Jog";
                    recovery.stop_requested.store(is_stop, Ordering::SeqCst);
                    recovery.active.store(true, Ordering::SeqCst);
                    emit(DeviceEvent::Recovering(true));
                    positioning_operation = None;
                    calibration = None;
                        registration_pending = false; registration_second = None;
                    explicit_origin = false;
                    emit(DeviceEvent::AutoOrigin(true));
                    emit(DeviceEvent::Positioning(false));
                    emit(DeviceEvent::CalibrationChanged { origin: None });
                    // Explicitly abandon every old local command before any
                    // blocking stop/reset handshake. No old Run can continue.
                    queue.clear();
                    pending = None;
                    preflight = None;
                    preflight_started = None;
                    running = false;
                    finishing = false;
                    paused = false;
                    modal = false;
                    let old_link = match link.take() {
                        Some(l) => Ok(l),
                        None => open_link(target.as_deref().unwrap_or(""), swap_xy),
                    };
                    let result = old_link.and_then(|l| {
                        if stop_jog {
                            recover_session_mode(l, Duration::from_secs(3), false, false, true)
                        } else {
                            recover_session(
                                l,
                                Duration::from_secs(3),
                                is_stop && !clean_idle,
                                clean_idle,
                            )
                        }
                    });
                    let queued = discard_recovery_commands(&commands);
                    let stop_requested =
                        recovery.stop_requested.swap(false, Ordering::SeqCst) || queued.stop;
                    if queued.discarded > 0 {
                        emit(DeviceEvent::Log(format!(
                            "Discarded {} stale commands submitted during controller recovery",
                            queued.discarded
                        )))
                    }
                    match result {
                        Ok((mut new_link, mut new_status)) => {
                            if clean_idle {
                                match raised_machine_z(&new_status).and_then(|z| {
                                    lift_to_machine_z(&mut new_link, &mut new_status, z, None)
                                }) {
                                    Ok(()) => {}
                                    Err(e) => {
                                        connected_port = None;
                                        held_after_stop = true;
                                        emit(DeviceEvent::Error(e));
                                        emit(DeviceEvent::Disconnected);
                                        recovery.active.store(false, Ordering::SeqCst);
                                        emit(DeviceEvent::Recovering(false));
                                        continue;
                                    }
                                }
                            }
                            status = new_status.clone();
                            held_after_stop = false;
                            last_received = Instant::now();
                            last_query = Instant::now();
                            if queued.disconnect {
                                link = None;
                                connected_port = None;
                                emit(DeviceEvent::Disconnected)
                            } else {
                                link = Some(new_link);
                                connected_port = target;
                                if let Some(name) = connected_port.as_ref() {
                                    emit(DeviceEvent::Connected(name.clone()))
                                }
                                emit(DeviceEvent::Status(new_status));
                            }
                            if stop_requested {
                                emit(DeviceEvent::Stopped)
                            }
                        }
                        Err(reason) => {
                            link = None;
                            connected_port = None;
                            held_after_stop = true;
                            emit(DeviceEvent::Error(format!(
                                "Controller recovery failed: {reason}"
                            )));
                            emit(DeviceEvent::Disconnected)
                        }
                    }
                    recovery.active.store(false, Ordering::SeqCst);
                    emit(DeviceEvent::Recovering(false));
                }
                DeviceCommand::Pause => {
                    if let Some(l) = link.as_mut() {
                        if let Err(e) = l.write(b"!") {
                            fault = Some(e)
                        }
                        paused = true;
                        emit(DeviceEvent::Paused(true));
                    }
                }
                DeviceCommand::Resume => {
                    if paused && !held_after_stop {
                        if let Some(l) = link.as_mut() {
                            if let Err(e) = l.write(b"~") {
                                fault = Some(e)
                            }
                            paused = false;
                            if pending.is_some() {
                                pending = Some(Instant::now())
                            }
                            if let Some(PositioningOperation::Move { started, .. }) =
                                positioning_operation.as_mut()
                            {
                                *started = Instant::now();
                            }
                            emit(DeviceEvent::Paused(false));
                        }
                    } else {
                        emit(DeviceEvent::Error(
                            "Resume requires a pause in this session; abandoned jobs cannot be resumed"
                                .into(),
                        ))
                    }
                }
                DeviceCommand::ForgetCalibration(reply) => {
                    if running || paused || pending.is_some() || !queue.is_empty() || positioning_operation.is_some() || registration_pending || (link.is_some() && status.state != "Idle") {
                        let _ = reply.send(Err("Wait for active operations before opening a project".into()));
                    } else {
                        calibration = None;
                        registration_pending = false; registration_second = None;
                        explicit_origin = true;
                        emit(DeviceEvent::CalibrationChanged { origin: None });
                        emit(DeviceEvent::AutoOrigin(false));
                        let _ = reply.send(Ok(()));
                    }
                }
                DeviceCommand::SetRegistrationScale { scales: [sx, sy], reply } => {
                    let next = (|| {
                        let confirmed = calibration.as_ref().ok_or("Calibrate the current session before applying page scales")?;
                        if link.is_none() || running || paused || pending.is_some() || !queue.is_empty()
                            || positioning_operation.is_some() || registration_pending || status.state != "Idle"
                            || !positioning::offsets_match(status.wco, confirmed) {
                            return Err("Page scales require an Idle calibrated machine with unchanged offsets".to_string());
                        }
                        if ![sx, sy].iter().all(|v| v.is_finite() && (0.1..=10.).contains(v)) {
                            return Err("Page scales must be finite and within 0.1..10".into());
                        }
                        let angle = confirmed.registration.rotation_deg;
                        let (sin, cos) = angle.to_radians().sin_cos();
                        Registration { scale: (sx + sy) / 2., rotation_deg: angle,
                            matrix: Some([sx * cos, -sy * sin, sx * sin, sy * cos]) }.validate()
                    })();
                    match next {
                        Ok(registration) => {
                            // A timed-out caller must not leave a late, invisible scale change.
                            if reply.send(Ok(())).is_ok() {
                                calibration.as_mut().unwrap().registration = registration;
                                emit(DeviceEvent::RegistrationChanged { scale: registration.scale, rotation_deg: registration.rotation_deg, matrix: registration.matrix });
                            }
                        }
                        Err(reason) => { let _ = reply.send(Err(reason)); }
                    }
                }
                DeviceCommand::Run(job) => {
                    if registration_pending { emit(DeviceEvent::JobRejected { reason: "Finish or cancel two-point registration before writing".into(), running }); continue; }
                    if link.is_none()
                        || running
                        || pending.is_some()
                        || !queue.is_empty()
                        || status.state != "Idle"
                        || positioning_operation.is_some()
                    {
                        emit(DeviceEvent::JobRejected {
                            reason: "Connect and wait for Idle before starting".into(),
                            running,
                        })
                    } else if !explicit_origin {
                        let first = job
                            .document
                            .strokes
                            .iter()
                            .find(|s| s.len() >= 2)
                            .map(|s| s[0]);
                        let validated = first
                            .ok_or_else(|| "No drawable strokes".to_string())
                            .and_then(|p| build_canvas_job(&job, [p.x, p.y]).map(|_| [p.x, p.y]));
                        let origin = match validated {
                            Ok(o) => o,
                            Err(reason) => {
                                emit(DeviceEvent::JobRejected {
                                    reason,
                                    running: false,
                                });
                                continue;
                            }
                        };
                        recovery.active.store(true, Ordering::SeqCst);
                        emit(DeviceEvent::Positioning(true));
                        let prepared = prepare_origin(
                            link.as_mut().unwrap(),
                            &mut status,
                            origin,
                            &recovery.stop_requested,
                        )
                        .and_then(|c| {
                            check_preparation_cancel(Some(&recovery.stop_requested))?;
                            Ok(c)
                        });
                        recovery.active.store(false, Ordering::SeqCst);
                        emit(DeviceEvent::Positioning(false));
                        match prepared {
                            Ok(c) => {
                                calibration = Some(c);
                                emit(DeviceEvent::CalibrationChanged {
                                    origin: Some(origin),
                                });
                                emit(DeviceEvent::AutoOrigin(true));
                                emit(DeviceEvent::Status(status.clone()));
                                running = true;
                                preflight = Some(job);
                                preflight_started = Some(Instant::now());
                                modal = false;
                                queue.push_back("$G".into());
                                last_received = Instant::now();
                            }
                            Err(reason) => {
                                emit(DeviceEvent::JobRejected {
                                    reason: reason.clone(),
                                    running: false,
                                });
                                fault = Some(reason);
                            }
                        }
                    } else if calibration.is_none() {
                        emit(DeviceEvent::JobRejected { reason: "Confirm the work origin after opening a project".into(), running: false });
                    } else if let Err(reason) =
                        positioning::registered_job(&job, calibration.as_ref().unwrap().origin, calibration.as_ref().unwrap().registration)
                    {
                        // Geometry/feed errors are local validation failures,
                        // not a serial disconnect. No command was sent.
                        emit(DeviceEvent::JobRejected {
                            reason: format!("Cannot start: {reason}"),
                            running: false,
                        });
                    } else {
                        running = true;
                        preflight = Some(job);
                        preflight_started = Some(Instant::now());
                        modal = false;
                        queue.push_back("$G".into());
                    }
                }
                DeviceCommand::Jog { x, y, feed } => {
                    if link.is_none()
                        || running
                        || pending.is_some()
                        || !queue.is_empty()
                        || status.state != "Idle"
                        || positioning_operation.is_some()
                        || status
                            .position
                            .is_none_or(|p| !p[2].is_finite() || !(-0.05..=10.05).contains(&p[2]))
                        || ![x, y, feed].iter().all(|v| v.is_finite())
                        || x.abs() > 10.0
                        || y.abs() > 10.0
                        || !valid_feed(feed)
                    {
                        emit(DeviceEvent::Error(
                            "Jog requires Idle, distance <=10 mm and a positive finite controller-representable feed".into(),
                        ))
                    } else if let Some(ref confirmed) = calibration {
                        let p = status.position.unwrap();
                        let target = [p[0] + x, p[1] + y];
                        if !positioning::offsets_match(status.wco, confirmed)
                            || (0..2).any(|axis| target[axis].abs() > positioning::AXIS_LIMITS_MM[axis])
                        {
                            emit(DeviceEvent::Error("Jog target or coordinate offset differs from the calibrated A4 envelope (X 210 mm, Y 297 mm)".into()));
                        } else {
                            queue.push_back(format!("$J=G91 G21 X{x:.3} Y{y:.3} F{feed}"));
                        }
                    } else {
                        queue.push_back(format!("$J=G91 G21 X{x:.3} Y{y:.3} F{feed}"));
                    }
                }
                DeviceCommand::PenUp | DeviceCommand::PenDown { .. } => {
                    let depth = match c {
                        DeviceCommand::PenDown { depth } => depth,
                        _ => 0.0,
                    };
                    if matches!(c, DeviceCommand::PenDown { .. }) && !valid_z_down(depth) {
                        emit(DeviceEvent::Error(
                            "Pen depth must be finite and within 2..=10 mm".into(),
                        ));
                        continue;
                    }
                    if link.is_none()
                        || running
                        || pending.is_some()
                        || !queue.is_empty()
                        || status.state != "Idle"
                        || positioning_operation.is_some()
                        || status.position.is_none()
                        || status.wco.is_none()
                        || calibration
                            .as_ref()
                            .map(|c| !positioning::offsets_match(status.wco, c))
                            .unwrap_or_else(|| status.wco.unwrap()[2].abs() > 0.05)
                        || !matches!(status.position.unwrap()[2],z if (-0.05..=10.05).contains(&z))
                    {
                        emit(DeviceEvent::Error(
                            "Pen control requires Idle, known pen Z and matching calibrated WCO (or known zero Z offset before calibration)".into(),
                        ))
                    } else {
                        queue.push_back("G21".into());
                        if calibration.is_some() {
                            queue.push_back("G54".into());
                        }
                        queue.push_back(format!("G1 G90 Z{} F300", depth));
                    }
                }
                DeviceCommand::ResetOrigin | DeviceCommand::AlignTopRight { .. } | DeviceCommand::BeginRegistration { .. } | DeviceCommand::ApplyRegistration { .. } => {
                    let pending_registration = matches!(c, DeviceCommand::BeginRegistration { .. });
                    let applying_registration = matches!(c, DeviceCommand::ApplyRegistration { .. });
                    let registration = match &c {
                        DeviceCommand::ApplyRegistration { scale, rotation_deg, matrix, .. } => Registration { scale: *scale, rotation_deg: *rotation_deg, matrix: *matrix },
                        DeviceCommand::BeginRegistration { preserve_scale: Some([sx, sy]), .. } => Registration { scale: *sx, rotation_deg: 0., matrix: Some([*sx, 0., 0., *sy]) },
                        _ => Registration::default(),
                    };
                    if let Err(reason) = registration.validate() { emit(DeviceEvent::Error(reason)); emit(DeviceEvent::Positioning(positioning_operation.is_some())); continue; }
                    let origin = match c {
                        DeviceCommand::AlignTopRight { width_mm } => {
                            if !width_mm.is_finite() || width_mm <= 0. {
                                emit(DeviceEvent::Error(
                                    "Canvas width must be positive and finite".into(),
                                ));
                                emit(DeviceEvent::Positioning(false));
                                continue;
                            }
                            [width_mm, 0.]
                        }
                        DeviceCommand::BeginRegistration { canvas_x, canvas_y, .. } => [canvas_x, canvas_y],
                        DeviceCommand::ApplyRegistration { origin, .. } => origin,
                        _ => [0., 0.],
                    };
                    if !origin.iter().all(|v| v.is_finite()) { emit(DeviceEvent::Error("Registration origin must be finite".into())); emit(DeviceEvent::Positioning(positioning_operation.is_some())); continue; }
                    if link.is_none()
                        || running
                        || pending.is_some()
                        || !queue.is_empty()
                        || paused
                        || positioning_operation.is_some()
                        || status.state != "Idle"
                    {
                        emit(DeviceEvent::Error(
                            "Reset origin requires an Idle connected machine".into(),
                        ));
                        emit(DeviceEvent::Positioning(positioning_operation.is_some()));
                    } else {
                        emit(DeviceEvent::Positioning(true));
                        recovery.active.store(true, Ordering::SeqCst);
                        match prepare_origin(
                            link.as_mut().unwrap(),
                            &mut status,
                            origin,
                            &recovery.stop_requested,
                        ).and_then(|mut confirmed| {
                            confirmed.registration = registration;
                            if applying_registration { verify_registration_origin(&status, &confirmed, &recovery.stop_requested) }
                            else { Ok(confirmed) }
                        }) {
                            Ok(mut c) => {
                                c.registration = registration;
                                let origin = c.origin;
                                calibration = Some(c);
                                registration_pending = pending_registration; registration_second = None;
                                explicit_origin = true;
                                emit(DeviceEvent::AutoOrigin(false));
                                emit(DeviceEvent::CalibrationChanged {
                                    origin: Some(origin),
                                });
                                emit(DeviceEvent::RegistrationChanged { scale: registration.scale, rotation_deg: registration.rotation_deg, matrix: registration.matrix });
                                emit(DeviceEvent::Status(status.clone()));
                            }
                            Err(e) => {
                                calibration = None;
                        registration_pending = false; registration_second = None;
                                explicit_origin = false;
                                emit(DeviceEvent::AutoOrigin(true));
                                fault = Some(e);
                            }
                        }
                        recovery.active.store(false, Ordering::SeqCst);
                        last_received = Instant::now();
                        emit(DeviceEvent::Positioning(false));
                    }
                }
                DeviceCommand::CancelRegistration => {
                    if running || pending.is_some() || !queue.is_empty() || positioning_operation.is_some() {
                        emit(DeviceEvent::Error("Wait for active movement to finish before cancelling registration".into()));
                    } else {
                        if registration_pending {
                            // Beginning registration changed WCO; an intermediate
                            // two-point estimate is not a completed calibration.
                            // Cancel only invalidates software state, never moves.
                            calibration = None;
                            explicit_origin = true;
                            emit(DeviceEvent::CalibrationChanged { origin: None });
                            emit(DeviceEvent::AutoOrigin(false));
                        }
                        registration_pending = false; registration_second = None;
                    }
                    emit(DeviceEvent::Positioning(positioning_operation.is_some()));
                }
                DeviceCommand::FinishRegistration { canvas_x, canvas_y } | DeviceCommand::CaptureRegistrationSecond { canvas_x, canvas_y } | DeviceCommand::FinishRegistrationThird { canvas_x, canvas_y } => {
                    let capturing = matches!(c, DeviceCommand::CaptureRegistrationSecond { .. });
                    let third = matches!(c, DeviceCommand::FinishRegistrationThird { .. });
                    emit(DeviceEvent::Positioning(true));
                    let result = (|| {
                        if !registration_pending || link.is_none() || running || paused || pending.is_some() || !queue.is_empty() || positioning_operation.is_some() || status.state != "Idle" {
                            return Err("Begin two-point registration first, then confirm the second point while Idle".into());
                        }
                        let confirmed = calibration.as_ref().ok_or("Registration calibration is invalid")?;
                        let actual = capture_registration_position(link.as_mut().unwrap(), &mut status, confirmed)?;
                        if third {
                            let (second, measured) = registration_second.ok_or("Confirm the second point before the third")?;
                            Registration::solve_three(confirmed.origin, second, [canvas_x,canvas_y], measured, actual)
                        } else if let Some([a, b, c, d]) = confirmed.registration.matrix {
                            Registration::solve_preserving_scale(confirmed.origin, Point { x: canvas_x, y: canvas_y }, actual, [a.hypot(c), b.hypot(d)])
                        } else {
                            Registration::solve(confirmed.origin, Point { x: canvas_x, y: canvas_y }, actual)
                        }
                    })();
                    match result {
                        Ok(registration) => {
                            calibration.as_mut().unwrap().registration = registration;
                            if capturing {
                                registration_second = Some(([canvas_x,canvas_y],status.position.unwrap()));
                                // Keep the canvas tip and preview on the same
                                // provisional mapping used to approach point 3.
                                // The pending flag still forbids starting a job.
                                emit(DeviceEvent::RegistrationChanged { scale: registration.scale, rotation_deg: registration.rotation_deg, matrix: registration.matrix });
                                emit(DeviceEvent::RegistrationPointCaptured { index: 2 });
                            } else {
                                recovery.active.store(true, Ordering::SeqCst);
                                let result = verify_registration_origin(&status, calibration.as_ref().unwrap(), &recovery.stop_requested);
                                recovery.active.store(false, Ordering::SeqCst);
                                match result {
                                    Ok(confirmed) => {
                                        let origin = confirmed.origin;
                                        calibration = Some(confirmed);
                                        registration_pending = false; registration_second = None;
                                        emit(DeviceEvent::CalibrationChanged { origin: Some(origin) });
                                        emit(DeviceEvent::RegistrationChanged { scale: registration.scale, rotation_deg: registration.rotation_deg, matrix: registration.matrix });
                                    }
                                    Err(reason) => {
                                        calibration = None; registration_pending = false; registration_second = None;
                                        explicit_origin = true;
                                        emit(DeviceEvent::AutoOrigin(false));
                                        emit(DeviceEvent::CalibrationChanged { origin: None });
                                        fault = Some(reason);
                                    }
                                }
                            }
                            emit(DeviceEvent::Status(status.clone()));
                        }
                        Err(reason) => emit(DeviceEvent::Error(reason)),
                    }
                    last_received = Instant::now();
                    emit(DeviceEvent::Positioning(positioning_operation.is_some()));
                }
                DeviceCommand::Calibrate { .. } | DeviceCommand::ConfirmManualOrigin { .. } => {
                    let (canvas_x, canvas_y, origin_x, origin_y, raised_confirmed, registration) = match c {
                        DeviceCommand::Calibrate { canvas_x, canvas_y, origin_x, origin_y, raised_confirmed } =>
                            (canvas_x, canvas_y, origin_x, origin_y, raised_confirmed, calibration.as_ref().map(|c| c.registration).unwrap_or_default()),
                        DeviceCommand::ConfirmManualOrigin { raised_confirmed } => {
                            let Some(confirmed) = calibration.as_ref().filter(|_| !registration_pending) else {
                                emit(DeviceEvent::Error("Confirm a work origin before manually returning to it".into()));
                                emit(DeviceEvent::Positioning(positioning_operation.is_some()));
                                continue;
                            };
                            let [x, y] = confirmed.origin;
                            (x, y, x, y, raised_confirmed, confirmed.registration)
                        }
                        _ => unreachable!(),
                    };
                    let target = registration.point(
                        Point {
                            x: canvas_x,
                            y: canvas_y,
                        },
                        [origin_x, origin_y],
                    );
                    let reason = if link.is_none()
                        || running
                        || positioning_operation.is_some()
                        || pending.is_some()
                        || !queue.is_empty()
                        || paused
                        || status.state != "Idle"
                    {
                        Some("Calibration requires an Idle connected machine with no active operation".into())
                    } else if registration_pending || calibration.as_ref().is_some_and(|c| !positioning::offsets_match(status.wco, c)) {
                        Some("Finish calibration and verify work offsets before changing the origin".into())
                    } else if !raised_confirmed {
                        Some(
                            "Confirm that the pen has been manually raised before calibrating Z0"
                                .into(),
                        )
                    } else {
                        target.as_ref().err().cloned()
                    };
                    if let Some(reason) = reason {
                        emit(DeviceEvent::Error(reason));
                        emit(DeviceEvent::Positioning(positioning_operation.is_some()));
                    } else {
                        let xy = target.unwrap();
                        calibration = None;
                        registration_pending = false; registration_second = None;
                        explicit_origin = false;
                        emit(DeviceEvent::AutoOrigin(true));
                        emit(DeviceEvent::CalibrationChanged { origin: None });
                        emit(DeviceEvent::Positioning(true));
                        modal = false;
                        queue.extend([
                            "G21".into(),
                            "G54".into(),
                            format!("G10 L20 P1 X{:.3} Y{:.3} Z0", xy[0], xy[1]),
                            "$G".into(),
                        ]);
                        positioning_operation = Some(PositioningOperation::Calibrate {
                            origin: [origin_x, origin_y],
                            registration,
                            target: [xy[0], xy[1], 0.],
                            phase: CalibrationPhase::Programming,
                            started: Instant::now(),
                        });
                    }
                }
                DeviceCommand::MoveTo { .. } | DeviceCommand::ReturnOrigin => {
                    let request = match c {
                        DeviceCommand::MoveTo {
                            canvas_x,
                            canvas_y,
                            feed,
                        } => Some((
                            Point {
                                x: canvas_x,
                                y: canvas_y,
                            },
                            feed,
                        )),
                        _ => calibration.as_ref().map(|c| {
                            (
                                Point {
                                    x: c.origin[0],
                                    y: c.origin[1],
                                },
                                1500.,
                            )
                        }),
                    };
                    let result = (|| {
                        if link.is_none()
                            || running
                            || positioning_operation.is_some()
                            || pending.is_some()
                            || !queue.is_empty()
                            || paused
                            || status.state != "Idle"
                        {
                            return Err(
                                "Positioning requires an Idle connected machine with no active job"
                                    .into(),
                            );
                        }
                        let confirmed = calibration
                            .as_ref()
                            .ok_or("Calibrate the raised tip before moving to a canvas position")?;
                        if !positioning::offsets_match(status.wco, confirmed) {
                            return Err(
                                "Current work offset differs from the confirmed calibration".into(),
                            );
                        }
                        let (point, feed) = request
                            .ok_or("Calibrate the raised tip before returning to the origin")?;
                        if !valid_feed(feed) {
                            return Err("Positioning feed must be positive, finite and representable by the controller".into());
                        }
                        let target = confirmed.registration.point(point, confirmed.origin)?;
                        let current = status.position.ok_or("Missing current work position")?;
                        if !(-0.05..=10.05).contains(&current[2]) {
                            return Err(
                                "Current Z is outside the calibrated pen range 0..10".into()
                            );
                        }
                        positioning::check_travel(current, target)?;
                        Ok((target, feed))
                    })();
                    match result {
                        Err(reason) => {
                            emit(DeviceEvent::Error(reason));
                            emit(DeviceEvent::Positioning(positioning_operation.is_some()));
                        }
                        Ok((target, feed)) => {
                            emit(DeviceEvent::Positioning(true));
                            queue.extend(["G21".into(), "G54".into(), "G1 G90 Z0 F300".into()]);
                            positioning_operation = Some(PositioningOperation::Move {
                                target,
                                feed,
                                phase: MovePhase::Raising,
                                started: Instant::now(),
                            });
                        }
                    }
                }
            }
        }
        if let Some(l) = link.as_mut() {
            if !running {
                queried_job_prefix = 0;
                stroke_boundaries.clear();
            }
            match l.lines() {
                Err(e) => fault = Some(e),
                Ok(lines) => {
                    for s in lines {
                        last_received = Instant::now();
                        emit(DeviceEvent::Log(format!("< {s}")));
                        if s.starts_with("error:")
                            || s.starts_with("ALARM:")
                            || s.starts_with("Grbl ")
                        {
                            fault = Some(s.clone());
                            break;
                        }
                        if s.starts_with("[GC:") {
                            modal = reports_g54(&s)
                        }
                        if s == "ok" {
                            if let Err(e) = accept_ack(&mut pending) {
                                fault = Some(e);
                                break;
                            }
                            if running && preflight.is_none() {
                                sent += 1;
                                emit(DeviceEvent::Progress { sent, total });

                            }
                        }
                        if let Some(st) = parse_status(&s, &status, l.swap_xy) {
                            status = st.clone();
                            emit(DeviceEvent::Status(st));
                            if status.state.starts_with("Alarm") {
                                fault = Some("Controller is in Alarm; inspect manually".into());
                                break;
                            }
                            if running && status.state.starts_with("Hold") && !paused {
                                fault = Some("Unexpected controller Hold interrupted the job; clearing the abandoned queue".into());
                                break;
                            }
                            if calibration.as_ref().is_some_and(|c| {
                                status.wco.is_some() && !positioning::offsets_match(status.wco, c)
                            }) {
                                calibration = None;
                        registration_pending = false; registration_second = None;
                                explicit_origin = false;
                                emit(DeviceEvent::AutoOrigin(true));
                                emit(DeviceEvent::CalibrationChanged { origin: None });
                                if (running && preflight.is_none())
                                    || matches!(
                                        positioning_operation,
                                        Some(PositioningOperation::Move { .. })
                                    )
                                {
                                    fault=Some("Work offset changed during motion; calibration invalidated".into());
                                    break;
                                }
                                if preflight.is_none() {
                                    emit(DeviceEvent::Error("Work offset changed; confirm the fixed canvas origin and recalibrate the tip".into()));
                                }
                            }
                            if let Some(mut operation) = positioning_operation.take() {
                                let mut keep = true;
                                match &mut operation {
                                    PositioningOperation::Calibrate {
                                        origin,
                                        registration,
                                        target,
                                        phase: CalibrationPhase::Verify,
                                        ..
                                    } => {
                                        if status.state != "Idle" {
                                            keep = false;
                                            emit(DeviceEvent::Error("Machine moved during calibration verification; calibrate again while Idle".into()));
                                            emit(DeviceEvent::Positioning(false));
                                        } else if let (Some(position), Some(wco)) =
                                            (status.position, status.wco)
                                        {
                                            keep = false;
                                            if modal
                                                && (0..3).all(|axis| {
                                                    (position[axis] - target[axis]).abs() <= 0.01
                                                })
                                            {
                                                calibration = Some(Calibration {
                                                    origin: *origin,
                                                    wco,
                                                    registration: *registration,
                                                });
                                                explicit_origin = true;
                                                emit(DeviceEvent::AutoOrigin(false));
                                                emit(DeviceEvent::CalibrationChanged {
                                                    origin: Some(*origin),
                                                });
                                                emit(DeviceEvent::RegistrationChanged { scale: registration.scale, rotation_deg: registration.rotation_deg, matrix: registration.matrix });
                                            } else {
                                                emit(DeviceEvent::Error(format!("Calibration not confirmed: expected G54 work position {:?}, received {:?}; no automatic movement was sent",target,position)));
                                            }
                                            emit(DeviceEvent::Positioning(false));
                                        }
                                    }
                                    PositioningOperation::Move {
                                        target,
                                        feed,
                                        phase,
                                        started,
                                    } if *phase == MovePhase::WaitRaised
                                        && status.state == "Idle"
                                        && !paused =>
                                    {
                                        if let (Some(position), Some(confirmed)) =
                                            (status.position, calibration.as_ref())
                                        {
                                            if !positioning::offsets_match(status.wco, confirmed) {
                                                fault=Some("Raised Z0 was not confirmed before XY positioning".into());
                                                keep = false;
                                            } else if position[2].abs() > 0.05 {
                                                // ACK and an intermediate Idle do not prove
                                                // that the queued Z move has reached Z0.
                                            } else if let Err(reason) =
                                                positioning::check_travel(position, *target)
                                            {
                                                keep = false;
                                                emit(DeviceEvent::Error(reason));
                                                emit(DeviceEvent::Positioning(false));
                                            } else {
                                                queue.push_back(format!(
                                                    "G1 G90 X{:.3} Y{:.3} F{}",
                                                    target[0], target[1], feed
                                                ));
                                                *phase = MovePhase::Travelling;
                                                *started = Instant::now();
                                            }
                                        }
                                    }
                                    PositioningOperation::Move {
                                        target,
                                        phase: MovePhase::WaitTarget,
                                        ..
                                    } if status.state == "Idle" && !paused => {
                                        if let Some(position) = status.position {
                                            if position[2].abs() <= 0.05
                                                && (0..2).all(|axis| {
                                                    (position[axis] - target[axis]).abs() <= 0.01
                                                })
                                            {
                                                keep = false;
                                                emit(DeviceEvent::Positioning(false));
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                                if keep {
                                    positioning_operation = Some(operation);
                                }
                            }
                            if preflight.is_some() && pending.is_none() && queue.is_empty() {
                                if explicit_origin
                                    && modal
                                    && status
                                        .position
                                        .is_some_and(|p| p[2].is_finite() && p[2] > 0.05)
                                    && calibration
                                        .as_ref()
                                        .is_some_and(|c| positioning::offsets_match(status.wco, c))
                                {
                                    recovery.active.store(true, Ordering::SeqCst);
                                    emit(DeviceEvent::Positioning(true));
                                    let lifted = raised_machine_z(&status)
                                        .and_then(|z| {
                                            lift_to_machine_z(
                                                l,
                                                &mut status,
                                                z,
                                                Some(&recovery.stop_requested),
                                            )
                                        })
                                        .and_then(|_| {
                                            check_preparation_cancel(Some(&recovery.stop_requested))
                                        });
                                    recovery.active.store(false, Ordering::SeqCst);
                                    emit(DeviceEvent::Positioning(false));
                                    last_received = Instant::now();
                                    if let Err(e) = lifted {
                                        fault = Some(e);
                                        break;
                                    }
                                }

                                let checked=match calibration.as_ref(){Some(c)=>check_preflight(preflight.as_ref().unwrap(),&status,modal,c),None=>Err("Calibration is no longer valid; confirm the raised tip and fixed origin again".into())};
                                let checked = checked.and_then(|lines| {
                                    lines
                                        .map(|lines| {
                                            crate::job_timing::profile(
                                                &lines,
                                                status.position.unwrap(),
                                            )
                                            .map(|timing| (lines, timing))
                                        })
                                        .transpose()
                                });
                                match checked {
                                    Ok(Some((lines, timing))) => {
                                        emit(DeviceEvent::Timing {
                                            total_seconds: timing.total_seconds,
                                            cumulative_seconds: timing.cumulative_seconds,
                                        });
                                        emit(DeviceEvent::JobStarted {
                                            anchor: status.position.unwrap(),
                                        });
                                        preflight_started = None;
                                        stroke_boundaries = stroke_completion_boundaries(
                                            &lines, &preflight.as_ref().unwrap().document,
                                        );
                                        motion_observer = MotionObserver::new(&lines, status.position.unwrap());
                                        preflight = None;
                                        queried_job_prefix = 0;
                                        total = lines.len();
                                        sent = 0;
                                        queue = lines.into();
                                    }
                                    Ok(None) => {} // WCO need not be present in every status report.
                                    Err(e) => {
                                        preflight = None;
                                        preflight_started = None;
                                        running = false;
                                        finishing = false;
                                        // The read-only command was ACKed, so
                                        // the link is still synchronized. Do
                                        // not hold, reset or disconnect it.
                                        emit(DeviceEvent::JobRejected {
                                            reason: e,
                                            running: false,
                                        });
                                    }
                                }
                            }
                            if running && !paused && preflight.is_none() {
                                let confirmed = if status.state == "Idle" {
                                    motion_observer.completed_prefix = motion_observer.completed_prefix.max(queried_job_prefix);
                                    motion_observer.completed_prefix
                                } else if status.state == "Run" {
                                    status.position.map(|position| motion_observer.observe(
                                        position, sent + usize::from(pending.is_some()),
                                    )).unwrap_or(motion_observer.completed_prefix)
                                } else { motion_observer.completed_prefix };
                                while stroke_boundaries.front().is_some_and(|(end, _)| *end <= confirmed) {
                                    let (_, index) = stroke_boundaries.pop_front().unwrap();
                                    emit(DeviceEvent::StrokeCompleted { index });
                                }
                            }
                            if finishing
                                && stroke_boundaries.is_empty()
                                && running
                                && queue.is_empty()
                                && pending.is_none()
                                && preflight.is_none()
                                && !paused
                                && status.state == "Idle"
                            {
                                if status.position.is_some_and(|p| p[2].abs() <= 0.05) {
                                    finishing = false;
                                    running = false;
                                    emit(DeviceEvent::Completed)
                                } else {
                                    fault = Some("Final Idle reported without confirmed Z0".into())
                                }
                            }
                        }
                    }
                }
            }
            if preflight.is_some()
                && pending.is_none()
                && queue.is_empty()
                && preflight_started.is_some_and(|start| start.elapsed() > Duration::from_secs(5))
            {
                preflight = None;
                preflight_started = None;
                running = false;
                finishing = false;
                emit(DeviceEvent::JobRejected {reason:"Cannot start: no complete WCO/work position report received during preflight; connection remains open, inspect coordinate reporting".into(),running:false});
            }
            if last_received.elapsed() > Duration::from_secs(5) {
                fault = Some("Controller stopped responding; disconnected".into())
            }
            if ack_timed_out(pending, paused, Instant::now()) {
                fault = Some("ACK timed out; reconnect and inspect".into())
            }
            if fault.is_none() && pending.is_none() && queue.is_empty() && !paused {
                let mut fresh_position = false;
                if let Some(operation) = positioning_operation.as_mut() {
                    match operation {
                        PositioningOperation::Calibrate { phase, started, .. }
                            if *phase == CalibrationPhase::Programming =>
                        {
                            *phase = CalibrationPhase::Verify;
                            *started = Instant::now();
                            status.wco = None;
                            status.position = None;
                            fresh_position = true;
                        }
                        PositioningOperation::Move { phase, started, .. }
                            if *phase == MovePhase::Raising =>
                        {
                            *phase = MovePhase::WaitRaised;
                            *started = Instant::now();
                            status.position = None;
                            fresh_position = true;
                        }
                        PositioningOperation::Move { phase, started, .. }
                            if *phase == MovePhase::Travelling =>
                        {
                            *phase = MovePhase::WaitTarget;
                            *started = Instant::now();
                            status.position = None;
                            fresh_position = true;
                        }
                        _ => {}
                    }
                }
                if fresh_position {
                    if let Err(reason) = l.write(b"?") {
                        fault = Some(reason)
                    }
                    last_query = Instant::now();
                }
            }
            let positioning_timeout =
                positioning_operation
                    .as_ref()
                    .is_some_and(|operation| match operation {
                        PositioningOperation::Calibrate {
                            phase: CalibrationPhase::Verify,
                            started,
                            ..
                        } => started.elapsed() > Duration::from_secs(5),
                        PositioningOperation::Move { started, feed, .. } => {
                            started.elapsed()
                                > Duration::try_from_secs_f64(30. + 60. * positioning::AXIS_LIMITS_MM[0].hypot(positioning::AXIS_LIMITS_MM[1]) / feed)
                                    .unwrap_or(Duration::MAX)
                        }
                        _ => false,
                    });
            if positioning_timeout && !paused {
                if matches!(
                    positioning_operation,
                    Some(PositioningOperation::Calibrate { .. })
                ) {
                    positioning_operation = None;
                    emit(DeviceEvent::Error("Calibration could not verify a new G54 work position and WCO; connection remains open, calibration is invalid".into()));
                    emit(DeviceEvent::Positioning(false));
                } else {
                    fault =
                        Some("Timed out confirming positioning Idle and final coordinates".into());
                }
            }
            if fault.is_none() && !paused && pending.is_none() {
                if let Some(line) = queue.pop_front() {
                    emit(DeviceEvent::Log(format!("> {}", map_xy_axes(&line, l.swap_xy))));
                    match l.write(format!("{line}\n").as_bytes()) {
                        Ok(()) => pending = Some(Instant::now()),
                        Err(e) => fault = Some(e),
                    }
                } else if running && preflight.is_none() {
                    finishing = true;
                }
            }
            if fault.is_none() && last_query.elapsed() > Duration::from_millis(250) {
                // Only an existing status query's already-ACKed prefix can be
                // confirmed by its Idle response; never infer execution from ACK.
                queried_job_prefix = if running && preflight.is_none() { sent } else { 0 };
                if let Err(e) = l.write(b"?") {
                    fault = Some(e)
                }
                last_query = Instant::now()
            }
        }
        if let Some(e) = fault {
            let retry_port = connected_port.clone().filter(|_| !paused);
            // Preserve the session's physical raised plane before any reset or
            // reconnect can rebase WCO/Z. Never infer pen-up from reset Z0.
            let prior_reference = calibration
                .as_ref()
                .map(|c| c.wco[2])
                .or_else(|| raised_machine_z(&status).ok());
            held_after_stop = true;
            if let Some(l) = link.as_mut() {
                let _ = l.write(b"!");
            }
            let failed_link = link.take();
            connected_port = None;
            queue.clear();
            pending = None;
            preflight = None;
            preflight_started = None;
            running = false;
            finishing = false;
            paused = false;
            positioning_operation = None;
            calibration = None;
                        registration_pending = false; registration_second = None;
            explicit_origin = false;
            emit(DeviceEvent::AutoOrigin(true));
            emit(DeviceEvent::Positioning(false));
            emit(DeviceEvent::CalibrationChanged { origin: None });
            emit(DeviceEvent::Error(e));
            emit(DeviceEvent::Disconnected);
            if let Some(name) = retry_port {
                recovery.active.store(true, Ordering::SeqCst);
                emit(DeviceEvent::Recovering(true));
                let mut physical_reference = prior_reference;
                let attempt = failed_link
                    .ok_or_else(|| "Serial session lost".into())
                    .and_then(|l| {
                        recover_session_with_reference(
                            l,
                            Duration::from_secs(3),
                            true,
                            false,
                            &mut physical_reference,
                        )
                    });
                let result = attempt.or_else(|_| {
                    open_link(&name, swap_xy).and_then(|l| {
                        recover_session_with_reference(
                            l,
                            Duration::from_secs(3),
                            false,
                            false,
                            &mut physical_reference,
                        )
                    })
                });
                let queued = discard_recovery_commands(&commands);
                if !queued.disconnect {
                    match result {
                        Ok((l, s)) => {
                            link = Some(l);
                            connected_port = Some(name.clone());
                            status = s.clone();
                            held_after_stop = false;
                            last_received = Instant::now();
                            last_query = Instant::now();
                            emit(DeviceEvent::Connected(name));
                            emit(DeviceEvent::Status(s));
                            emit(DeviceEvent::Stopped);
                        }
                        Err(reason) => emit(DeviceEvent::Error(format!(
                            "Automatic recovery failed after two bounded attempts: {reason}"
                        ))),
                    }
                }
                recovery.stop_requested.store(false, Ordering::SeqCst);
                recovery.active.store(false, Ordering::SeqCst);
                emit(DeviceEvent::Recovering(false));
            }
        }
    }
    if running || positioning_operation.is_some() || pending.is_some() || !queue.is_empty() {
        if let Some(l) = link.as_mut() {
            let _ = l.write(b"!\x85");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Point;
    fn job() -> Job {
        Job {
            document: Document {
                name: "test".into(),
                width_mm: 10.0,
                height_mm: 10.0,
                strokes: vec![vec![Point { x: 5.0, y: 8.0 }, Point { x: 9.0, y: 12.0 }]],
            },
            feed: 1200.0,
            travel_feed: 1500.0,
            z_feed: 300.0,
            z_down: default_z_down(),
        }
    }
    #[test]
    fn motion_observer_uses_earliest_possible_segment_and_dispatch_limit() {
        let lines = vec!["G1 X10 Y0 Z0".into(), "G1 X10 Y10 Z0".into(),
            "G1 X0 Y10 Z0".into(), "G1 X0 Y0 Z0".into(), "G1 X10 Y0 Z0".into()];
        let mut observer = MotionObserver::new(&lines, [0.; 3]);
        assert_eq!(observer.observe([5., 0., 0.], 5), 0, "repeated path is ambiguous");
        assert_eq!(observer.observe([10., 5., 0.], 1), 0, "unsent segment cannot confirm motion");
        assert_eq!(observer.observe([10., 5., 0.], 2), 1);
        assert_eq!(observer.observe([5., 10., 0.], 3), 2);
        assert_eq!(observer.observe([5., 0., 0.], 5), 4, "past verified prefix cannot match again");
        assert_eq!(observer.observe([99., 99., 0.], 5), 4, "unmatched telemetry changes nothing");
    }

    #[test]
    fn configurable_pen_depth_dry_run_and_legacy_default() {
        let mut j = job();
        for depth in [2.0, 10.0] {
            j.z_down = depth;
            let lines = build_job(&j, [0.; 3]).unwrap();
            assert!(lines.contains(&format!("G1 G90 Z{depth:.3} F300")));
            assert_eq!(lines.last().unwrap(), "G1 G90 Z0.000 F300");
        }
        for depth in [1.99, 10.01, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            j.z_down = depth;
            assert!(build_job(&j, [0.; 3]).is_err());
        }
        let mut old = serde_json::to_value(job()).unwrap();
        old.as_object_mut().unwrap().remove("z_down");
        let legacy: Job = serde_json::from_value(old).unwrap();
        assert_eq!(legacy.z_down, 4.0);
        assert!(build_job(&legacy, [0.; 3])
            .unwrap()
            .contains(&"G1 G90 Z4.000 F300".into()));
    }
    #[test]
    fn first_point_is_current_and_y_flipped() {
        let lines = build_job(&job(), [17.0, -8.0, 0.0]).unwrap();
        assert!(lines.iter().any(|l| l == "G1 X17.000 Y-8.000 F1500"));
        assert!(lines.iter().any(|l| l == "G1 X21.000 Y-12.000 F1200"));
        assert_eq!(lines.last().unwrap(), "G1 G90 Z0.000 F300");
        assert!(!lines.iter().any(|l| l.contains("G10")
            || l.contains("G92")
            || l.contains("G0")
            || l.contains('\r')));
    }
    #[test]
    fn invalid_geometry_and_unknown_z_rejected() {
        let mut j = job();
        j.document.strokes[0][1].x = 216.0;
        assert!(build_job(&j, [0.0, 0.0, 0.0]).is_err());
        assert!(build_job(&job(), [0.0, 0.0, 4.0]).is_err());
        j.document.strokes[0][1].x = f64::NAN;
        assert!(build_job(&j, [0.0, 0.0, 0.0]).is_err());
    }
    #[test]
    fn a4_job_limits_are_axis_specific_and_preserve_span_guard() {
        let mut j = job();
        j.document.strokes = vec![vec![
            Point { x: 0., y: 0. },
            Point { x: 210., y: 297. },
        ]];
        assert!(build_job(&j, [0.; 3]).is_ok());
        j.document.strokes[0][1].y = 297.01;
        assert!(build_job(&j, [0.; 3]).is_err());
        j.document.strokes[0][1] = Point { x: 210.01, y: 0. };
        assert!(build_job(&j, [0.; 3]).is_err());
        j.document.strokes[0] = vec![
            Point { x: 0., y: 0. },
            Point { x: -110., y: 0. },
            Point { x: 110., y: 0. },
        ];
        assert!(build_job(&j, [0.; 3]).unwrap_err().contains("Job span"));
    }
    #[test]
    fn status_preserves_wco_and_reports_mm() {
        let s = parse_status("<Idle|MPos:1,2,4|WCO:0,0,0>", &Status::default(), false).unwrap();
        assert_eq!(s.position, Some([1.0, 2.0, 4.0]));
        let next = parse_status("<Run|MPos:3,4,0>", &s, false).unwrap();
        assert_eq!(next.position, Some([3.0, 4.0, 0.0]));
    }
    #[test]
    fn axis_mapping_preserves_control_words_pen_and_comments() {
        for (logical, wire) in [
            ("G1 X12.500 Y-42.250 Z4 F300", "G1 Y12.500 X-42.250 Z4 F300"),
            ("$J=G91 G21 X0.000 Y1.000 F1500", "$J=G91 G21 Y0.000 X1.000 F1500"),
            ("G10 L20 P1 X10 Y70 Z0", "G10 L20 P1 Y10 X70 Z0"),
            ("G1 X+2.000\nG1 Y-.5", "G1 Y+2.000\nG1 X-.5"),
            ("$X\n?\n!~", "$X\n?\n!~"),
            ("G1 X2 (Y3) ; X4", "G1 Y2 (Y3) ; X4"),
        ] {
            assert_eq!(map_xy_axes(logical, false), logical);
            assert_eq!(map_xy_axes(logical, true), wire);
            assert_eq!(map_xy_axes(wire, true), logical);
        }
        let output = Arc::new(std::sync::Mutex::new(vec![]));
        let mut link = Link { port: Box::new(MockWire { input: std::io::Cursor::new(vec![]), output: output.clone() }), rx: vec![], swap_xy: true };
        link.write(b"G1 X12 Y-42 Z4 F300\n").unwrap();
        link.write(b"!\x85\x18").unwrap();
        assert_eq!(output.lock().unwrap().as_slice(), b"G1 Y12 X-42 Z4 F300\n!\x85\x18");
    }
    #[test]
    fn swapped_status_keeps_intermittent_offsets_in_logical_axes() {
        let first = parse_status("<Idle|MPos:40,15,9|WCO:30,5,9>", &Status::default(), true).unwrap();
        assert_eq!(first.position, Some([10.,10.,0.]));
        assert_eq!(first.wco, Some([5.,30.,9.]));
        let next = parse_status("<Run|MPos:50,17,13>", &first, true).unwrap();
        assert_eq!(next.position, Some([12.,20.,4.]));
        assert_eq!(next.wco, first.wco);
        let work = parse_status("<Idle|WPos:-290,200,0>", &next, true).unwrap();
        assert_eq!(work.position, Some([200.,-290.,0.]));
        assert_eq!(work.wco, first.wco);
    }
    struct MockWire {
        input: std::io::Cursor<Vec<u8>>,
        output: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    }
    impl Read for MockWire {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(b)
        }
    }
    impl Write for MockWire {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.output.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn mock_wire_splits_crlf_and_writes_single_lf() {
        let output = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let mut l = Link {
            port: Box::new(MockWire {
                input: std::io::Cursor::new(b"ok\r\n<Idle|WPos:0,0,0|WCO:0,0,0>\r\n".to_vec()),
                output: output.clone(),
            }),
            rx: vec![], swap_xy: false,
        };
        assert_eq!(
            l.lines().unwrap(),
            vec!["ok", "<Idle|WPos:0,0,0|WCO:0,0,0>"]
        );
        l.write(b"G21\n").unwrap();
        assert_eq!(*output.lock().unwrap(), b"G21\n");
    }
    #[test]
    fn paused_ack_deadline_is_suspended() {
        let start = Instant::now();
        let now = start + Duration::from_secs(60);
        assert!(!ack_timed_out(Some(start), true, now));
        assert!(ack_timed_out(Some(start), false, now));
        assert!(!ack_timed_out(None, false, now));
        assert!(!ack_timed_out(Some(now), false, now));
    }
    #[test]
    fn one_pending_command_accepts_exactly_one_ack() {
        let mut pending = Some(Instant::now());
        assert!(accept_ack(&mut pending).is_ok());
        assert!(accept_ack(&mut pending).is_err());
        assert!(pending.is_none());
    }
    #[test]
    fn relative_xy_accumulates_to_absolute_and_z_stays_absolute() {
        let mut j = job();
        j.document
            .strokes
            .push(vec![Point { x: 3.0, y: 5.0 }, Point { x: 4.0, y: 7.0 }]);
        let a = build_job(&j, [0.0; 3]).unwrap();
        let r = build_relative_job(&j).unwrap();
        let expected: Vec<_> = a
            .iter()
            .filter(|l| l.starts_with("G1 X"))
            .map(|l| {
                let p: Vec<_> = l.split_whitespace().collect();
                [
                    p[1][1..].parse::<f64>().unwrap(),
                    p[2][1..].parse::<f64>().unwrap(),
                ]
            })
            .collect();
        let mut current = [0.0; 2];
        let mut actual = vec![];
        for l in &r {
            if l.starts_with("G1 G91 X") {
                let p: Vec<_> = l.split_whitespace().collect();
                current[0] += p[2][1..].parse::<f64>().unwrap();
                current[1] += p[3][1..].parse::<f64>().unwrap();
                actual.push(current)
            } else if l.contains('Z') {
                assert!(l.contains("G90"));
            }
        }
        assert_eq!(expected, actual);
        assert!(r.iter().any(|l| l == "G1 G91 X0.000 Y0.000 F1500"));
        assert_eq!(&r[..2], &["G21", "G94"]);
        assert_eq!(r.last().unwrap(), "G1 G90 Z0.000 F300");
    }
    #[test]
    fn generation_accepts_feeds_above_previous_application_caps() {
        let mut j = job();
        j.feed = 10000.0;
        j.travel_feed = 12000.0;
        j.z_feed = 8000.0;
        let lines = build_relative_job(&j).unwrap();
        for feed in ["F10000", "F12000", "F8000"] {
            assert!(lines.iter().any(|line| line.ends_with(feed)));
        }
    }

    #[test]
    fn generation_preserves_positive_fractional_feeds_and_rejects_invalid_rates() {
        let mut j = job();
        j.feed = 0.0001;
        j.travel_feed = 0.25;
        j.z_feed = 0.125;
        let lines = build_relative_job(&j).unwrap();
        assert!(lines.iter().any(|line| line.ends_with("F0.0001")));
        for feed in [
            0.0,
            -1.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::MAX,
            f64::MIN_POSITIVE,
        ] {
            assert!(!valid_feed(feed), "{feed}");
            for axis in 0..3 {
                let mut invalid = j.clone();
                match axis {
                    0 => invalid.feed = feed,
                    1 => invalid.travel_feed = feed,
                    _ => invalid.z_feed = feed,
                }
                assert!(build_relative_job(&invalid).is_err());
            }
        }
    }

    struct DropWire {
        output: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    }
    impl Read for DropWire {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "mock cable removed",
            ))
        }
    }
    impl Write for DropWire {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.output.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn mock_worker(
        input: &[u8],
        dropout: bool,
    ) -> (
        Sender<DeviceCommand>,
        Receiver<DeviceEvent>,
        std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
        thread::JoinHandle<()>,
    ) {
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        let output = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let port: Box<dyn Wire> = if dropout {
            Box::new(DropWire {
                output: output.clone(),
            })
        } else {
            Box::new(MockWire {
                input: std::io::Cursor::new(input.to_vec()),
                output: output.clone(),
            })
        };
        let handle = thread::spawn(move || {
            worker_inner(
                commands,
                events,
                Some((
                    Link { port, rx: vec![], swap_xy: false },
                    Status {
                        state: "Idle".into(),
                        position: Some([0.0; 3]),
                        wco: Some([0.0; 3]),
                    },
                )),
            )
        });
        (tx, rx, output, handle)
    }
    fn until_disconnect(rx: &Receiver<DeviceEvent>) -> Vec<DeviceEvent> {
        let mut events = vec![];
        loop {
            let e = rx
                .recv_timeout(Duration::from_secs(2))
                .expect("mock worker did not disconnect");
            let done = matches!(e, DeviceEvent::Disconnected);
            events.push(e);
            if done {
                return events;
            }
        }
    }
    #[test]
    fn offline_stop_does_not_report_false_success() {
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        let h = thread::spawn(move || worker_inner(commands, events, None));
        tx.send(DeviceCommand::Stop).unwrap();
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            DeviceEvent::Error(_)
        ));
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            DeviceEvent::Recovering(false)
        ));
        assert!(!rx.try_iter().any(|e| matches!(e, DeviceEvent::Stopped)));
        drop(tx);
        h.join().unwrap();
    }
    #[test]
    fn stale_duplicate_ack_locks_transport() {
        let (tx, rx, output, h) = mock_worker(b"ok\nok\n", false);
        let events = until_disconnect(&rx);
        assert!(events
            .iter()
            .any(|e| matches!(e,DeviceEvent::Error(s) if s.contains("Unexpected ACK"))));
        assert_eq!(output.lock().unwrap().as_slice(), b"!");
        drop(tx);
        h.join().unwrap();
    }
    #[test]
    fn controller_error_stops_without_reset() {
        let (tx, rx, output, h) = mock_worker(b"error:2\n", false);
        let events = until_disconnect(&rx);
        assert!(events
            .iter()
            .any(|e| matches!(e,DeviceEvent::Error(s) if s=="error:2")));
        assert_eq!(output.lock().unwrap().as_slice(), b"!");
        drop(tx);
        h.join().unwrap();
    }
    #[test]
    fn cable_removal_faults_and_clears_session() {
        let (tx, rx, output, h) = mock_worker(b"", true);
        let events = until_disconnect(&rx);
        assert!(events
            .iter()
            .any(|e| matches!(e,DeviceEvent::Error(s) if s.contains("mock cable removed"))));
        assert_eq!(output.lock().unwrap().as_slice(), b"!");
        drop(tx);
        h.join().unwrap();
    }
    #[test]
    fn run_rejected_while_disconnected_reports_error() {
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        let h = thread::spawn(move || worker_inner(commands, events, None));
        tx.send(DeviceCommand::Run(job())).unwrap();
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            DeviceEvent::JobRejected { running: false, .. }
        ));
        drop(tx);
        h.join().unwrap();
    }
    #[test]
    fn disconnect_idle_does_not_hold_or_cancel() {
        let (tx, rx, output, h) = mock_worker(b"", false);
        tx.send(DeviceCommand::Disconnect).unwrap();
        until_disconnect(&rx);
        assert!(output.lock().unwrap().iter().all(|b| *b == b'?'));
        drop(tx);
        h.join().unwrap();
    }

    struct ResponsiveWire {
        input: VecDeque<u8>,
        commands: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        z: f64,
        wco: Option<[f64; 3]>,
        omit_wco_reports: usize,
        modal_report: &'static str,
    }
    impl ResponsiveWire {
        fn status(&mut self) {
            let wco = if self.omit_wco_reports > 0 {
                self.omit_wco_reports -= 1;
                None
            } else {
                self.wco
            };
            let offset = wco
                .map(|v| format!("|WCO:{},{},{}", v[0], v[1], v[2]))
                .unwrap_or_default();
            self.input
                .extend(format!("<Idle|MPos:0,0,{}{offset}>\n", self.z).bytes());
        }
    }
    impl Read for ResponsiveWire {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            if self.input.is_empty() {
                thread::sleep(Duration::from_millis(1));
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            let n = b.len().min(self.input.len());
            for v in &mut b[..n] {
                *v = self.input.pop_front().unwrap()
            }
            Ok(n)
        }
    }
    impl Write for ResponsiveWire {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            if b == b"?" {
                self.status()
            } else {
                let line = String::from_utf8_lossy(b).trim().to_string();
                self.commands.lock().unwrap().push(line.clone());
                if line == "$G" {
                    self.input.extend(self.modal_report.bytes());
                    self.input.push_back(b'\n');
                }
                if let Some(z) = line.split_whitespace().find_map(|word| {
                    word.strip_prefix('Z')
                        .and_then(|value| value.parse::<f64>().ok())
                }) {
                    self.z = z;
                }
                // Idle can legitimately be observed between every ACKed segment.
                // Also report Idle before its ACK to exercise pending-command gating.
                self.status();
                self.input.extend(b"ok\n");
                self.status();
            }
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn whole_mock_job_does_not_complete_on_intermediate_idle() {
        let j = job();
        let expected = build_canvas_job(&j, [5., 8.]).unwrap();
        let sent = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let l = Link {
            port: Box::new(ResponsiveWire {
                input: VecDeque::new(),
                commands: sent.clone(),
                z: 0.0,
                wco: Some([0.; 3]),
                omit_wco_reports: 0,
                modal_report: "[GC:G0 G54 G17 G21 G90 G94]",
            }),
            rx: vec![], swap_xy: false,
        };
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        tx.send(DeviceCommand::Run(j)).unwrap();
        let h = thread::spawn(move || {
            worker_inner(
                commands,
                events,
                Some((
                    l,
                    Status {
                        state: "Idle".into(),
                        position: Some([0.0; 3]),
                        wco: Some([0.0; 3]),
                    },
                )),
            )
        });
        let mut completed_strokes = vec![];
        let mut progress = 0;
        let mut saw_intermediate_idle = false;
        let mut timing = None;
        let mut started = false;
        loop {
            match rx
                .recv_timeout(Duration::from_secs(2))
                .expect("mock job never completed")
            {
                DeviceEvent::Timing {
                    total_seconds,
                    cumulative_seconds,
                } => {
                    assert!(!started);
                    assert_eq!(cumulative_seconds.len(), expected.len());
                    assert_eq!(cumulative_seconds.last(), Some(&total_seconds));
                    timing = Some(total_seconds);
                }
                DeviceEvent::JobStarted { .. } => {
                    assert!(timing.is_some());
                    started = true;
                }
                DeviceEvent::Progress { sent, total } => {
                    assert!(started);
                    progress = sent;
                    assert_eq!(total, expected.len())
                }
                DeviceEvent::Status(s)
                    if s.state == "Idle" && progress > 0 && progress < expected.len() =>
                {
                    saw_intermediate_idle = true
                }
                DeviceEvent::StrokeCompleted { index } => completed_strokes.push(index),
                DeviceEvent::Completed => {
                    assert_eq!(completed_strokes, vec![0]);
                    assert_eq!(progress, expected.len());
                    let observed = sent.lock().unwrap();
                    assert_eq!(observed[0], "$G");
                    assert_eq!(&observed[1..], expected.as_slice());
                    break;
                }
                DeviceEvent::Error(e) => panic!("mock job faulted: {e}"),
                _ => {}
            }
        }
        assert!(saw_intermediate_idle);
        drop(tx);
        h.join().unwrap();
    }
    #[test]
    fn all_acks_and_timing_do_not_complete_until_physical_idle() {
        struct AheadWire {
            inner: ResponsiveWire,
            command_count: usize,
            job_lines: usize,
            buffered: bool,
            release: Arc<AtomicBool>,
        }
        impl Read for AheadWire {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                self.inner.read(b)
            }
        }
        impl Write for AheadWire {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                if b == b"?" && self.buffered {
                    let state = if self.release.load(Ordering::SeqCst) {
                        "Idle"
                    } else {
                        "Run"
                    };
                    self.inner
                        .input
                        .extend(format!("<{state}|WPos:0,0,0|WCO:0,0,0>\n").bytes());
                    return Ok(b.len());
                }
                let n = self.inner.write(b)?;
                if b.ends_with(b"\n") {
                    self.command_count += 1;
                    // One read-only $G preflight precedes the actual queue.
                    if self.command_count == self.job_lines + 1 {
                        self.buffered = true;
                        self.inner.input.clear();
                        self.inner.input.extend(b"ok\n<Run|WPos:0,0,0|WCO:0,0,0>\n");
                    }
                }
                Ok(n)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let release = Arc::new(AtomicBool::new(false));
        let wire = AheadWire {
            inner: ResponsiveWire {
                input: VecDeque::new(),
                commands: Arc::new(std::sync::Mutex::new(vec![])),
                z: 0.,
                wco: Some([0.; 3]),
                omit_wco_reports: 0,
                modal_report: "[GC:G0 G54 G17 G21 G90 G94]",
            },
            command_count: 0,
            job_lines: build_canvas_job(&job(), [5., 8.]).unwrap().len(),
            buffered: false,
            release: release.clone(),
        };
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        tx.send(DeviceCommand::Run(job())).unwrap();
        let h = thread::spawn(move || {
            worker_inner(
                commands,
                events,
                Some((
                    Link {
                        port: Box::new(wire),
                        rx: vec![], swap_xy: false,
                    },
                    Status {
                        state: "Idle".into(),
                        position: Some([0.; 3]),
                        wco: Some([0.; 3]),
                    },
                )),
            )
        });
        let mut timing_seen = false;
        loop {
            match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                DeviceEvent::Timing { total_seconds, .. } => {
                    assert!(total_seconds > 0.);
                    timing_seen = true;
                }
                DeviceEvent::Progress { sent, total } if sent == total => {
                    assert!(timing_seen);
                    break;
                }
                DeviceEvent::Completed | DeviceEvent::StrokeCompleted { .. } => panic!("ACKs are not physical completion"),
                DeviceEvent::Error(e) => panic!("{e}"),
                _ => {}
            }
        }
        assert!(!rx.try_iter().any(|e| matches!(e, DeviceEvent::Completed)));
        release.store(true, Ordering::SeqCst);
        loop {
            match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                DeviceEvent::Completed => break,
                DeviceEvent::Error(e) => panic!("{e}"),
                _ => {}
            }
        }
        drop(tx);
        h.join().unwrap();
    }
    fn responsive_worker(
        wire: ResponsiveWire,
        initial_status: Status,
        first: DeviceCommand,
    ) -> (
        Sender<DeviceCommand>,
        Receiver<DeviceEvent>,
        thread::JoinHandle<()>,
    ) {
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        tx.send(first).unwrap();
        let h = thread::spawn(move || {
            worker_inner(
                commands,
                events,
                Some((
                    Link {
                        port: Box::new(wire),
                        rx: vec![], swap_xy: false,
                    },
                    initial_status,
                )),
            )
        });
        (tx, rx, h)
    }
    fn readonly_rejection(
        z: f64,
        wco: Option<[f64; 3]>,
        modal_report: &'static str,
        job: Job,
        expected_reason: &str,
    ) {
        let sent = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let wire = ResponsiveWire {
            input: VecDeque::new(),
            commands: sent.clone(),
            z,
            wco,
            omit_wco_reports: 0,
            modal_report,
        };
        let initial = Status {
            state: "Idle".into(),
            position: wco.map(|_| [0., 0., z]),
            wco,
        };
        let (tx, rx, h) = responsive_worker(wire, initial, DeviceCommand::Run(job));
        loop {
            match rx
                .recv_timeout(Duration::from_secs(2))
                .expect("no preflight rejection")
            {
                DeviceEvent::JobRejected { reason, running } => {
                    assert!(!running);
                    assert!(reason.contains(expected_reason), "{reason}");
                    break;
                }
                DeviceEvent::Disconnected | DeviceEvent::Error(_) | DeviceEvent::Completed => {
                    panic!("preflight must only reject the job")
                }
                _ => {}
            }
        }
        // Confirm the worker still answers live status on the same connection.
        loop {
            match rx.recv_timeout(Duration::from_secs(1)).unwrap() {
                DeviceEvent::Status(_) => break,
                DeviceEvent::Disconnected => panic!("healthy connection closed"),
                _ => {}
            }
        }
        let observed = sent.lock().unwrap().clone();
        assert!(
            observed.iter().all(|line| line == "$G"),
            "unexpected command: {observed:?}"
        );
        drop(tx);
        h.join().unwrap();
        assert!(sent.lock().unwrap().iter().all(|line| line == "$G")); // No hold, resume, reset, jog or pen motion on rejection/shutdown.
    }
    #[test]
    fn fixed_origin_run_automatically_lifts_z4_before_xy_without_redefining_origin() {
        let sent = Arc::new(std::sync::Mutex::new(vec![]));
        let wire = ResponsiveWire {
            input: VecDeque::new(),
            commands: sent.clone(),
            z: 4.,
            wco: Some([0.; 3]),
            omit_wco_reports: 0,
            modal_report: "[GC:G0 G54 G21 G90]",
        };
        let (tx, rx, h) = responsive_worker(
            wire,
            Status {
                state: "Idle".into(),
                position: Some([0., 0., 4.]),
                wco: Some([0.; 3]),
            },
            DeviceCommand::Run(job()),
        );
        loop {
            match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                DeviceEvent::Completed => break,
                DeviceEvent::JobRejected { reason, .. } | DeviceEvent::Error(reason) => {
                    panic!("{reason}")
                }
                DeviceEvent::Disconnected => panic!("healthy link lost"),
                _ => {}
            }
        }
        drop(tx);
        h.join().unwrap();
        let output = sent.lock().unwrap();
        let lift = output
            .iter()
            .position(|s| s == "G90 G53 G1 Z0.000 F300")
            .unwrap();
        let xy = output
            .iter()
            .position(|s| s.contains(" X") && s.starts_with("G1"))
            .unwrap();
        assert!(lift < xy);
        assert!(!output.iter().any(|s| s.starts_with("G10")));
    }
    #[test]
    fn registration_confirmation_lifts_from_pen_down_before_sampling_xy() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let mut l = Link { port: Box::new(wire), rx: vec![], swap_xy: false };
        let mut status = Status {
            state: "Idle".into(),
            position: Some([15., 25., 3.5]),
            wco: Some([0.; 3]),
        };
        let confirmed = Calibration {
            origin: [20., 30.],
            registration: Registration::default(),
            wco: [0.; 3],
        };
        let actual = capture_registration_position(&mut l, &mut status, &confirmed).unwrap();
        assert_eq!(actual, [15., 25., 0.]);
        let output = trace.lock().unwrap();
        assert!(output.iter().any(|s| s == "> G90 G53 G1 Z0.000 F300"));
        assert!(!output.iter().any(|s| s == "> $H"));
        assert!(!output.iter().any(|s| s.starts_with("> G1 G90 X")));
    }
    #[test]
    fn already_cancelled_preparation_sends_no_commands() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let mut l = Link {
            port: Box::new(wire),
            rx: vec![], swap_xy: false,
        };
        let mut status = Status {
            state: "Idle".into(),
            position: Some([15., 25., 3.5]),
            wco: Some([0.; 3]),
        };
        assert!(
            prepare_origin(&mut l, &mut status, [0., 0.], &AtomicBool::new(true))
                .unwrap_err()
                .contains("cancelled")
        );
        assert!(trace.lock().unwrap().is_empty());
    }
    #[test]
    fn nonzero_wco_and_wrong_modal_refuse_job_without_disconnect() {
        readonly_rejection(
            0.,
            Some([1., 0., 0.]),
            "[GC:G0 G54 G17 G21 G90 G94]",
            job(),
            "Calibration is no longer valid",
        );
        readonly_rejection(
            0.,
            Some([0.; 3]),
            "[GC:G0 G55 G17 G21 G90 G94]",
            job(),
            "did not confirm active G54",
        );
    }
    #[test]
    fn oversized_geometry_refuses_before_any_serial_command() {
        let mut j = job();
        j.document.strokes[0][1].x = 216.;
        readonly_rejection(
            0.,
            Some([0.; 3]),
            "[GC:G0 G54 G17 G21 G90 G94]",
            j,
            "X 210 mm",
        );
    }
    #[test]
    fn modal_report_accepts_g54_at_first_or_later_position() {
        assert!(reports_g54("[GC:G54 G0 G21 G90]"));
        assert!(reports_g54("[GC:G0 G54 G21 G90]"));
        assert!(!reports_g54("[GC:G540 G0]"));
        assert!(!reports_g54("[GC:G55 G0]"));
    }
    #[test]
    fn intermittent_wco_reports_wait_then_start_on_same_connection() {
        let sent = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let wire = ResponsiveWire {
            input: VecDeque::new(),
            commands: sent.clone(),
            z: 0.,
            wco: Some([0.; 3]),
            omit_wco_reports: 3,
            modal_report: "[GC:G54 G0 G17 G21 G90 G94]",
        };
        let initial = Status {
            state: "Idle".into(),
            position: None,
            wco: None,
        };
        let (tx, rx, h) = responsive_worker(wire, initial, DeviceCommand::Run(job()));
        let mut missing_reports = 0;
        loop {
            match rx
                .recv_timeout(Duration::from_secs(2))
                .expect("WCO never arrived")
            {
                DeviceEvent::Status(s) if s.wco.is_none() => {
                    missing_reports += 1;
                    assert!(sent.lock().unwrap().iter().all(|l| l == "$G"))
                }
                DeviceEvent::Completed => break,
                DeviceEvent::JobRejected { reason, .. } | DeviceEvent::Error(reason) => {
                    panic!("should wait for intermittent WCO: {reason}")
                }
                DeviceEvent::Disconnected => panic!("should keep waiting connection"),
                _ => {}
            }
        }
        assert!(missing_reports >= 3);
        assert!(sent
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("Z4.000")));
        drop(tx);
        h.join().unwrap();
    }
    #[test]
    fn handshake_timeout_reports_missing_parts_and_hold_without_recovery_commands() {
        let status = Status {
            state: "Hold:0".into(),
            position: Some([3., 0., 4.]),
            wco: Some([0.; 3]),
        };
        let error = handshake_failure(
            false,
            true,
            Some(&status),
            &["ok".into(), "<Hold:0|MPos:3,0,4>".into()],
        );
        assert!(error.contains("GRBL identity"));
        assert!(error.contains("Hold:0"));
        assert!(error.contains("without reset/unlock/resume"));
        assert!(!error.contains("missing: $I acknowledgement"));
    }
    #[test]
    fn duplicate_run_rejection_preserves_actual_running_state() {
        let sent = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let wire = ResponsiveWire {
            input: VecDeque::new(),
            commands: sent,
            z: 0.,
            wco: Some([0.; 3]),
            omit_wco_reports: 0,
            modal_report: "[GC:G0 G54 G21 G90]",
        };
        let (tx, rx, h) = responsive_worker(
            wire,
            Status {
                state: "Idle".into(),
                position: Some([0.; 3]),
                wco: Some([0.; 3]),
            },
            DeviceCommand::Run(job()),
        );
        let mut duplicate = false;
        let mut rejected = false;
        loop {
            match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                DeviceEvent::Progress { .. } if !duplicate => {
                    duplicate = true;
                    tx.send(DeviceCommand::Run(job())).unwrap()
                }
                DeviceEvent::JobRejected { running, .. } => {
                    assert!(running);
                    rejected = true
                }
                DeviceEvent::Completed => break,
                DeviceEvent::Disconnected | DeviceEvent::Error(_) => {
                    panic!("duplicate request must not stop existing job")
                }
                _ => {}
            }
        }
        assert!(rejected);
        drop(tx);
        h.join().unwrap();
    }
    struct HandshakeWire {
        input: VecDeque<u8>,
        writes: std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
        state: Option<&'static str>,
        identity: bool,
        ack: bool,
    }
    impl Read for HandshakeWire {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            if self.input.is_empty() {
                thread::sleep(Duration::from_millis(1));
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            let n = b.len().min(self.input.len());
            for byte in &mut b[..n] {
                *byte = self.input.pop_front().unwrap()
            }
            Ok(n)
        }
    }
    impl Write for HandshakeWire {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.writes.lock().unwrap().push(b.to_vec());
            match b {
                b"?" => {
                    if let Some(state) = self.state {
                        self.input
                            .extend(format!("<{state}|MPos:3,0,4|WCO:0,0,0>\n").bytes())
                    }
                }
                b"$I\n" => {
                    if self.identity {
                        self.input.extend(b"[VER:1.1h:Kenjoy]\n")
                    }
                    if self.ack {
                        self.input.extend(b"ok\n")
                    }
                }
                _ => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "unexpected handshake write",
                    ))
                }
            }
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn mock_handshake(
        state: Option<&'static str>,
        identity: bool,
        ack: bool,
    ) -> (Result<Status, String>, Vec<Vec<u8>>) {
        let writes = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let link = Link {
            port: Box::new(HandshakeWire {
                input: VecDeque::new(),
                writes: writes.clone(),
                state,
                identity,
                ack,
            }),
            rx: vec![], swap_xy: false,
        };
        let result = handshake(link, Duration::from_millis(30)).map(|(_, status)| status);
        let output = writes.lock().unwrap().clone();
        (result, output)
    }
    #[test]
    fn held_controller_reconnection_only_queries_status_never_enqueues_identity() {
        // Repeated failed connect attempts cannot keep accumulating '$I' in RX.
        for _ in 0..3 {
            let (result, writes) = mock_handshake(Some("Hold:0"), true, true);
            let reason = result.unwrap_err();
            assert!(reason.contains("Hold:0"));
            assert!(reason.contains("$I was not sent"));
            assert!(reason.contains("No reset, unlock or resume"));
            assert_eq!(writes, vec![b"?".to_vec()]);
        }
    }
    #[test]
    fn idle_connection_checks_status_before_single_lf_identity_query() {
        let (result, writes) = mock_handshake(Some("Idle"), true, true);
        let status = result.unwrap();
        assert_eq!(status.state, "Idle");
        assert_eq!(status.position, Some([3., 0., 4.]));
        assert_eq!(writes, vec![b"?".to_vec(), b"$I\n".to_vec()]);
    }
    #[test]
    fn nonidle_or_unknown_connection_sends_no_ordinary_commands() {
        for state in [
            Some("Run"),
            Some("Jog"),
            Some("Alarm"),
            Some("Door:0"),
            None,
        ] {
            let (result, writes) = mock_handshake(state, true, true);
            assert!(result.is_err());
            assert_eq!(writes, vec![b"?".to_vec()]);
        }
    }
    #[test]
    fn idle_connection_still_requires_both_identity_and_ack() {
        for (identity, ack, missing) in [
            (false, true, "GRBL identity"),
            (true, false, "$I acknowledgement"),
        ] {
            let (result, writes) = mock_handshake(Some("Idle"), identity, ack);
            assert!(result.unwrap_err().contains(missing));
            assert_eq!(writes, vec![b"?".to_vec(), b"$I\n".to_vec()]);
        }
    }
    struct RecoveryWire {
        input: VecDeque<u8>,
        writes: Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
        initial_state: &'static str,
        stationary_sequence: VecDeque<&'static str>,
        last_report: String,
        held: bool,
        reset: bool,
        banner: bool,
        identity: bool,
        alarm_after_reset: bool,
        z: f64,
        wco_z: f64,
        reset_wco_z: Option<f64>,
        omit_wco_reports: usize,
        withhold_first_job_line: bool,
        unexpected_hold: bool,
        clean_hold: bool,
        executing: bool,
        queue_during_reset: Option<Sender<DeviceCommand>>,
    }
    impl RecoveryWire {
        fn new(initial_state: &'static str) -> Self {
            Self {
                input: VecDeque::new(),
                writes: Arc::new(std::sync::Mutex::new(vec![])),
                initial_state,
                stationary_sequence: VecDeque::from(["Idle", "Hold:1", "Hold:0"]),
                last_report: String::new(),
                held: false,
                reset: false,
                banner: true,
                identity: true,
                alarm_after_reset: false,
                z: 0.,
                wco_z: 0.,
                reset_wco_z: None,
                omit_wco_reports: 0,
                withhold_first_job_line: false,
                unexpected_hold: false,
                clean_hold: false,
                executing: false,
                queue_during_reset: None,
            }
        }
        fn status(&mut self, state: &str) {
            self.last_report = state.to_string();
            let offset = if self.omit_wco_reports > 0 {
                self.omit_wco_reports -= 1;
                String::new()
            } else {
                format!("|WCO:0,0,{}", self.wco_z)
            };
            self.input
                .extend(format!("<{state}|MPos:3,0,{}{offset}>\n", self.z).bytes());
        }
    }
    impl Read for RecoveryWire {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            if self.input.is_empty() {
                thread::sleep(Duration::from_millis(1));
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            let n = b.len().min(self.input.len());
            for byte in &mut b[..n] {
                *byte = self.input.pop_front().unwrap()
            }
            Ok(n)
        }
    }
    impl Write for RecoveryWire {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.writes.lock().unwrap().push(b.to_vec());
            match b {
                b"!" => {
                    self.held = true;
                    // Old pending-job ACK, Idle and banner must be drained;
                    // none may be mistaken for a fresh stopped/reset epoch.
                    if !self.clean_hold {
                        self.input
                            .extend(b"ok\n<Idle|MPos:99,99,0|WCO:0,0,0>\nGrbl 1.1h old startup\n");
                    }
                }
                b"?" => {
                    let state = if self.reset {
                        if self.alarm_after_reset {
                            "Alarm"
                        } else {
                            "Idle"
                        }
                    } else if self.initial_state == "Alarm" {
                        "Alarm"
                    } else if self.held {
                        self.stationary_sequence.pop_front().unwrap_or("Hold:0")
                    } else if self.executing {
                        "Run"
                    } else {
                        self.initial_state
                    };
                    self.status(state);
                }
                b"\x18" => {
                    assert!(
                        self.last_report == "Hold:0" || (!self.held && self.last_report == "Idle"),
                        "reset before a fresh stationary report: {}",
                        self.last_report
                    );
                    self.reset = true;
                    if let Some(w) = self.reset_wco_z {
                        self.wco_z = w;
                    }
                    self.executing = false;
                    // Even a complete stale identity/ACK/status trio before
                    // the new banner must never complete recovery.
                    self.input
                        .extend(b"[VER:old]\nok\n<Idle|MPos:99,99,0|WCO:0,0,0>\n");
                    if self.banner {
                        self.input.extend(b"Grbl 1.1h new startup\n");
                    }
                    if let Some(tx) = self.queue_during_reset.take() {
                        for command in [
                            DeviceCommand::Stop,
                            DeviceCommand::Run(job()),
                            DeviceCommand::Jog {
                                x: 1.,
                                y: 0.,
                                feed: 300.,
                            },
                            DeviceCommand::Recover { port: "mock".into(), swap_xy: false },
                        ] {
                            tx.send(command).unwrap();
                        }
                    }
                }
                b"$I\n" => {
                    assert!(self.reset, "identity before reset recovery");
                    if self.identity {
                        self.input.extend(b"[VER:1.1h:new]\n")
                    }
                    self.input.extend(b"ok\n");
                }
                _ => {
                    let line = String::from_utf8_lossy(b).trim().to_string();
                    if line == "$G" {
                        self.input.extend(b"[GC:G0 G54 G21 G90 G94]\nok\n");
                        self.status("Idle");
                    } else if line == "G21" && self.withhold_first_job_line && !self.reset {
                        self.executing = true;
                        if self.unexpected_hold {
                            self.executing = false;
                            self.initial_state = "Hold:0";
                            self.status("Hold:0");
                        }
                    } else {
                        if let Some(z) = line
                            .split_whitespace()
                            .find_map(|v| v.strip_prefix('Z').and_then(|v| v.parse::<f64>().ok()))
                        {
                            if line.starts_with("G10 ") {
                                self.wco_z = self.z - z;
                            } else {
                                self.z = z;
                            }
                        }
                        self.input.extend(b"ok\n");
                        self.status("Idle");
                    }
                }
            }
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn recovery_worker(
        wire: RecoveryWire,
        first: DeviceCommand,
    ) -> (
        Sender<DeviceCommand>,
        Receiver<DeviceEvent>,
        thread::JoinHandle<()>,
    ) {
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        tx.send(first).unwrap();
        let initial = Status {
            state: wire.initial_state.into(),
            position: Some([3., 0., wire.z]),
            wco: Some([0.; 3]),
        };
        let h = thread::spawn(move || {
            worker_inner(
                commands,
                events,
                Some((
                    Link {
                        port: Box::new(wire),
                        rx: vec![], swap_xy: false,
                    },
                    initial,
                )),
            )
        });
        (tx, rx, h)
    }
    fn wait_stopped(rx: &Receiver<DeviceEvent>) {
        loop {
            match rx
                .recv_timeout(Duration::from_secs(5))
                .expect("stop never completed")
            {
                DeviceEvent::Stopped => return,
                DeviceEvent::Error(e) => panic!("stop failed: {e}"),
                DeviceEvent::Disconnected => panic!("successful stop disconnected"),
                _ => {}
            }
        }
    }
    #[test]
    fn idle_stop_lifts_without_hold_or_reset() {
        let wire = RecoveryWire::new("Idle");
        let writes = wire.writes.clone();
        let (tx, rx, h) = recovery_worker(wire, DeviceCommand::Stop);
        wait_stopped(&rx);
        drop(tx);
        h.join().unwrap();
        let output = writes.lock().unwrap();
        assert!(output.iter().any(|b| b == b"G90 G53 G1 Z0.000 F300\n"));
        assert!(!output.iter().any(|b| b == b"!" || b == b"\x18"));
    }
    #[test]
    fn ten_mm_depth_stop_verifies_actual_lift() {
        let mut wire = RecoveryWire::new("Idle");
        wire.z = 10.;
        let writes = wire.writes.clone();
        let (tx, rx, h) = recovery_worker(wire, DeviceCommand::Stop);
        wait_stopped(&rx);
        drop(tx);
        h.join().unwrap();
        let output = writes.lock().unwrap();
        assert!(output.iter().any(|b| b == b"G90 G53 G1 Z0.000 F300\n"));
        assert!(!output.iter().any(|b| b == b"!" || b == b"\x18"));
        assert!(raised_machine_z(&Status {
            position: Some([0., 0., 10.1]),
            wco: Some([0.; 3]),
            ..Status::default()
        })
        .is_err());
    }
    #[test]
    fn recover_old_hold_resets_then_lifts_without_xy_or_resume() {
        let mut wire = RecoveryWire::new("Hold:0");
        wire.z = 10.;
        let writes = wire.writes.clone();
        let (l, status) = recover_session(
            Link {
                port: Box::new(wire),
                rx: b"ok\n<Idle|MPos:99,99,0>\nGrbl old cached banner\n".to_vec(),
                swap_xy: false,
            },
            Duration::from_millis(300),
            false,
            false,
        )
        .unwrap();
        assert_eq!(status.state, "Idle");
        assert_eq!(status.position, Some([3., 0., 0.]));
        drop(l);
        let output = writes.lock().unwrap();
        assert_eq!(output.first().unwrap(), b"?");
        assert_eq!(output.iter().filter(|b| b.as_slice() == b"\x18").count(), 1);
        assert!(output.iter().any(|b| b == b"G90 G53 G1 Z0.000 F300\n"));
        assert!(!output
            .iter()
            .any(|b| b.contains(&b'X') || b.contains(&b'Y') || b == b"~" || b == b"$H\n"));
    }
    #[test]
    fn live_run_marks_prior_stroke_without_gating_and_stop_keeps_partial_unmarked() {
        struct LiveWire {
            inner: RecoveryWire,
            lifts: usize,
        }
        impl Read for LiveWire {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                self.inner.read(bytes)
            }
        }
        impl Write for LiveWire {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if bytes.starts_with(b"G1 G90 Z0.000 ") && !self.inner.reset {
                    self.lifts += 1;
                    if self.lifts == 4 {
                        self.inner.writes.lock().unwrap().push(bytes.to_vec());
                        self.inner.executing = true;
                        return Ok(bytes.len());
                    }
                }
                let count = self.inner.write(bytes)?;
                if bytes.starts_with(b"G1 X24.000 Y-4.000 ") && !self.inner.reset {
                    self.inner.input.clear();
                    self.inner.input.extend(b"ok\n<Run|WPos:22,-2,4|WCO:0,0,0>\n");
                    self.inner.executing = true;
                }
                Ok(count)
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let mut j = job();
        j.document.strokes.push(vec![Point { x: 25., y: 8. }, Point { x: 29., y: 12. }]);
        let expected = build_canvas_job(&j, [5., 8.]).unwrap();
        let wire = LiveWire { inner: RecoveryWire::new("Idle"), lifts: 0 };
        let writes = wire.inner.writes.clone();
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        tx.send(DeviceCommand::Run(j)).unwrap();
        let h = thread::spawn(move || worker_inner(commands, events, Some((
            Link { port: Box::new(wire), rx: vec![], swap_xy: false },
            Status { state: "Idle".into(), position: Some([3., 0., 0.]), wco: Some([0.; 3]) },
        ))));
        let mut completed = vec![];
        loop {
            match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
                DeviceEvent::StrokeCompleted { index } => {
                    completed.push(index);
                    break;
                }
                DeviceEvent::Completed => panic!("job finished before its live stroke mark"),
                DeviceEvent::Error(e) => panic!("{e}"),
                _ => {}
            }
        }
        assert_eq!(completed, vec![0]);
        {
            let output = writes.lock().unwrap();
            let commands: Vec<_> = output.iter().filter(|bytes| bytes.ends_with(b"\n"))
                .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string()).collect();
            assert_eq!(commands[0], "$G");
            assert_eq!(&commands[1..], &expected[..commands.len() - 1]);
            assert!(commands.iter().any(|line| line.starts_with("G1 X24.000 Y-4.000 ")),
                "second stroke must stream before the first completion mark");
            assert!(!output.iter().any(|bytes| bytes.as_slice() == b"?"),
                "live mark must not add a per-stroke status query");
        }
        tx.send(DeviceCommand::Stop).unwrap();
        loop {
            match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
                DeviceEvent::StrokeCompleted { index } => panic!("partial stroke {index} marked"),
                DeviceEvent::Completed => panic!("stopped job completed"),
                DeviceEvent::Stopped => break,
                DeviceEvent::Error(e) => panic!("{e}"),
                _ => {}
            }
        }
        assert_eq!(completed, vec![0]);
        drop(tx);
        h.join().unwrap();
    }

    #[test]
    fn stop_pending_ack_discards_old_job_reentry_and_invalidates_calibration() {
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        let mut wire = RecoveryWire::new("Idle");
        wire.withhold_first_job_line = true;
        wire.queue_during_reset = Some(tx.clone());
        let writes = wire.writes.clone();
        // Host-side old buffered data is read before the job starts; the Stop
        // also gets fresh old Idle/ACK/banner bytes from the OS input on '!'.
        tx.send(DeviceCommand::Run(job())).unwrap();
        let h = thread::spawn(move || {
            worker_inner(
                commands,
                events,
                Some((
                    Link {
                        port: Box::new(wire),
                        rx: vec![], swap_xy: false,
                    },
                    Status {
                        state: "Idle".into(),
                        position: Some([3., 0., 0.]),
                        wco: Some([0.; 3]),
                    },
                )),
            )
        });
        loop {
            if matches!(rx.recv_timeout(Duration::from_secs(2)).unwrap(),DeviceEvent::Log(s) if s=="> G21")
            {
                break;
            }
        }
        tx.send(DeviceCommand::Stop).unwrap();
        wait_stopped(&rx);
        {
            let output = writes.lock().unwrap();
            assert_eq!(output.iter().filter(|b| b.as_slice() == b"\x18").count(), 1);
            assert_eq!(
                output.iter().filter(|b| b.as_slice() == b"G21\n").count(),
                2
            );
            assert!(!output
                .iter()
                .any(|b| b.starts_with(b"$J") || b.contains(&b'~')));
            let reset = output.iter().position(|b| b.as_slice() == b"\x18").unwrap();
            assert!(
                output[..reset]
                    .iter()
                    .filter(|b| b.as_slice() == b"?")
                    .count()
                    >= 3,
                "old Idle or Hold:1 authorized reset"
            );
        }
        // Recovery drops all stale Run commands. A future deliberate Run is
        // allowed to establish a fresh current-tip origin; it is not replayed.
        assert!(!rx
            .try_iter()
            .any(|e| matches!(e, DeviceEvent::JobStarted { .. } | DeviceEvent::Completed)));
        drop(tx);
        h.join().unwrap();
        assert_eq!(
            writes
                .lock()
                .unwrap()
                .iter()
                .filter(|b| b.as_slice() == b"\x18")
                .count(),
            1
        );
    }
    #[test]
    fn recovery_requires_new_banner_and_new_identity_not_stale_old_replies() {
        for (banner, identity, reason) in [
            (false, true, "no new GRBL startup banner"),
            (true, false, "GRBL identity"),
        ] {
            let mut wire = RecoveryWire::new("Hold:0");
            wire.banner = banner;
            wire.identity = identity;
            let result = recover_session(
                Link {
                    port: Box::new(wire),
                    rx: vec![], swap_xy: false,
                },
                Duration::from_millis(50),
                false,
                false,
            );
            match result {
                Err(e) => assert!(e.contains(reason), "{e}"),
                Ok(_) => panic!("stale pre-reset replies accepted as new session"),
            }
        }
    }
    #[test]
    fn hold1_timeout_and_alarm_never_reset_or_report_stopped() {
        let mut wire = RecoveryWire::new("Run");
        wire.stationary_sequence = VecDeque::from(["Hold:1"; 32]);
        let writes = wire.writes.clone();
        assert!(recover_session(
            Link {
                port: Box::new(wire),
                rx: vec![], swap_xy: false,
            },
            Duration::from_millis(70),
            true,
            false
        )
        .is_err());
        assert!(!writes
            .lock()
            .unwrap()
            .iter()
            .any(|b| b.as_slice() == b"\x18"));
        let wire = RecoveryWire::new("Alarm");
        let writes = wire.writes.clone();
        let (tx, rx, h) = recovery_worker(wire, DeviceCommand::Stop);
        let events = until_disconnect(&rx);
        assert!(events.iter().any(|e| matches!(e, DeviceEvent::Error(_))));
        assert!(!events.iter().any(|e| matches!(e, DeviceEvent::Stopped)));
        assert!(!writes
            .lock()
            .unwrap()
            .iter()
            .any(|b| b.as_slice() == b"\x18"));
        drop(tx);
        h.join().unwrap();
    }
    #[test]
    fn service_recovery_gate_rejects_late_motion_and_merges_stop_intent() {
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        let recovery = Arc::new(RecoveryGate::default());
        recovery.active.store(true, Ordering::SeqCst);
        let service = DeviceService {
            tx,
            rx,
            events,
            recovery: recovery.clone(),
        };
        service.command(DeviceCommand::Run(job()));
        service.command(DeviceCommand::Jog {
            x: 1.,
            y: 0.,
            feed: 300.,
        });
        service.command(DeviceCommand::Recover { port: "mock".into(), swap_xy: false });
        service.command(DeviceCommand::Stop);
        assert!(commands.try_recv().is_err());
        assert!(recovery.stop_requested.load(Ordering::SeqCst));
        assert!(service
            .poll()
            .iter()
            .any(|e| matches!(e, DeviceEvent::JobRejected { running: false, .. })));
    }
    #[test]
    fn prepare_origin_nonzero_offset_waits_for_actual_lift_before_g10() {
        let mut wire = PositionWire::new();
        wire.wco = [2., 3., 10.];
        wire.mpos = [15., 25., 13.5];
        let trace = wire.trace.clone();
        let mut l = Link {
            port: Box::new(wire),
            rx: vec![], swap_xy: false,
        };
        let mut status = Status {
            state: "Idle".into(),
            position: Some([13., 22., 3.5]),
            wco: Some([2., 3., 10.]),
        };
        let c = prepare_origin(&mut l, &mut status, [40., 50.], &AtomicBool::new(false)).unwrap();
        assert_eq!(status.position, Some([0.; 3]));
        assert_eq!(c.wco, [15., 25., 10.]);
        assert_eq!(c.origin, [40., 50.]);
        let output = trace.lock().unwrap();
        let lift = output
            .iter()
            .position(|s| s == "> G90 G53 G1 Z10.000 F300")
            .unwrap();
        let zero = output
            .iter()
            .position(|s| s == "> G10 L20 P1 X0 Y0 Z0")
            .unwrap();
        assert!(output[lift..zero].iter().any(|s| s.starts_with("< <Run")));
        assert!(output[lift..zero]
            .iter()
            .any(|s| s.contains("MPos:15,25,10")));
        assert!(!output
            .iter()
            .any(|s| s.starts_with("> G1 G90 X") || s == "> $H"));
    }
    #[test]
    fn stop_during_lift_cancels_before_origin_or_xy_commands() {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut wire = PositionWire::new();
        wire.cancel_on_raise = Some(cancel.clone());
        let trace = wire.trace.clone();
        let mut l = Link {
            port: Box::new(wire),
            rx: vec![], swap_xy: false,
        };
        let mut status = Status {
            state: "Idle".into(),
            position: Some([15., 25., 3.5]),
            wco: Some([0.; 3]),
        };
        assert!(prepare_origin(&mut l, &mut status, [0., 0.], &cancel)
            .unwrap_err()
            .contains("cancelled"));
        let output = trace.lock().unwrap();
        assert!(output.iter().any(|s| s.starts_with("> G90 G53")));
        assert!(!output
            .iter()
            .any(|s| s.starts_with("> G10") || s.starts_with("> G1 G90 X")));
    }
    #[test]
    fn automatic_run_starts_first_point_at_current_tip_and_reanchors_each_job() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        for depth in [2., 10.] {
            let mut next_job = job();
            next_job.z_down = depth;
            let expected_seconds = crate::job_timing::profile(
                &build_canvas_job(&next_job, [5., 8.]).unwrap(),
                [0.; 3],
            )
            .unwrap()
            .total_seconds;
            tx.send(DeviceCommand::Run(next_job)).unwrap();
            let mut started = false;
            let mut timing_seen = false;
            loop {
                match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
                    DeviceEvent::Timing { total_seconds, .. } => {
                        assert!(!started);
                        assert!((total_seconds - expected_seconds).abs() < 1e-9);
                        timing_seen = true;
                    }
                    DeviceEvent::JobStarted { anchor } => {
                        assert!(timing_seen);
                        assert_eq!(anchor, [0.; 3]);
                        started = true;
                    }
                    DeviceEvent::Completed => {
                        assert!(started);
                        break;
                    }
                    DeviceEvent::JobRejected { reason, .. } | DeviceEvent::Error(reason) => {
                        panic!("{reason}")
                    }
                    DeviceEvent::Disconnected => panic!("healthy serial session lost"),
                    _ => {}
                }
            }
        }
        drop(tx);
        h.join().unwrap();
        assert_eq!(
            trace
                .lock()
                .unwrap()
                .iter()
                .filter(|s| s.as_str() == "> G10 L20 P1 X0 Y0 Z0")
                .count(),
            2
        );
    }
    #[test]
    fn top_right_alignment_lifts_without_xy_and_writes_left_in_fixed_canvas() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        tx.send(DeviceCommand::AlignTopRight { width_mm: 210. })
            .unwrap();
        let mut calibrated = false;
        loop {
            match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
                DeviceEvent::CalibrationChanged {
                    origin: Some(origin),
                } => {
                    assert_eq!(origin, [210., 0.]);
                    calibrated = true;
                }
                DeviceEvent::Positioning(false) => {
                    assert!(calibrated);
                    break;
                }
                DeviceEvent::Error(reason) => panic!("{reason}"),
                _ => {}
            }
        }
        {
            let output = trace.lock().unwrap();
            assert!(output.iter().any(|s| s.starts_with("> G90 G53 G1 Z")));
            assert!(output.iter().any(|s| s == "> G10 L20 P1 X0 Y0 Z0"));
            assert!(!output
                .iter()
                .any(|s| s.starts_with("> G1 X") || s.contains("$H")));
        }
        let mut left_job = job();
        left_job.document.strokes = vec![vec![Point { x: 200., y: 5. }, Point { x: 190., y: 15. }]];
        tx.send(DeviceCommand::Run(left_job)).unwrap();
        loop {
            match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
                DeviceEvent::Completed => break,
                DeviceEvent::JobRejected { reason, .. } | DeviceEvent::Error(reason) => {
                    panic!("{reason}")
                }
                _ => {}
            }
        }
        drop(tx);
        h.join().unwrap();
        let output = trace.lock().unwrap();
        assert!(output.iter().any(|s| s == "> G1 X-10.000 Y-5.000 F1500"));
        assert!(output.iter().any(|s| s == "> G1 X-20.000 Y-15.000 F1200"));
        assert_eq!(
            output
                .iter()
                .filter(|s| s.as_str() == "> G10 L20 P1 X0 Y0 Z0")
                .count(),
            1
        );
    }
    #[test]
    fn top_right_alignment_rejects_invalid_width_without_programming_origin() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        for width_mm in [0., -1., f64::NAN, f64::INFINITY] {
            tx.send(DeviceCommand::AlignTopRight { width_mm }).unwrap();
            loop {
                if let DeviceEvent::Error(reason) = rx.recv_timeout(Duration::from_secs(3)).unwrap()
                {
                    assert!(reason.contains("positive and finite"));
                    break;
                }
            }
        }
        drop(tx);
        h.join().unwrap();
        assert!(!trace.lock().unwrap().iter().any(|s| s.starts_with("> G10")));
    }
    #[test]
    fn reset_origin_automatically_lifts_and_retains_explicit_mode() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        tx.send(DeviceCommand::ResetOrigin).unwrap();
        let mut explicit = false;
        loop {
            match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
                DeviceEvent::AutoOrigin(false) => explicit = true,
                DeviceEvent::Positioning(false) => {
                    assert!(explicit);
                    break;
                }
                DeviceEvent::Error(reason) => panic!("{reason}"),
                _ => {}
            }
        }
        tx.send(DeviceCommand::Run(job())).unwrap();
        loop {
            match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
                DeviceEvent::Completed => break,
                DeviceEvent::JobRejected { reason, .. } | DeviceEvent::Error(reason) => {
                    panic!("{reason}")
                }
                _ => {}
            }
        }
        drop(tx);
        h.join().unwrap();
        assert_eq!(
            trace
                .lock()
                .unwrap()
                .iter()
                .filter(|s| s.as_str() == "> G10 L20 P1 X0 Y0 Z0")
                .count(),
            1
        );
    }
    #[test]
    fn unexpected_hold_recovers_automatically_but_explicit_pause_is_preserved() {
        for unexpected in [true, false] {
            let mut wire = RecoveryWire::new("Idle");
            wire.withhold_first_job_line = true;
            wire.unexpected_hold = unexpected;
            wire.clean_hold = !unexpected;
            let writes = wire.writes.clone();
            let (tx, commands) = mpsc::channel();
            let (events, rx) = mpsc::channel();
            let h = thread::spawn(move || {
                worker_loop(
                    commands,
                    events,
                    Some((
                        Link {
                            port: Box::new(wire),
                            rx: vec![], swap_xy: false,
                        },
                        Status {
                            state: "Idle".into(),
                            position: Some([3., 0., 0.]),
                            wco: Some([0.; 3]),
                        },
                    )),
                    Arc::new(RecoveryGate::default()),
                    Some(Calibration {
                        origin: [0.; 2],
                        wco: [0.; 3],
        registration: Registration::default(),
                    }),
                    Some("mock".into()),
                )
            });
            tx.send(DeviceCommand::Run(job())).unwrap();
            if unexpected {
                loop {
                    match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
                        DeviceEvent::Stopped => break,
                        DeviceEvent::Error(e) if !e.contains("Unexpected controller Hold") => {
                            panic!("{e}")
                        }
                        _ => {}
                    }
                }
                let output = writes.lock().unwrap();
                assert_eq!(output.iter().filter(|b| b.as_slice() == b"\x18").count(), 1);
                assert!(output
                    .iter()
                    .any(|b| b.as_slice() == b"G90 G53 G1 Z0.000 F300\n"));
                assert!(!output
                    .iter()
                    .any(|b| b.contains(&b'X') || b.contains(&b'Y') || b.as_slice() == b"~"));
            } else {
                loop {
                    if matches!(rx.recv_timeout(Duration::from_secs(2)).unwrap(),DeviceEvent::Log(s) if s=="> G21")
                    {
                        break;
                    }
                }
                tx.send(DeviceCommand::Pause).unwrap();
                loop {
                    if matches!(rx.recv_timeout(Duration::from_secs(2)).unwrap(),DeviceEvent::Status(s) if s.state=="Hold:0")
                    {
                        break;
                    }
                }
                assert!(!writes
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|b| b.as_slice() == b"\x18" || b.as_slice() == b"~"));
                assert!(!rx
                    .try_iter()
                    .any(|e| matches!(e, DeviceEvent::Recovering(true) | DeviceEvent::Stopped)));
            }
            drop(tx);
            h.join().unwrap();
        }
    }
    #[test]
    fn failed_recovery_preserves_physical_raise_reference_for_second_reset() {
        let mut first = RecoveryWire::new("Hold:0");
        first.z = 13.5;
        first.wco_z = 10.;
        first.reset_wco_z = Some(13.5);
        first.banner = false;
        let mut reference = None;
        assert!(recover_session_with_reference(
            Link {
                port: Box::new(first),
                rx: vec![], swap_xy: false,
            },
            Duration::from_millis(30),
            false,
            false,
            &mut reference
        )
        .is_err());
        assert_eq!(reference, Some(10.));
        let mut second = RecoveryWire::new("Idle");
        second.z = 13.5;
        second.wco_z = 13.5;
        second.reset_wco_z = Some(13.5);
        let writes = second.writes.clone();
        let (_, status) = recover_session_with_reference(
            Link {
                port: Box::new(second),
                rx: vec![], swap_xy: false,
            },
            Duration::from_millis(100),
            false,
            false,
            &mut reference,
        )
        .unwrap();
        assert_eq!(status.position, Some([3., 0., 0.]));
        assert_eq!(status.wco, Some([0., 0., 10.]));
        let output = writes.lock().unwrap();
        assert!(output
            .iter()
            .any(|b| b.as_slice() == b"G90 G53 G1 Z10.000 F300\n"));
        assert!(!output
            .iter()
            .any(|b| b.as_slice() == b"G90 G53 G1 Z13.500 F300\n"));
    }
    #[test]
    fn recovery_waits_for_intermittent_wco_before_reset_or_clean_idle_lift() {
        for state in ["Hold:0", "Idle"] {
            let mut wire = RecoveryWire::new(state);
            wire.z = 4.;
            wire.omit_wco_reports = 8;
            let writes = wire.writes.clone();
            let (_, status) = recover_session(
                Link {
                    port: Box::new(wire),
                    rx: vec![], swap_xy: false,
                },
                Duration::from_secs(1),
                false,
                true,
            )
            .unwrap();
            assert_eq!(status.wco, Some([0.; 3]));
            let output = writes.lock().unwrap();
            if state == "Hold:0" {
                let reset = output.iter().position(|b| b.as_slice() == b"\x18").unwrap();
                assert!(
                    output[..reset]
                        .iter()
                        .filter(|b| b.as_slice() == b"?")
                        .count()
                        >= 9
                );
                assert_eq!(status.position, Some([3., 0., 0.]));
            } else {
                assert!(output.iter().filter(|b| b.as_slice() == b"?").count() >= 9);
                assert!(!output.iter().any(|b| b.as_slice() == b"\x18"));
                assert_eq!(status.position, Some([3., 0., 4.]));
            }
        }
    }
    struct PositionWire {
        input: VecDeque<u8>,
        trace: Arc<std::sync::Mutex<Vec<String>>>,
        mpos: [f64; 3],
        wco: [f64; 3],
        old_status: Option<String>,
        omit_new_wco_once: bool,
        calibrated: bool,
        z_move: Option<(f64, u8)>,
        xy_move: Option<([f64; 2], u8)>,
        ignore_calibration: bool,
        cancel_on_raise: Option<Arc<AtomicBool>>,
    }
    impl PositionWire {
        fn new() -> Self {
            Self {
                input: VecDeque::new(),
                trace: Arc::new(std::sync::Mutex::new(vec![])),
                mpos: [15., 25., 3.5],
                wco: [0.; 3],
                old_status: None,
                omit_new_wco_once: false,
                calibrated: false,
                z_move: None,
                xy_move: None,
                ignore_calibration: false,
                cancel_on_raise: None,
            }
        }
        fn report(&mut self, state: &str, offset: bool) {
            let wco = if offset {
                format!("|WCO:{},{},{}", self.wco[0], self.wco[1], self.wco[2])
            } else {
                String::new()
            };
            let line = format!(
                "<{state}|MPos:{},{},{}{wco}>",
                self.mpos[0], self.mpos[1], self.mpos[2]
            );
            self.trace.lock().unwrap().push(format!("< {line}"));
            self.input.extend(line.bytes());
            self.input.push_back(b'\n');
        }
        fn query(&mut self) {
            if let Some((target, phase)) = self.z_move {
                match phase {
                    0 => {
                        self.report("Idle", true);
                        self.z_move = Some((target, 1));
                        return;
                    }
                    1 => {
                        self.report("Run", true);
                        self.z_move = Some((target, 2));
                        return;
                    }
                    _ => {
                        self.mpos[2] = self.wco[2] + target;
                        self.z_move = None;
                    }
                }
            }
            if let Some((target, phase)) = self.xy_move {
                match phase {
                    0 => {
                        self.report("Idle", true);
                        self.xy_move = Some((target, 1));
                        return;
                    }
                    1 => {
                        self.report("Run", true);
                        self.xy_move = Some((target, 2));
                        return;
                    }
                    _ => {
                        self.mpos[0] = self.wco[0] + target[0];
                        self.mpos[1] = self.wco[1] + target[1];
                        self.xy_move = None;
                    }
                }
            }
            let offset = !self.omit_new_wco_once;
            self.omit_new_wco_once = false;
            self.report("Idle", offset);
        }
        fn fields(line: &str) -> [Option<f64>; 3] {
            let mut out = [None; 3];
            for word in line.split_whitespace() {
                for (i, axis) in ['X', 'Y', 'Z'].iter().enumerate() {
                    if let Some(v) = word.strip_prefix(*axis) {
                        out[i] = v.parse::<f64>().ok()
                    }
                }
            }
            out
        }
    }
    impl Read for PositionWire {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            if self.input.is_empty() {
                thread::sleep(Duration::from_millis(1));
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            let n = b.len().min(self.input.len());
            for byte in &mut b[..n] {
                *byte = self.input.pop_front().unwrap()
            }
            Ok(n)
        }
    }
    impl Write for PositionWire {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            let line = String::from_utf8_lossy(b).trim().to_string();
            self.trace.lock().unwrap().push(format!("> {line}"));
            if b == b"?" {
                self.query();
                return Ok(b.len());
            }
            let fields = Self::fields(&line);
            if line.starts_with("G10 ") {
                assert!(line.starts_with("G10 L20 P1 "));
                self.old_status = Some(format!(
                    "<Idle|MPos:{},{},{}|WCO:{},{},{}>\n",
                    self.mpos[0], self.mpos[1], self.mpos[2], self.wco[0], self.wco[1], self.wco[2]
                ));
                if !self.ignore_calibration {
                    for axis in 0..3 {
                        if let Some(value) = fields[axis] {
                            self.wco[axis] = self.mpos[axis] - value;
                        }
                    }
                }
                self.calibrated = true;
                self.omit_new_wco_once = true;
            } else if line.starts_with("G90 G53 G1 Z") {
                self.z_move = Some((fields[2].unwrap() - self.wco[2], 0));
                if let Some(cancel) = self.cancel_on_raise.as_ref() {
                    cancel.store(true, Ordering::SeqCst);
                }
            } else if line == "$G" {
                self.input.extend(b"[GC:G0 G54 G17 G21 G90 G94]\n");
            } else if line.starts_with("$J=") {
                for axis in 0..2 {
                    self.mpos[axis] += fields[axis].unwrap_or(0.)
                }
            } else if line == "G1 G90 Z0 F300" {
                self.z_move = if (self.mpos[2] - self.wco[2]).abs() > 0.05 {
                    Some((0., 0))
                } else {
                    None
                };
            } else if line.starts_with("G1 G90 X") || line.starts_with("G1 G90 Y") {
                assert!(
                    self.z_move.is_none(),
                    "XY positioning started before a fresh raised-Z0 Idle report"
                );
                assert!((self.mpos[2] - self.wco[2]).abs() <= 0.05);
                self.xy_move = Some(([fields[0].unwrap(), fields[1].unwrap()], 0));
            } else if line.starts_with("G1 ") {
                for axis in 0..3 {
                    if let Some(v) = fields[axis] {
                        self.mpos[axis] = self.wco[axis] + v
                    }
                }
            }
            self.input.extend(b"ok\n");
            if line == "$G" && self.calibrated {
                if let Some(old) = self.old_status.take() {
                    self.input.extend(old.bytes());
                } else {
                    self.report("Idle", true);
                }
            } else {
                self.report("Idle", true);
            }
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn position_worker(
        wire: PositionWire,
    ) -> (
        Sender<DeviceCommand>,
        Receiver<DeviceEvent>,
        thread::JoinHandle<()>,
    ) {
        position_worker_with_axes(wire, false)
    }
    fn position_worker_with_axes(wire: PositionWire, swap_xy: bool) -> (
        Sender<DeviceCommand>, Receiver<DeviceEvent>, thread::JoinHandle<()>,
    ) {
        let (tx, commands) = mpsc::channel();
        let (events, rx) = mpsc::channel();
        let mut initial = Status {
            state: "Idle".into(),
            position: Some([
                wire.mpos[0] - wire.wco[0],
                wire.mpos[1] - wire.wco[1],
                wire.mpos[2] - wire.wco[2],
            ]),
            wco: Some(wire.wco),
        };
        if swap_xy {
            initial.position.as_mut().unwrap().swap(0, 1);
            initial.wco.as_mut().unwrap().swap(0, 1);
        }
        let h = thread::spawn(move || {
            worker_loop(
                commands,
                events,
                Some((
                    Link {
                        port: Box::new(wire),
                        rx: vec![], swap_xy,
                    },
                    initial,
                )),
                Arc::new(RecoveryGate::default()),
                None,
                None,
            )
        });
        (tx, rx, h)
    }
    #[test]
    fn swapped_axes_calibration_jog_mapping_and_job_complete_in_logical_space() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, handle) = position_worker_with_axes(wire, true);
        calibrate_mock(&tx, &rx);
        assert!(trace.lock().unwrap().iter().any(|line| line == "> G10 L20 P1 Y10.000 X70.000 Z0"));
        tx.send(DeviceCommand::Jog { x: 1., y: -2., feed: 1200. }).unwrap();
        loop {
            match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
                DeviceEvent::Status(s) if s.position == Some([11.,68.,0.]) => break,
                DeviceEvent::Error(e) => panic!("{e}"), _ => {}
            }
        }
        assert!(trace.lock().unwrap().iter().any(|line| line == "> $J=G91 G21 Y1.000 X-2.000 F1200"));
        tx.send(DeviceCommand::BeginRegistration { canvas_x:20.,canvas_y:30.,preserve_scale:None }).unwrap();
        wait_positioning_done(&rx);
        tx.send(DeviceCommand::MoveTo { canvas_x:120.,canvas_y:30.,feed:1500. }).unwrap();
        assert_eq!(wait_positioning_done(&rx).position, Some([100.,0.,0.]));
        tx.send(DeviceCommand::FinishRegistration { canvas_x:120.,canvas_y:30. }).unwrap();
        let mut registered = false;
        loop {
            match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
                DeviceEvent::RegistrationChanged {scale,rotation_deg,..} => { assert!((scale-1.).abs()<1e-9 && rotation_deg.abs()<1e-9); registered=true; },
                DeviceEvent::Positioning(false) => { assert!(registered); break; },
                DeviceEvent::Error(e) => panic!("{e}"), _ => {}
            }
        }
        // Long logical Y remains legal even though it uses the controller's X axis.
        tx.send(DeviceCommand::MoveTo { canvas_x:20.,canvas_y:320.,feed:1500. }).unwrap();
        assert_eq!(wait_positioning_done(&rx).position, Some([0.,-290.,0.]));
        assert!(trace.lock().unwrap().iter().any(|line| line == "> G1 G90 Y0.000 X-290.000 F1500"));
        let mut drawing = job();
        drawing.document.strokes = vec![vec![Point {x:20.,y:30.},Point{x:30.,y:40.}]];
        tx.send(DeviceCommand::Run(drawing)).unwrap();
        let mut completed = false;
        let mut last = None;
        while !completed {
            match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
                DeviceEvent::Status(s) => last=s.position,
                DeviceEvent::Completed => completed=true,
                DeviceEvent::Error(e) | DeviceEvent::JobRejected {reason:e,..} => panic!("{e}"), _=>{}
            }
        }
        assert_eq!(last, Some([10.,-10.,0.]));
        assert!(trace.lock().unwrap().iter().any(|line| line == "> G1 Y10.000 X-10.000 F1200"));
        let before = trace.lock().unwrap().iter().filter(|line|line.starts_with("> G1")).count();
        tx.send(DeviceCommand::MoveTo { canvas_x:231.,canvas_y:30.,feed:1500. }).unwrap();
        loop { if let DeviceEvent::Error(e)=rx.recv_timeout(Duration::from_secs(3)).unwrap() {assert!(e.contains("A4"));break} }
        assert_eq!(trace.lock().unwrap().iter().filter(|line|line.starts_with("> G1")).count(), before);
        // A recovery request cannot silently replace the active session's mapping.
        tx.send(DeviceCommand::Recover {port:"mock".into(),swap_xy:false}).unwrap();
        loop { if let DeviceEvent::Error(e)=rx.recv_timeout(Duration::from_secs(3)).unwrap() {assert!(e.contains("axis mapping"));break} }
        drop(tx); handle.join().unwrap();
    }
    #[test]
    fn swapped_three_point_registration_preserves_orientation_and_recovery_mapping() {
        let (tx,rx,handle)=position_worker_with_axes(PositionWire::new(),true);
        tx.send(DeviceCommand::BeginRegistration {canvas_x:20.,canvas_y:30.,preserve_scale:None}).unwrap();
        wait_positioning_done(&rx);
        tx.send(DeviceCommand::MoveTo {canvas_x:120.,canvas_y:30.,feed:1500.}).unwrap();
        wait_positioning_done(&rx);
        tx.send(DeviceCommand::CaptureRegistrationSecond {canvas_x:120.,canvas_y:30.}).unwrap();
        wait_positioning_done(&rx);
        tx.send(DeviceCommand::MoveTo {canvas_x:20.,canvas_y:180.,feed:1500.}).unwrap();
        wait_positioning_done(&rx);
        tx.send(DeviceCommand::FinishRegistrationThird {canvas_x:20.,canvas_y:180.}).unwrap();
        let mut confirmed=false;
        loop {match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
            DeviceEvent::RegistrationChanged {matrix:Some(m),..} => {for (a,b) in m.into_iter().zip([1.,0.,0.,1.]) {assert!((a-b).abs()<1e-9)} confirmed=true;},
            DeviceEvent::Positioning(false) => {assert!(confirmed);break},
            DeviceEvent::Error(e)=>panic!("{e}"),_=>{}
        }}
        drop(tx);handle.join().unwrap();
        let (link,status)=recover_session(Link {port:Box::new(RecoveryWire::new("Hold:0")),rx:vec![],swap_xy:true},Duration::from_millis(300),false,false).unwrap();
        assert!(link.swap_xy);
        assert_eq!(status.position,Some([0.,3.,0.]));
    }
    fn calibrate_mock(tx: &Sender<DeviceCommand>, rx: &Receiver<DeviceEvent>) {
        tx.send(DeviceCommand::Calibrate {
            canvas_x: 20.,
            canvas_y: 30.,
            origin_x: 10.,
            origin_y: 100.,
            raised_confirmed: true,
        })
        .unwrap();
        let mut confirmed = false;
        loop {
            match rx
                .recv_timeout(Duration::from_secs(2))
                .expect("calibration never confirmed")
            {
                DeviceEvent::CalibrationChanged {
                    origin: Some(origin),
                } => {
                    assert_eq!(origin, [10., 100.]);
                    confirmed = true
                }
                DeviceEvent::Positioning(false) if confirmed => break,
                DeviceEvent::Error(e) => panic!("calibration failed: {e}"),
                DeviceEvent::Disconnected => panic!("calibration closed healthy link"),
                _ => {}
            }
        }
    }
    fn wait_positioning_done(rx: &Receiver<DeviceEvent>) -> Status {
        let mut last = Status::default();
        loop {
            match rx
                .recv_timeout(Duration::from_secs(3))
                .expect("positioning never finished")
            {
                DeviceEvent::Status(status) => last = status,
                DeviceEvent::Positioning(false) => return last,
                DeviceEvent::Error(e) => panic!("positioning failed: {e}"),
                DeviceEvent::Disconnected => panic!("positioning disconnected"),
                _ => {}
            }
        }
    }
    #[test]
    fn registration_refusals_and_cancel_release_positioning_without_commands() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        for command in [
            DeviceCommand::BeginRegistration { canvas_x: f64::NAN, canvas_y: 0., preserve_scale: None },
            DeviceCommand::ApplyRegistration { origin: [0.; 2], scale: 0., rotation_deg: 0., matrix: None },
            DeviceCommand::FinishRegistration { canvas_x: 120., canvas_y: 0. },
        ] {
            tx.send(command).unwrap();
            let mut error = false;
            loop { match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                DeviceEvent::Error(_) => error = true,
                DeviceEvent::Positioning(false) => { assert!(error); break; }
                _ => {}
            }}
        }
        tx.send(DeviceCommand::CancelRegistration).unwrap();
        loop { match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            DeviceEvent::Positioning(false) => break,
            DeviceEvent::Error(e) => panic!("{e}"), _ => {}
        }}
        assert!(trace.lock().unwrap().iter().filter(|s| s.starts_with("> ")).all(|s| s == "> ?"));
        drop(tx); h.join().unwrap();
    }
    #[test]
    fn registration_keeps_first_point_origin_and_rejects_unverified_state() {
        for registration in [Registration { scale: 1.2, rotation_deg: 17., matrix: None }, Registration { scale: 1.1, rotation_deg: 0., matrix: Some([1.1, 0.1, -0.1, 0.9]) }] {
            let wire = PositionWire::new(); let trace = wire.trace.clone();
            let mut link = Link { port: Box::new(wire), rx: vec![], swap_xy: false };
            let mut status = Status { state: "Idle".into(), position: Some([15., 25., 3.5]), wco: Some([0.; 3]) };
            let cancel = AtomicBool::new(false);
            let mut confirmed = prepare_origin(&mut link, &mut status, [20., 30.], &cancel).unwrap();
            confirmed.registration = registration;
            let physical: Vec<f64> = (0..3).map(|i| status.position.unwrap()[i] + status.wco.unwrap()[i]).collect();
            trace.lock().unwrap().clear();
            cancel.store(true, Ordering::SeqCst);
            assert!(verify_registration_origin(&status, &confirmed, &cancel).is_err());
            assert!(trace.lock().unwrap().is_empty());
            cancel.store(false, Ordering::SeqCst);
            let verified = verify_registration_origin(&status, &confirmed, &cancel).unwrap();
            assert_eq!(verified.origin, [20., 30.]);
            for i in 0..3 { assert!((status.position.unwrap()[i] + status.wco.unwrap()[i] - physical[i]).abs() < 0.005); }
            let output = trace.lock().unwrap().clone();
            assert!(output.is_empty(), "Final validation must not change WCO or move the physical tip");
            trace.lock().unwrap().clear(); status.wco = None;
            assert!(verify_registration_origin(&status, &verified, &cancel).is_err());
            assert!(trace.lock().unwrap().is_empty());
        }
    }
    #[test]
    fn two_point_registration_and_profile_application_keep_motion_explicit() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        tx.send(DeviceCommand::BeginRegistration { canvas_x: 20., canvas_y: 30., preserve_scale: None }).unwrap();
        assert_eq!(wait_positioning_done(&rx).position, Some([0.;3]));
        assert!(!trace.lock().unwrap().iter().any(|s| s.starts_with("> G1 X") || s.contains("$H")));
        tx.send(DeviceCommand::MoveTo { canvas_x: 120., canvas_y: 30., feed: 1500. }).unwrap();
        assert_eq!(wait_positioning_done(&rx).position, Some([100.,0.,0.]));
        trace.lock().unwrap().clear();
        tx.send(DeviceCommand::FinishRegistration { canvas_x: 120., canvas_y: 30. }).unwrap();
        let mut busy = false;
        let mut confirmed = false;
        loop { match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            DeviceEvent::Positioning(true) => busy = true,
            DeviceEvent::CalibrationChanged { origin } => assert_eq!(origin, Some([20.,30.])),
            DeviceEvent::Status(status) => assert_eq!(status.position, Some([100.,0.,0.])),
            DeviceEvent::RegistrationChanged { scale, rotation_deg, .. } => { assert!(busy); assert!((scale-1.).abs()<1e-9); assert!(rotation_deg.abs()<1e-9); confirmed = true; }
            DeviceEvent::Positioning(false) => { assert!(busy && confirmed); break; }
            DeviceEvent::Error(e) => panic!("{e}"), _ => {}
        }}
        let confirmed_trace = trace.lock().unwrap().clone();
        assert!(!confirmed_trace.iter().any(|s| s.contains("G10")), "Keep point 1 as XY0 after measuring point 2");
        assert!(confirmed_trace.iter().any(|s| s.contains("G90 G53 G1 Z")));
        assert!(!confirmed_trace.iter().any(|s| s.contains("$H") || s.starts_with("> G1 X")));
        trace.lock().unwrap().clear();
        tx.send(DeviceCommand::ApplyRegistration { origin: [20.,30.], scale: 1.2, rotation_deg: 90., matrix: None }).unwrap();
        wait_positioning_done(&rx);
        let output = trace.lock().unwrap().clone();
        assert!(output.iter().any(|s| s.contains("G53 G1 Z")));
        assert!(!output.iter().any(|s| s.starts_with("> G1 X") || s.contains("$H")));
        tx.send(DeviceCommand::MoveTo { canvas_x: 30., canvas_y: 40., feed: 1500. }).unwrap();
        let position = wait_positioning_done(&rx).position.unwrap();
        assert!((position[0]-12.).abs()<0.001 && (position[1]-12.).abs()<0.001);
        drop(tx); h.join().unwrap();
    }
    #[test]
    fn reopened_project_registration_preserves_axis_scales() {
        let wire = PositionWire::new();
        let (tx, rx, h) = position_worker(wire);
        tx.send(DeviceCommand::BeginRegistration { canvas_x: 20., canvas_y: 30., preserve_scale: Some([0.8, 1.2]) }).unwrap();
        wait_positioning_done(&rx);
        tx.send(DeviceCommand::MoveTo { canvas_x: 120., canvas_y: 30., feed: 1500. }).unwrap();
        assert_eq!(wait_positioning_done(&rx).position, Some([80.,0.,0.]));
        tx.send(DeviceCommand::FinishRegistration { canvas_x: 120., canvas_y: 30. }).unwrap();
        let mut matrix = None;
        loop { match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            DeviceEvent::RegistrationChanged { matrix: value, .. } => matrix = value,
            DeviceEvent::Positioning(false) => break,
            DeviceEvent::Error(e) => panic!("{e}"), _ => {}
        }}
        let [a,b,c,d] = matrix.expect("preserved scale matrix");
        assert!((a-0.8).abs()<1e-9 && b.abs()<1e-9 && c.abs()<1e-9 && (d-1.2).abs()<1e-9);
        drop(tx); h.join().unwrap();
    }
    #[test]
    fn page_scales_preserve_origin_rotation_and_reject_invalid_or_abandoned_changes() {
        let wire = PositionWire::new(); let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        let apply = |scales| {
            let (reply, result) = mpsc::channel();
            tx.send(DeviceCommand::SetRegistrationScale { scales, reply }).unwrap();
            result.recv_timeout(Duration::from_secs(2)).unwrap()
        };
        assert!(apply([0.8, 1.2]).is_err(), "No stale scale may establish an origin");
        tx.send(DeviceCommand::BeginRegistration { canvas_x: 20., canvas_y: 30., preserve_scale: None }).unwrap();
        wait_positioning_done(&rx);
        assert!(apply([0.8, 1.2]).is_err(), "Incomplete calibration stays locked");
        tx.send(DeviceCommand::CancelRegistration).unwrap(); wait_positioning_done(&rx);
        tx.send(DeviceCommand::ApplyRegistration { origin: [20.,30.], scale: 1., rotation_deg: 90., matrix: None }).unwrap();
        let before = wait_positioning_done(&rx);
        trace.lock().unwrap().clear();
        assert!(apply([0.8, 1.2]).is_ok());
        loop { match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            DeviceEvent::RegistrationChanged { matrix: Some([a,b,c,d]), rotation_deg, .. } => {
                assert_eq!(rotation_deg, 90.);
                assert!(a.abs() < 1e-9 && (b + 1.2).abs() < 1e-9 && (c - 0.8).abs() < 1e-9 && d.abs() < 1e-9);
                break;
            },
            DeviceEvent::CalibrationChanged { .. } => panic!("Scale update must not reset the origin"),
            _ => {},
        }}
        assert!(apply([0., 1.]).is_err()); assert!(apply([f64::NAN, 1.]).is_err());
        let (reply, abandoned) = mpsc::channel(); drop(abandoned);
        tx.send(DeviceCommand::SetRegistrationScale { scales: [2., 2.], reply }).unwrap();
        assert!(apply([0., 1.]).is_err()); // Worker barrier after the abandoned request.
        assert!(trace.lock().unwrap().iter().filter(|s| s.starts_with("> ")).all(|s| s == "> ?"));
        tx.send(DeviceCommand::MoveTo { canvas_x: 30., canvas_y: 40., feed: 1500. }).unwrap();
        let after = wait_positioning_done(&rx);
        let p = after.position.unwrap(); assert!((p[0] - 12.).abs() < 0.001 && (p[1] - 8.).abs() < 0.001);
        assert_eq!(after.wco, before.wco);
        tx.send(DeviceCommand::Run(job())).unwrap();
        assert!(apply([0.9, 1.1]).is_err(), "An active job cannot change page scales");
        drop(tx); h.join().unwrap();
    }
    #[test]
    fn optional_third_point_lifts_before_confirmation_and_keeps_job_locked() {
        let wire=PositionWire::new(); let trace=wire.trace.clone();
        let (tx,rx,h)=position_worker(wire);
        tx.send(DeviceCommand::BeginRegistration{canvas_x:20.,canvas_y:30.,preserve_scale:None}).unwrap(); wait_positioning_done(&rx);
        tx.send(DeviceCommand::MoveTo{canvas_x:120.,canvas_y:30.,feed:1500.}).unwrap(); wait_positioning_done(&rx);
        trace.lock().unwrap().clear();
        tx.send(DeviceCommand::CaptureRegistrationSecond{canvas_x:120.,canvas_y:30.}).unwrap();
        let mut captured=false;
        let mut provisional=false;
        loop {match rx.recv_timeout(Duration::from_secs(2)).unwrap(){
            DeviceEvent::RegistrationChanged{scale,rotation_deg,matrix}=>{assert_eq!(scale,1.);assert_eq!(rotation_deg,0.);assert_eq!(matrix,None);provisional=true;},
            DeviceEvent::RegistrationPointCaptured{index}=>{assert!(provisional);assert_eq!(index,2);captured=true;},
            DeviceEvent::Positioning(false)=>{assert!(captured);break;},
            DeviceEvent::Error(e)=>panic!("{e}"),_=>{}
        }}
        let captured_trace = trace.lock().unwrap().clone();
        assert!(captured_trace.iter().any(|s| s.contains("G90 G53 G1 Z")));
        assert!(!captured_trace.iter().any(|s| s.contains("$H") || s.starts_with("> G1 X")));
        tx.send(DeviceCommand::Run(job())).unwrap();
        loop {if let DeviceEvent::JobRejected{reason,..}=rx.recv_timeout(Duration::from_secs(2)).unwrap(){assert!(reason.contains("registration"));break;}}
        tx.send(DeviceCommand::MoveTo{canvas_x:20.,canvas_y:180.,feed:1500.}).unwrap(); wait_positioning_done(&rx);
        trace.lock().unwrap().clear();
        tx.send(DeviceCommand::FinishRegistrationThird{canvas_x:20.,canvas_y:180.}).unwrap();
        let mut completed=false;
        loop {match rx.recv_timeout(Duration::from_secs(2)).unwrap(){
            DeviceEvent::CalibrationChanged{origin}=>assert_eq!(origin,Some([20.,30.])),
            DeviceEvent::Status(status)=>assert_eq!(status.position,Some([0.,-150.,0.])),
            DeviceEvent::RegistrationChanged{matrix,..}=>{assert_eq!(matrix,Some([1.,0.,0.,1.]));completed=true;},
            DeviceEvent::Positioning(false)=>{assert!(completed);break;},
            DeviceEvent::Error(e)=>panic!("{e}"),_=>{}
        }}
        let third_trace = trace.lock().unwrap().clone();
        assert!(!third_trace.iter().any(|s| s.contains("G10")), "Keep point 1 as XY0 and the tip at point 3");
        assert!(third_trace.iter().any(|s| s.contains("G90 G53 G1 Z")));
        assert!(!third_trace.iter().any(|s| s.contains("$H") || s.starts_with("> G1 X")));
        tx.send(DeviceCommand::BeginRegistration{canvas_x:20.,canvas_y:30.,preserve_scale:None}).unwrap(); wait_positioning_done(&rx);
        tx.send(DeviceCommand::FinishRegistrationThird{canvas_x:20.,canvas_y:180.}).unwrap();
        let mut rejected=false;
        loop {match rx.recv_timeout(Duration::from_secs(2)).unwrap(){DeviceEvent::Error(_)=>rejected=true,DeviceEvent::Positioning(false)=>{assert!(rejected);break;},_=>{}}}
        drop(tx);h.join().unwrap();
    }
    #[test]
    fn cancelling_partial_three_point_mapping_invalidates_origin_without_motion() {
        let wire=PositionWire::new();let trace=wire.trace.clone();let(tx,rx,h)=position_worker(wire);
        tx.send(DeviceCommand::BeginRegistration{canvas_x:20.,canvas_y:30.,preserve_scale:None}).unwrap();wait_positioning_done(&rx);
        // Simulates manual adjustment: measured second point differs from nominal.
        tx.send(DeviceCommand::MoveTo{canvas_x:130.,canvas_y:30.,feed:1500.}).unwrap();wait_positioning_done(&rx);
        tx.send(DeviceCommand::CaptureRegistrationSecond{canvas_x:120.,canvas_y:30.}).unwrap();
        let mut provisional=false;
        loop{match rx.recv_timeout(Duration::from_secs(2)).unwrap(){
            DeviceEvent::RegistrationChanged{scale,rotation_deg,matrix}=>{assert!((scale-1.1).abs()<1e-9);assert_eq!(rotation_deg,0.);assert_eq!(matrix,None);provisional=true;},
            DeviceEvent::RegistrationPointCaptured{index}=>{assert_eq!(index,2);assert!(provisional);},
            DeviceEvent::Positioning(false)=>{assert!(provisional);break;},
            DeviceEvent::Error(e)=>panic!("{e}"),_=>{}
        }}
        trace.lock().unwrap().clear();tx.send(DeviceCommand::CancelRegistration).unwrap();
        let mut invalidated=false;
        loop{match rx.recv_timeout(Duration::from_secs(2)).unwrap(){
            DeviceEvent::CalibrationChanged{origin}=>{assert_eq!(origin,None);invalidated=true;},
            DeviceEvent::Positioning(false)=>{assert!(invalidated);break;},
            DeviceEvent::Error(e)=>panic!("{e}"),_=>{}
        }}
        tx.send(DeviceCommand::Run(job())).unwrap();
        loop{if let DeviceEvent::JobRejected{reason,..}=rx.recv_timeout(Duration::from_secs(2)).unwrap(){assert!(reason.contains("Confirm the work origin"));break;}}
        assert!(trace.lock().unwrap().iter().filter(|s|s.starts_with("> ")).all(|s|s=="> ?"));
        // A stray cancel after a fully applied profile must preserve its mapping.
        tx.send(DeviceCommand::ApplyRegistration{origin:[20.,30.],scale:1.1,rotation_deg:0.,matrix:Some([1.1,0.,0.,0.8])}).unwrap();wait_positioning_done(&rx);
        tx.send(DeviceCommand::CancelRegistration).unwrap();
        loop{match rx.recv_timeout(Duration::from_secs(2)).unwrap(){DeviceEvent::CalibrationChanged{..}=>panic!("inactive cancel cleared completed mapping"),DeviceEvent::Positioning(false)=>break,_=>{}}}
        tx.send(DeviceCommand::MoveTo{canvas_x:30.,canvas_y:40.,feed:1500.}).unwrap();
        let pos=wait_positioning_done(&rx).position.unwrap();assert!((pos[0]-11.).abs()<0.001&&(pos[1]+8.).abs()<0.001);
        drop(tx);h.join().unwrap();
    }
    #[test]
    fn opening_project_invalidates_calibration_without_writing_to_controller() {
        let wire = PositionWire::new(); let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        calibrate_mock(&tx, &rx); trace.lock().unwrap().clear();
        let (reply, result) = mpsc::channel();
        tx.send(DeviceCommand::ForgetCalibration(reply)).unwrap();
        assert!(result.recv_timeout(Duration::from_secs(2)).unwrap().is_ok());
        tx.send(DeviceCommand::Run(job())).unwrap();
        loop { if let DeviceEvent::JobRejected { reason, running } = rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            assert!(reason.contains("Confirm the work origin")); assert!(!running); break;
        } }
        assert!(trace.lock().unwrap().iter().all(|s| !s.starts_with("> ") || s == "> ?"), "opening emits no controller commands");
        drop(tx); h.join().unwrap();
    }
    #[test]
    fn opening_project_rejects_active_registration_and_keeps_it() {
        let (tx, rx, h) = position_worker(PositionWire::new());
        tx.send(DeviceCommand::BeginRegistration { canvas_x:20., canvas_y:30., preserve_scale:None }).unwrap(); wait_positioning_done(&rx);
        let (reply, result) = mpsc::channel(); tx.send(DeviceCommand::ForgetCalibration(reply)).unwrap();
        assert!(result.recv_timeout(Duration::from_secs(2)).unwrap().is_err());
        tx.send(DeviceCommand::Run(job())).unwrap();
        loop { if let DeviceEvent::JobRejected { reason, .. } = rx.recv_timeout(Duration::from_secs(2)).unwrap() { assert!(reason.contains("registration")); break; } }
        drop(tx); h.join().unwrap();
    }
    #[test]
    fn manual_origin_confirmation_preserves_registration_without_motion() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        // No established origin, so manual return must not invent one.
        tx.send(DeviceCommand::ConfirmManualOrigin { raised_confirmed: true }).unwrap();
        loop { match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            DeviceEvent::Positioning(false) => break,
            _ => {}
        }}
        assert!(!trace.lock().unwrap().iter().any(|s| s.contains("G10")));
        tx.send(DeviceCommand::ApplyRegistration { origin: [20.,30.], scale: 1.2, rotation_deg: 5., matrix: None }).unwrap();
        wait_positioning_done(&rx);
        trace.lock().unwrap().clear();
        tx.send(DeviceCommand::ConfirmManualOrigin { raised_confirmed: false }).unwrap();
        let mut rejected = false;
        loop { match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            DeviceEvent::Error(_) => rejected = true,
            DeviceEvent::Positioning(false) => { assert!(rejected); break; }
            _ => {}
        }}
        assert!(!trace.lock().unwrap().iter().any(|s| s.contains("G10")));
        tx.send(DeviceCommand::ConfirmManualOrigin { raised_confirmed: true }).unwrap();
        let mut origin_ok = false;
        let mut registration_ok = false;
        loop { match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            DeviceEvent::CalibrationChanged { origin: Some(origin) } => { assert_eq!(origin, [20.,30.]); origin_ok = true; }
            DeviceEvent::RegistrationChanged { scale, rotation_deg, .. } => { assert_eq!(scale, 1.2); assert_eq!(rotation_deg, 5.); registration_ok = true; }
            DeviceEvent::Positioning(false) => { assert!(origin_ok && registration_ok); break; }
            DeviceEvent::Error(e) => panic!("{e}"),
            _ => {}
        }}
        let output = trace.lock().unwrap().clone();
        assert!(output.iter().any(|s| s == "> G10 L20 P1 X0.000 Y0.000 Z0"));
        assert!(output.iter().filter(|s| s.starts_with("> ")).all(|s|
            ["> ?", "> G21", "> G54", "> $G", "> G10 L20 P1 X0.000 Y0.000 Z0"].contains(&s.as_str())), "Unexpected controller command: {output:?}");
        drop(tx); h.join().unwrap();
    }
    #[test]
    fn changing_origin_preserves_scaled_rotated_mapping_without_moving_the_tip() {
        let wire = PositionWire::new(); let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        tx.send(DeviceCommand::BeginRegistration { canvas_x: 20., canvas_y: 30., preserve_scale: None }).unwrap();
        wait_positioning_done(&rx); trace.lock().unwrap().clear();
        tx.send(DeviceCommand::Calibrate { canvas_x: 20., canvas_y: 30., origin_x: 10., origin_y: 20., raised_confirmed: true }).unwrap();
        let mut rejected = false;
        loop { match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            DeviceEvent::Error(_) => rejected = true,
            DeviceEvent::Positioning(false) => { assert!(rejected); break; },
            _ => {},
        }}
        assert!(!trace.lock().unwrap().iter().any(|line| line.contains("G10")));
        tx.send(DeviceCommand::CancelRegistration).unwrap(); wait_positioning_done(&rx);
        let (sin, cos) = 30_f64.to_radians().sin_cos();
        let matrix = [0.8 * cos, -1.2 * sin, 0.8 * sin, 1.2 * cos];
        tx.send(DeviceCommand::ApplyRegistration { origin: [20.,30.], scale: 1., rotation_deg: 30., matrix: Some(matrix) }).unwrap();
        wait_positioning_done(&rx);
        tx.send(DeviceCommand::MoveTo { canvas_x: 35., canvas_y: 50., feed: 1500. }).unwrap();
        let before = wait_positioning_done(&rx); trace.lock().unwrap().clear();
        tx.send(DeviceCommand::Calibrate { canvas_x: 35., canvas_y: 50., origin_x: 10., origin_y: 20., raised_confirmed: true }).unwrap();
        let mut verified = false; let mut after = Status::default();
        loop { match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            DeviceEvent::CalibrationChanged { origin: Some(origin) } => assert_eq!(origin, [10.,20.]),
            DeviceEvent::RegistrationChanged { scale, rotation_deg, matrix: actual } => {
                assert_eq!(scale, 1.); assert_eq!(rotation_deg, 30.); assert_eq!(actual, Some(matrix)); verified = true;
            },
            DeviceEvent::Status(status) => after = status,
            DeviceEvent::Positioning(false) => { assert!(verified); break; },
            DeviceEvent::Error(error) => panic!("{error}"),
            _ => {},
        }}
        for axis in 0..3 {
            assert!((before.position.unwrap()[axis] + before.wco.unwrap()[axis] - after.position.unwrap()[axis] - after.wco.unwrap()[axis]).abs() < 0.001);
        }
        let position = after.position.unwrap();
        assert!((10. + (cos * position[0] + sin * position[1]) / 0.8 - 35.).abs() < 0.002);
        assert!((20. - (-sin * position[0] + cos * position[1]) / 1.2 - 50.).abs() < 0.002);
        let output = trace.lock().unwrap().clone();
        assert!(output.iter().any(|line| line == "> G10 L20 P1 X35.321 Y-21.177 Z0"));
        assert!(output.iter().filter(|line| line.starts_with("> ")).all(|line|
            ["> ?", "> G21", "> G54", "> $G", "> G10 L20 P1 X35.321 Y-21.177 Z0"].contains(&line.as_str())));
        drop(tx); h.join().unwrap();
    }
    #[test]
    fn calibration_writes_only_explicit_g10_and_verifies_new_nonzero_wco() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        calibrate_mock(&tx, &rx);
        let output = trace.lock().unwrap().clone();
        assert!(output
            .iter()
            .any(|s| s == "> G10 L20 P1 X10.000 Y70.000 Z0"));
        assert!(!output
            .iter()
            .any(|s| s.starts_with("> G1 ") || s.contains("$H") || s.contains("G92")));
        assert!(output.iter().any(|s| s.contains("WCO:5,-45,3.5")));
        assert!(
            output.iter().filter(|s| s.as_str() == "> ?").count() >= 2,
            "old cached WCO incorrectly confirmed calibration"
        );
        tx.send(DeviceCommand::Run(job())).unwrap();
        let mut saw_started = false;
        loop {
            match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                DeviceEvent::JobStarted { anchor } => {
                    assert_eq!(anchor, [10., 70., 0.]);
                    saw_started = true
                }
                DeviceEvent::Completed => break,
                DeviceEvent::JobRejected { reason, .. } | DeviceEvent::Error(reason) => {
                    panic!("nonzero verified WCO must work: {reason}")
                }
                _ => {}
            }
        }
        assert!(saw_started);
        drop(tx);
        h.join().unwrap();
        assert!(
            trace
                .lock()
                .unwrap()
                .iter()
                .any(|s| s == "> G1 X-5.000 Y92.000 F1500"),
            "job moved its first point to the tip instead of the fixed canvas location"
        );
    }
    #[test]
    fn jog_does_not_change_calibrated_origin_then_moveto_waits_for_raised_idle() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        calibrate_mock(&tx, &rx);
        tx.send(DeviceCommand::Jog {
            x: 1.,
            y: -1.,
            feed: 9000.,
        })
        .unwrap();
        loop {
            match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                DeviceEvent::Status(s) if s.position == Some([11., 69., 0.]) => break,
                DeviceEvent::CalibrationChanged { .. } => panic!("Jog changed paper origin"),
                _ => {}
            }
        }
        tx.send(DeviceCommand::PenDown { depth: 10.0 }).unwrap();
        loop {
            if matches!(rx.recv_timeout(Duration::from_secs(2)).unwrap(),DeviceEvent::Status(s) if s.position.is_some_and(|p|p[2]==10.))
            {
                break;
            }
        }
        tx.send(DeviceCommand::MoveTo {
            canvas_x: 40.,
            canvas_y: 70.,
            feed: 10000.,
        })
        .unwrap();
        let status = wait_positioning_done(&rx);
        assert_eq!(status.position, Some([30., 30., 0.]));
        let output = trace.lock().unwrap().clone();
        let raise = output.iter().position(|s| s == "> G1 G90 Z0 F300").unwrap();
        let xy = output
            .iter()
            .position(|s| s == "> G1 G90 X30.000 Y30.000 F10000")
            .unwrap();
        assert!(output
            .iter()
            .any(|s| s == "> $J=G91 G21 X1.000 Y-1.000 F9000"));
        assert!(output[raise..xy].iter().any(|s| s.starts_with("< <Run")));
        assert!(output[raise..xy].iter().any(|s| s.starts_with("< <Idle")));
        assert!(!output[raise..].iter().any(|s| s.starts_with("> G10")));
        tx.send(DeviceCommand::ReturnOrigin).unwrap();
        let status = wait_positioning_done(&rx);
        assert_eq!(status.position, Some([0., 0., 0.]));
        drop(tx);
        h.join().unwrap();
        assert!(trace
            .lock()
            .unwrap()
            .iter()
            .any(|s| s == "> G1 G90 X0.000 Y0.000 F1500"));
    }
    #[test]
    fn uncalibrated_and_unconfirmed_controls_refuse_without_automatic_motion() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        for command in [
            DeviceCommand::MoveTo {
                canvas_x: 10.,
                canvas_y: 10.,
                feed: 1500.,
            },
            DeviceCommand::ReturnOrigin,
            DeviceCommand::Calibrate {
                canvas_x: 20.,
                canvas_y: 30.,
                origin_x: 10.,
                origin_y: 100.,
                raised_confirmed: false,
            },
        ] {
            tx.send(command).unwrap();
            let mut error = false;
            loop {
                match rx.recv_timeout(Duration::from_secs(1)).unwrap() {
                    DeviceEvent::Error(_) => error = true,
                    DeviceEvent::Positioning(false) => {
                        assert!(error);
                        break;
                    }
                    _ => {}
                }
            }
        }
        drop(tx);
        h.join().unwrap();
        assert!(trace
            .lock()
            .unwrap()
            .iter()
            .all(|s| !s.starts_with("> ") || s == "> ?"));
    }
    #[test]
    fn positioning_reentry_preserves_busy_and_forbids_queued_job_jog_pen() {
        let wire = PositionWire::new();
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        calibrate_mock(&tx, &rx);
        tx.send(DeviceCommand::MoveTo {
            canvas_x: 40.,
            canvas_y: 70.,
            feed: 1200.,
        })
        .unwrap();
        loop {
            if matches!(
                rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                DeviceEvent::Positioning(true)
            ) {
                break;
            }
        }
        for command in [
            DeviceCommand::MoveTo {
                canvas_x: 50.,
                canvas_y: 50.,
                feed: 1200.,
            },
            DeviceCommand::Calibrate {
                canvas_x: 20.,
                canvas_y: 30.,
                origin_x: 10.,
                origin_y: 100.,
                raised_confirmed: true,
            },
            DeviceCommand::Run(job()),
            DeviceCommand::Jog {
                x: 1.,
                y: 1.,
                feed: 300.,
            },
            DeviceCommand::PenDown { depth: 4.0 },
        ] {
            tx.send(command).unwrap();
        }
        let mut rejected_busy = 0;
        let mut run_rejected = false;
        loop {
            match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
                DeviceEvent::Positioning(true) => rejected_busy += 1,
                DeviceEvent::JobRejected { running: false, .. } => run_rejected = true,
                DeviceEvent::Positioning(false) => break,
                DeviceEvent::Disconnected => {
                    panic!("reentry must not disconnect active positioning")
                }
                _ => {}
            }
        }
        assert!(rejected_busy >= 2);
        assert!(run_rejected);
        drop(tx);
        h.join().unwrap();
        let output = trace.lock().unwrap();
        assert_eq!(output.iter().filter(|s| s.starts_with("> G10")).count(), 1);
        assert!(!output
            .iter()
            .any(|s| s.starts_with("> $J") || s.as_str() == "> G1 G90 Z4 F300"));
    }
    #[test]
    fn fixed_canvas_travel_limits_reject_390mm_jump_without_moving() {
        let mut wire = PositionWire::new();
        wire.mpos = [-195., 0., 0.];
        let trace = wire.trace.clone();
        let (tx, rx, h) = position_worker(wire);
        tx.send(DeviceCommand::Calibrate {
            canvas_x: -195.,
            canvas_y: 0.,
            origin_x: 0.,
            origin_y: 0.,
            raised_confirmed: true,
        })
        .unwrap();
        let mut ok = false;
        loop {
            match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                DeviceEvent::CalibrationChanged { origin: Some(_) } => ok = true,
                DeviceEvent::Positioning(false) if ok => break,
                DeviceEvent::Error(e) => panic!("{e}"),
                _ => {}
            }
        }
        let before = trace.lock().unwrap().len();
        tx.send(DeviceCommand::MoveTo {
            canvas_x: 195.,
            canvas_y: 0.,
            feed: 1500.,
        })
        .unwrap();
        let mut refused = false;
        loop {
            match rx.recv_timeout(Duration::from_secs(1)).unwrap() {
                DeviceEvent::Error(e) => {
                    assert!(e.contains("210"));
                    refused = true
                }
                DeviceEvent::Positioning(false) => {
                    assert!(refused);
                    break;
                }
                _ => {}
            }
        }
        drop(tx);
        h.join().unwrap();
        assert!(!trace.lock().unwrap()[before..]
            .iter()
            .any(|s| s.starts_with("> G1 ")));
    }
    #[test]
    fn calibration_ack_without_matching_fresh_work_coordinates_is_not_confirmation() {
        let mut wire = PositionWire::new();
        wire.ignore_calibration = true;
        let (tx, rx, h) = position_worker(wire);
        tx.send(DeviceCommand::Calibrate {
            canvas_x: 20.,
            canvas_y: 30.,
            origin_x: 10.,
            origin_y: 100.,
            raised_confirmed: true,
        })
        .unwrap();
        let mut rejected = false;
        loop {
            match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                DeviceEvent::CalibrationChanged { origin: Some(_) } => {
                    panic!("ACK alone was accepted as calibration")
                }
                DeviceEvent::Error(reason) => {
                    assert!(reason.contains("Calibration not confirmed"));
                    rejected = true
                }
                DeviceEvent::Positioning(false) => {
                    assert!(rejected);
                    break;
                }
                DeviceEvent::Disconnected => {
                    panic!("safe calibration refusal must preserve connection")
                }
                _ => {}
            }
        }
        drop(tx);
        h.join().unwrap();
    }
    #[test]
    fn disconnect_and_app_close_hold_positioning_even_with_old_idle_and_no_pending_ack() {
        for disconnect in [true, false] {
            let wire = PositionWire::new();
            let trace = wire.trace.clone();
            let (tx, rx, h) = position_worker(wire);
            calibrate_mock(&tx, &rx);
            tx.send(DeviceCommand::MoveTo {
                canvas_x: 40.,
                canvas_y: 70.,
                feed: 1200.,
            })
            .unwrap();
            let mut xy_sent = false;
            loop {
                match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                    DeviceEvent::Log(line) if line == "> G1 G90 X30.000 Y30.000 F1200" => {
                        xy_sent = true
                    }
                    DeviceEvent::Status(s)
                        if xy_sent && s.state == "Idle" && s.position == Some([10., 70., 0.]) =>
                    {
                        break
                    }
                    DeviceEvent::Error(reason) => {
                        panic!("unexpected positioning failure: {reason}")
                    }
                    _ => {}
                }
            }
            if disconnect {
                tx.send(DeviceCommand::Disconnect).unwrap();
                let events = until_disconnect(&rx);
                assert!(events
                    .iter()
                    .any(|e| matches!(e, DeviceEvent::CalibrationChanged { origin: None })));
            }
            drop(tx);
            h.join().unwrap();
            let output = trace.lock().unwrap();
            assert!(
                output.iter().any(|line| line.starts_with("> !")),
                "closing an active positioning wait did not hold"
            );
            assert!(
                !output.iter().any(|line| line.contains('\u{18}')),
                "closing alone must not reset a controller"
            );
        }
    }
}
