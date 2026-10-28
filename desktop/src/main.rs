#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod clipboard;
mod project;
mod paper;
mod device;
mod glyphs;
mod import;
mod job_timing;
#[cfg(feature = "private-gfont")]
use openink_gfont as legacy_font;
#[cfg(all(test, feature = "private-gfont"))]
#[path = "../../private/gfont/desktop_tests.rs"]
mod legacy_font_tests;
mod lined_text;
use openink_model as model;
mod positioning;
mod registration_profiles;
mod route_compare;
mod route_opt;
mod runtime_checks;
mod stroke_merge;
mod stroke_refine;
mod templates;

fn main() {
    if runtime_checks::run_if_requested() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::Backend::new())
        .invoke_handler({
            let public_handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
            project::save_project,
            project::open_project,
            project::startup_project_path,
            paper::paper_background,
            clipboard::clipboard_files,
            clipboard::clipboard_file_preview,
            registration_profiles::list_registration_profiles,
            registration_profiles::save_registration_profile,
            commands::device_command,
            commands::poll_device,
            commands::default_import_options,
            commands::private_gfont_available,
            commands::import_document,
            commands::import_comparison,
            commands::pdf_page_count,
            commands::pdf_background_page,
            commands::font_document,
            lined_text::lined_text_document,
            commands::generate_gcode,
            commands::optimize_document,
            commands::compare_routes,
            commands::export_document,
            commands::export_gcode,
            commands::list_templates,
            commands::save_template,
            commands::delete_template,
            commands::list_fonts,
            commands::import_template,
            commands::export_template,
            commands::list_glyph_fonts,
            commands::save_glyph,
            commands::glyph_font_document
            ];
            #[cfg(feature = "private-gfont")]
            let private_handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![commands::list_legacy_fonts, commands::import_legacy_fonts, commands::legacy_font_document];
            move |invoke: tauri::ipc::Invoke| {
                #[cfg(feature = "private-gfont")]
                if matches!(invoke.message.command(), "list_legacy_fonts" | "import_legacy_fonts" | "legacy_font_document") {
                    return private_handler(invoke);
                }
                public_handler(invoke)
            }
        })
        .run(tauri::generate_context!())
        .expect("Unable to launch OpenInk Studio");
}
