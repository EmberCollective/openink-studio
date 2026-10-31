//! Acceptance entry points using the shipped application's import/device paths.
//! Import checks are offline; --check-connection uses the normal connection
//! workflow, including authorized automatic recovery and pen lift if required.
use crate::import::{self, ImportOptions};
use serde_json::{json, Value};
use std::path::Path;

fn disconnect_and_wait(service: &crate::device::DeviceService, event_path: &str) {
    use crate::device::{DeviceCommand, DeviceEvent};
    use std::{
        io::Write,
        time::{Duration, Instant},
    };
    service.command(DeviceCommand::Disconnect);
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut log = std::fs::OpenOptions::new()
        .append(true)
        .open(event_path)
        .ok();
    while Instant::now() < deadline {
        for event in service.poll() {
            if let Some(log) = &mut log {
                let _ = writeln!(log, "CLEANUP {:?}", event);
                let _ = log.flush();
                let _ = log.sync_data();
            }
            if matches!(event, DeviceEvent::Disconnected) {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if let Some(log) = &mut log {
        let _ = writeln!(
            log,
            "CLEANUP ERROR: disconnect confirmation timed out after 3 seconds"
        );
        let _ = log.sync_data();
    }
}

// Every return path, including a failed log write, must let the worker finish
// its active-motion hold/disconnect before run_if_requested exits the process.
struct WriteCleanup<'a> {
    service: &'a crate::device::DeviceService,
    event_path: &'a str,
    disconnected: std::cell::Cell<bool>,
}
impl Drop for WriteCleanup<'_> {
    fn drop(&mut self) {
        if !self.disconnected.get() {
            disconnect_and_wait(self.service, self.event_path);
        }
    }
}

#[cfg(feature = "private-gfont")]
fn write_legacy(args: &[String]) -> Result<Value, String> {
    use crate::device::{DeviceCommand, DeviceEvent, DeviceService, Job};
    use std::{
        fs::OpenOptions,
        io::Write,
        time::{Duration, Instant},
    };
    let value = |flag: &str| {
        args.iter()
            .position(|s| s == flag)
            .and_then(|i| args.get(i + 1))
    };
    let source = args.get(2).ok_or("--write-legacy requires a font path")?;
    let report = value("--report").ok_or("--write-legacy requires --report PATH")?;
    let size: f64 = value("--size")
        .map(String::as_str)
        .unwrap_or("25")
        .parse()
        .map_err(|_| "Invalid size")?;
    let mut options = crate::legacy_font::ComposeOptions::default();
    options.size_mm = size;
    let composition = crate::legacy_font::compose(
        &[crate::legacy_font::FontSelection {
            path: source.clone(),
            weight: 1.,
        }],
        value("--text").map(String::as_str).unwrap_or("永"),
        &options,
    )?;
    if !composition.missing.is_empty() {
        return Err(format!("Missing glyphs: {:?}", composition.missing));
    }
    let mut job = Job {
        document: composition.document,
        feed: 1200.,
        travel_feed: 1500.,
        z_feed: 300.,
        z_down: 4.,
    };
    let first = job
        .document
        .strokes
        .iter()
        .find(|s| s.len() >= 2)
        .ok_or("No drawable strokes")?[0];
    let execute = args.iter().any(|s| s == "--execute");
    let gcode_path = format!("{report}.gcode");
    let event_path = format!("{report}.events.log");
    if !execute {
        let lines = crate::device::build_relative_job(&job)?;
        std::fs::write(&gcode_path, format!("{}\n", lines.join("\n")))
            .map_err(|e| e.to_string())?;
        return Ok(
            json!({"success":true,"dry_run":true,"hardware_accessed":false,"gcode":gcode_path,"document":document_summary(&job.document)}),
        );
    }
    if !args.iter().any(|s| s == "--confirm-raised") {
        return Err("--execute requires explicit --confirm-raised".into());
    }
    let port = value("--port").ok_or("--execute requires --port")?;
    let mut log = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&event_path)
        .map_err(|e| e.to_string())?;
    let service = DeviceService::new();
    let cleanup = WriteCleanup {
        service: &service,
        event_path: &event_path,
        disconnected: std::cell::Cell::new(false),
    };
    service.command(DeviceCommand::Connect { port: port.clone(), swap_xy: false });
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut phase = 0;
    let mut connected = false;
    let mut status = None;
    let mut calibrated = false;
    let mut calibration_done = false;
    let mut planned = Vec::<String>::new();
    while Instant::now() < deadline {
        for event in service.poll() {
            writeln!(log, "{:?}", event)
                .and_then(|_| log.flush())
                .and_then(|_| log.sync_data())
                .map_err(|e| e.to_string())?;
            match event {
                DeviceEvent::Connected(_) => connected = true,
                DeviceEvent::Status(s) => status = Some(s),
                DeviceEvent::CalibrationChanged {
                    origin: Some(origin),
                } if origin == [0., 0.] => calibrated = true,
                DeviceEvent::Positioning(false) if calibrated => calibration_done = true,
                DeviceEvent::Error(reason) | DeviceEvent::JobRejected { reason, .. } => {
                    return Err(format!("{reason}; event log: {event_path}"));
                }
                DeviceEvent::Disconnected => {
                    cleanup.disconnected.set(true);
                    return Err(format!("Disconnected; event log: {event_path}"));
                }
                DeviceEvent::Completed if phase == 2 => {
                    let final_status = status.as_ref().ok_or("Completed without status")?;
                    if final_status.state != "Idle"
                        || !final_status.position.is_some_and(|p| p[2].abs() <= 0.05)
                    {
                        return Err("Completion lacks final Idle/Z0".into());
                    }
                    return Ok(
                        json!({"success":true,"hardware_accessed":true,"motion_sent":true,"status":final_status,"gcode":gcode_path,"events":event_path,"commands":planned.len(),"document":document_summary(&job.document)}),
                    );
                }
                _ => {}
            }
        }
        if phase == 0 && connected {
            if let Some(s) = &status {
                if s.state != "Idle"
                    || s.position
                        .is_some_and(|p| !p.iter().all(|v| v.is_finite()) || p[2].abs() > 0.05)
                {
                    return Err("Write preflight requires fresh Idle and manually raised calibrated Z0; no calibration or job sent".into());
                }
                if s.state == "Idle"
                    && s.wco.is_some()
                    && s.position
                        .is_some_and(|p| p.iter().all(|v| v.is_finite()) && p[2].abs() <= 0.05)
                {
                    let p = s.position.unwrap();
                    for stroke in &mut job.document.strokes {
                        for point in stroke {
                            point.x += p[0] - first.x;
                            point.y += -p[1] - first.y;
                        }
                    }
                    planned = crate::device::build_canvas_job(&job, [0., 0.])?;
                    crate::positioning::check_job_travel(&job, [0., 0.], p)?;
                    std::fs::write(&gcode_path, format!("{}\n", planned.join("\n")))
                        .map_err(|e| e.to_string())?;
                    writeln!(log, "PLANNED {} commands: {}", planned.len(), gcode_path)
                        .and_then(|_| log.flush())
                        .and_then(|_| log.sync_data())
                        .map_err(|e| e.to_string())?;
                    service.command(DeviceCommand::Calibrate {
                        canvas_x: p[0],
                        canvas_y: -p[1],
                        origin_x: 0.,
                        origin_y: 0.,
                        raised_confirmed: true,
                    });
                    phase = 1;
                }
            }
        }
        if phase == 1 && calibration_done {
            service.command(DeviceCommand::Run(job.clone()));
            phase = 2;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err(format!(
        "Write acceptance timed out; event log: {event_path}"
    ))
}

fn check_connection(port: String) -> Result<Value, String> {
    use crate::device::{DeviceCommand, DeviceEvent, DeviceService};
    use std::time::{Duration, Instant};
    let service = DeviceService::new();
    service.command(DeviceCommand::Connect { port: port.clone(), swap_xy: false });
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut connected = false;
    let mut status = None;
    let mut logs = Vec::new();
    while Instant::now() < deadline {
        for event in service.poll() {
            match event {
                DeviceEvent::Connected(_) => connected = true,
                DeviceEvent::Status(value) => status = Some(value),
                DeviceEvent::Log(value) => logs.push(value),
                DeviceEvent::Error(error) => return Err(error),
                _ => {}
            }
        }
        if connected
            && status
                .as_ref()
                .is_some_and(|s| s.position.is_some() && s.wco.is_some())
        {
            service.command(DeviceCommand::Disconnect);
            return Ok(
                json!({"success":true,"port":port,"status":status,"logs":logs,"hardware_accessed":true,"automatic_recovery_enabled":true,"motion_sent":null}),
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err("Connection check timed out".into())
}

fn document_summary(document: &crate::model::Document) -> Value {
    json!({"name":document.name,"width_mm":document.width_mm,"height_mm":document.height_mm,
        "paths":document.strokes.len(),"points":document.strokes.iter().map(Vec::len).sum::<usize>()})
}

pub fn run_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let legacy = args.get(1).map(String::as_str) == Some("--check-legacy");
    let connection = args.get(1).map(String::as_str) == Some("--check-connection");
    let writing = args.get(1).map(String::as_str) == Some("--write-legacy");
    if !connection
        && !legacy
        && !writing
        && args.get(1).map(String::as_str) != Some("--check-import")
    {
        return false;
    }
    let value = |flag: &str| {
        args.iter()
            .position(|s| s == flag)
            .and_then(|i| args.get(i + 1))
    };
    let result = (|| -> Result<Value, String> {
        if writing {
            #[cfg(feature = "private-gfont")]
            return write_legacy(&args);
            #[cfg(not(feature = "private-gfont"))]
            return Err("This build does not include private gfont support".into());
        }
        let source = args.get(2).ok_or("--check-import requires a source path")?;
        if connection {
            return check_connection(source.clone());
        }
        if legacy {
            #[cfg(not(feature = "private-gfont"))]
            return Err("This build does not include private gfont support".into());
            #[cfg(feature = "private-gfont")]
            {
            let font = crate::legacy_font::load(Path::new(source))?;
            let composition = crate::legacy_font::compose(
                &[crate::legacy_font::FontSelection {
                    path: source.clone(),
                    weight: 1.,
                }],
                value("--text").map(String::as_str).unwrap_or("永"),
                &crate::legacy_font::ComposeOptions::default(),
            )?;
            if !composition.missing.is_empty() {
                return Err(format!("Missing glyphs: {:?}", composition.missing));
            }
            return Ok(
                json!({"success":true,"font":font.summary,"document":document_summary(&composition.document),"hardware_accessed":false}),
            );
            }
        }
        let mut options = ImportOptions::default();
        if let Some(page) = value("--page") {
            options.page = page.parse().map_err(|_| "Invalid page number")?;
        }
        let document = import::import_file(Path::new(source), &options)?;
        let mut report = json!({"success":true,"source":source,"options":options,"document":document_summary(&document),"hardware_accessed":false});
        if args.iter().any(|s| s == "--comparison") {
            let variants = import::preview_variants(Path::new(source), &options)?;
            report["variants"]=Value::Array(variants.into_iter().map(|v|json!({"label":v.label,"source":v.source,"page":v.page,"options":v.options,"document":document_summary(&v.document)})).collect());
        }
        Ok(report)
    })();
    let report = match result {
        Ok(report) => report,
        Err(error) => {
            json!({"success":false,"error":error,"hardware_accessed":connection || (cfg!(feature = "private-gfont") && writing && args.iter().any(|s| s == "--execute"))})
        }
    };
    if let Some(path) = value("--report") {
        if let Err(error) = std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()) {
            eprintln!("Cannot write acceptance report: {error}");
            std::process::exit(2);
        }
    } else {
        println!("{}", report);
    }
    std::process::exit(if report["success"] == true { 0 } else { 1 });
}
