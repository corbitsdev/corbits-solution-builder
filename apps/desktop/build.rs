fn main() {
    // The icon is embedded at compile time, and Tauri's own build script
    // watches the config that names the icon files but not the files. Without
    // this, a new icon ships only after something else forces a rebuild.
    println!("cargo:rerun-if-changed=icons");

    // The window is a remote origin, the host's loopback URL, and a remote
    // origin may call only the commands its capability grants. Declaring the
    // commands here generates their `allow-…` permissions for the capability
    // to name.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "dictation_start",
                "dictation_stop",
                "dictation_open_settings",
                "start_at_login",
                "set_start_at_login",
            ]),
        ),
    )
    .expect("the desktop shell's build script failed");
}
