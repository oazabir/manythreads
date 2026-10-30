fn main() {
    // The commands the first-screen page may call. They are listed here so that no other page (above all, the live server's own)
    // can call them: a capability must name them, and only `capabilities/picker.json` does.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["default_server", "connect_server"]),
        ),
    )
    .expect("failed to run the Tauri build step");
}
