fn main() {
    // The window is a remote origin, the host's loopback URL, and a remote
    // origin may call only the commands its capability grants. Declaring the
    // commands here generates their `allow-…` permissions for the capability
    // to name.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["dictation_start", "dictation_stop"]),
        ),
    )
    .expect("the desktop shell's build script failed");
}
