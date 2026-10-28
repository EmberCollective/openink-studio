fn main() {
    // Public exports omit this feature and its local dependency.
    println!("cargo:rustc-check-cfg=cfg(feature, values(\"private-gfont\"))");
    tauri_build::build()
}
