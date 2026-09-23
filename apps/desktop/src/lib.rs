//! The native desktop host.
//!
//! Local mode supervises the compiled Bun sidecar, waits for its loopback
//! handshake, and opens a window on the URL the sidecar prints.
//!
//! Remote mode (`SOLUTIONS_BUILDER_HUB_URL`) skips that sidecar entirely and
//! opens the window on the named origin. There is no local hub process.
//!
//! One rule is the point of this product's host model:
//!
//!   **Closing the window does not stop the sidecar.**
//!
//! The window is a client, not the app. Closing it hides the window and leaves
//! already-authorised work running to its next human gate; the tray reflects
//! that state and is the only place an explicit stop can be chosen. The
//! sidecar is reaped on Quit, and on Quit alone. Remote mode has no sidecar to
//! reap.

pub mod dictation;

use std::{
    error::Error,
    io::{self, BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const HANDSHAKE_PREFIX: &str = "Solution Builder launch URL: ";
/** The window's name when the page has none of its own to give it. */
const APP_TITLE: &str = "Solution Builder";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

type AppResult<T> = Result<T, Box<dyn Error>>;

struct HostProcess {
    child: Mutex<Option<Child>>,
    launch_url: tauri::Url,
    /// The host leads its own process group, as it does in a packaged app.
    /// In development it stays in the launcher's, so Ctrl-C reaches it.
    detached: bool,
}

impl HostProcess {
    fn launch(app: &AppHandle) -> AppResult<Self> {
        let resource_dir = app.path().resource_dir()?;
        let development = development_host_command()?;
        let detached = development.is_none();
        let mut command = match development {
            Some(command) => command,
            None => Command::new(resolve_host_executable()?),
        };

        // The development launcher points this at the repo's `dist`, which it
        // keeps rebuilding; overriding it here served the stale snapshot Tauri
        // copies into `target/debug` and the window never reloaded.
        let dist_dir = std::env::var_os("SOLUTIONS_BUILDER_DIST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| resource_dir.join("dist"));

        command
            .env("SOLUTIONS_BUILDER_DIST_DIR", dist_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if detached {
            // The packaged host outlives this process on purpose: the window
            // going away must not end it, so it leads its own process group
            // and is told nothing about its parent.
            #[cfg(unix)]
            command.process_group(0);
        } else {
            // The development host is the launcher's to end. It stays in the
            // terminal's process group, so Ctrl-C reaches it, and it watches
            // this process, so a rebuild that kills the window outright does
            // not leave it holding the workspace against the next one.
            command.arg("--parent-pid").arg(std::process::id().to_string());
        }

        let mut child = command.spawn().map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("could not start the bundled Solution Builder host: {error}"),
            )
        })?;

        let Some(stdout) = child.stdout.take() else {
            terminate_and_reap(&mut child, detached);
            return Err(invalid_input("host stdout handshake pipe is unavailable"));
        };
        let Some(stderr) = child.stderr.take() else {
            terminate_and_reap(&mut child, detached);
            return Err(invalid_input("host stderr pipe is unavailable"));
        };
        let stderr_tail = forward(stderr);

        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if let Some(value) = line.strip_prefix(HANDSHAKE_PREFIX) {
                            let _ = sender.send(value.to_owned());
                        } else {
                            eprintln!("[host] {line}");
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // pglite unpacks a WASM image on a cold start, so the window waits
        // rather than racing it.
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let launch_url = loop {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(value) => break validate_launch_url(&value),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Err(invalid_input(
                        "the host closed stdout before sending its launch URL",
                    ))
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    break Err(invalid_input(format!(
                        "the host exited before readiness with status {status}"
                    )))
                }
                Ok(None) => {}
                Err(error) => break Err(Box::new(error)),
            }
            if Instant::now() >= deadline {
                break Err(invalid_input("host readiness timed out after 60 seconds"));
            }
        };

        match launch_url {
            Ok(launch_url) => Ok(Self {
                child: Mutex::new(Some(child)),
                launch_url,
                detached,
            }),
            Err(error) => {
                terminate_and_reap(&mut child, detached);
                let detail = stderr_tail
                    .lock()
                    .map(|lines| lines.join("\n"))
                    .unwrap_or_default();
                Err(invalid_input(format!("{error}\n\n{detail}")))
            }
        }
    }

    /// Open a remote origin. No local hub is started.
    fn remote(launch_url: tauri::Url) -> Self {
        Self {
            child: Mutex::new(None),
            launch_url,
            detached: false,
        }
    }

    /// Called on Quit only. Closing a window never reaches this.
    fn shutdown(&self) {
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut child) = slot.take() {
                terminate_and_reap(&mut child, self.detached);
            }
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        let detached = self.detached;
        if let Ok(slot) = self.child.get_mut() {
            if let Some(mut child) = slot.take() {
                terminate_and_reap(&mut child, detached);
            }
        }
    }
}

/// Debug builds may run the host from source so backend edits reload.
/// Release builds ignore the override and always use the bundled sidecar.
#[cfg(debug_assertions)]
fn development_host_command() -> AppResult<Option<Command>> {
    let Some(value) = std::env::var_os("SOLUTIONS_BUILDER_HOST_COMMAND") else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .ok_or_else(|| invalid_input("SOLUTIONS_BUILDER_HOST_COMMAND is not valid UTF-8"))?;
    let mut parts = value.split_whitespace();
    let program = parts
        .next()
        .ok_or_else(|| invalid_input("SOLUTIONS_BUILDER_HOST_COMMAND is empty"))?;
    let mut command = Command::new(program);
    command.args(parts);
    Ok(Some(command))
}

#[cfg(not(debug_assertions))]
fn development_host_command() -> AppResult<Option<Command>> {
    Ok(None)
}

fn resolve_host_executable() -> AppResult<PathBuf> {
    let path = std::env::current_exe()?
        .parent()
        .ok_or_else(|| invalid_input("the desktop executable has no parent directory"))?
        .join("solutions-builder-host");
    if !path.is_file() {
        return Err(invalid_input(format!(
            "the bundled Solution Builder host is missing: {}",
            path.display()
        )));
    }
    Ok(path.canonicalize()?)
}

/// The handshake must name a loopback URL carrying a session token. Anything
/// else is refused rather than loaded.
fn validate_launch_url(value: &str) -> AppResult<tauri::Url> {
    let url = tauri::Url::parse(value.trim())?;
    let has_token = url
        .query_pairs()
        .any(|(name, value)| name == "token" && !value.is_empty());
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
        || !has_token
    {
        return Err(invalid_input(
            "the host handshake returned an invalid loopback launch URL",
        ));
    }
    Ok(url)
}

/// `SOLUTIONS_BUILDER_HUB_URL`, when set, is a remote origin: the shell loads
/// it and must not spawn a host to wait for a handshake.
fn configured_remote_hub_url() -> AppResult<Option<tauri::Url>> {
    match std::env::var("SOLUTIONS_BUILDER_HUB_URL") {
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(invalid_input(
            "SOLUTIONS_BUILDER_HUB_URL is not valid UTF-8",
        )),
        Ok(value) => remote_hub_url_from(Some(&value)),
    }
}

fn remote_hub_url_from(value: Option<&str>) -> AppResult<Option<tauri::Url>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(validate_remote_hub_url(trimmed)?))
}

fn validate_remote_hub_url(value: &str) -> AppResult<tauri::Url> {
    let trimmed = value.trim().trim_end_matches('/');
    let url = tauri::Url::parse(trimmed)?;
    if (url.scheme() != "http" && url.scheme() != "https")
        || url.host_str().is_none()
        || url.username() != ""
        || url.password().is_some()
    {
        return Err(invalid_input(
            "SOLUTIONS_BUILDER_HUB_URL must be an http or https URL with a host",
        ));
    }
    Ok(url)
}

fn resolve_shell_host(app: &AppHandle) -> AppResult<HostProcess> {
    match configured_remote_hub_url()? {
        Some(url) => Ok(HostProcess::remote(url)),
        None => HostProcess::launch(app),
    }
}

/// Mirrors the host's stderr to this process and keeps the last lines.
///
/// The tail is what makes a startup failure diagnosable: without it the window
/// can only say the host did not start, which is the least useful half of the
/// story. `MAX_TAIL_LINES` is small on purpose — a stack trace's first lines
/// carry the cause, and an unbounded buffer would hold a runaway log forever.
const MAX_TAIL_LINES: usize = 40;

/// Longest stderr line kept whole.
///
/// A runtime error from Bun prints the source line it failed on. When that
/// line is inside a bundled dependency it is minified — thousands of characters
/// on one line — and it pushes the actual message out of the tail. Anything
/// past this is a machine artefact, not a sentence, so it is elided rather than
/// stored.
const MAX_LINE_LENGTH: usize = 240;

/// Whether a line is worth showing a person.
///
/// Minified bundle spill is filtered on shape, not on content: no diagnostic
/// worth reading is one long line with no spaces.
fn is_readable(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.len() > MAX_LINE_LENGTH {
        return false;
    }
    // A line that is mostly punctuation and identifiers with no spaces is code.
    let spaces = trimmed.chars().filter(|character| *character == ' ').count();
    trimmed.len() < 80 || spaces * 12 >= trimmed.len()
}

fn forward(stream: impl io::Read + Send + 'static) -> Arc<Mutex<Vec<String>>> {
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&tail);
    thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            match line {
                Ok(line) => {
                    // Everything still reaches the terminal; only what the
                    // failure window shows is filtered.
                    eprintln!("[host] {line}");
                    if !is_readable(&line) {
                        continue;
                    }
                    if let Ok(mut buffer) = sink.lock() {
                        if buffer.len() == MAX_TAIL_LINES {
                            buffer.remove(0);
                        }
                        buffer.push(line);
                    }
                }
                Err(_) => break,
            }
        }
    });
    tail
}

fn terminate_and_reap(child: &mut Child, detached: bool) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }

    // SIGTERM is the host's explicit-stop signal: it drains committed effects
    // before exiting, which is why it gets a grace period rather than a kill.
    #[cfg(unix)]
    signal_host(child.id(), detached, libc::SIGTERM);
    #[cfg(not(unix))]
    let _ = child.kill();

    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(_) => break,
        }
    }

    #[cfg(unix)]
    signal_host(child.id(), detached, libc::SIGKILL);
    let _ = child.kill();
    let _ = child.wait();
}

/// A detached host leads its own process group, so the group is signalled
/// and the desktop process cannot be. A development host shares the
/// launcher's group, so only the host itself is.
#[cfg(unix)]
fn signal_host(pid: u32, detached: bool, signal: libc::c_int) {
    unsafe {
        if detached {
            libc::killpg(pid as libc::pid_t, signal);
        } else {
            libc::kill(pid as libc::pid_t, signal);
        }
    }
}

fn invalid_input(message: impl Into<String>) -> Box<dyn Error> {
    Box::new(io::Error::new(io::ErrorKind::InvalidData, message.into()))
}

fn open_window(app: &AppHandle) -> AppResult<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    let url = app
        .try_state::<HostProcess>()
        .ok_or_else(|| invalid_input("the host is not running"))?
        .launch_url
        .clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title(APP_TITLE)
        .inner_size(1280.0, 880.0)
        .min_inner_size(960.0, 640.0)
        .center()
        // The window's title is what a print job is named after on macOS, and
        // so what "Save as PDF" offers. The page sets its title to the
        // project's and the document's while it is printing; the window
        // follows it, and returns to the app's own name when the page does.
        .on_document_title_changed(|window, title| {
            let title = title.trim();
            let _ = window.set_title(if title.is_empty() { APP_TITLE } else { title });
        })
        .build()?;
    Ok(())
}

/// Renders a startup failure as a window the person can actually read.
///
/// Self-contained HTML on a data URL: the host is what serves assets, and it is
/// precisely what failed, so anything fetched would fail too.
fn show_startup_failure(app: &AppHandle, detail: &str) {
    let escaped = detail
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");

    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Solution Builder</title>\
<style>body{{font:15px/1.55 -apple-system,system-ui,sans-serif;margin:0;padding:40px;\
background:#fff;color:#2b2627}}h1{{font-size:1.375rem;font-weight:400;margin:0 0 8px}}\
p{{color:#5c5555;margin:0 0 20px;max-width:64ch}}pre{{font:12px/1.6 ui-monospace,Menlo,monospace;\
background:#f2f4f5;border:1px solid #dfe3e6;padding:16px;overflow:auto;white-space:pre-wrap;\
max-height:52vh;margin:0}}</style>\
<h1>The host did not start.</h1>\
<p>Solution Builder runs its API and the Interchange hub in a background \
process. That process exited before it was ready, so there is nothing to show \
yet. The reason it gave is below.</p>\
<pre>{escaped}</pre>"
    );

    let url = format!("data:text/html;charset=utf-8,{}", urlencode(&html));
    let built = tauri::Url::parse(&url)
        .map_err(|error| error.to_string())
        .and_then(|url| {
            WebviewWindowBuilder::new(app, "startup-failure", WebviewUrl::External(url))
                .title("Solution Builder")
                .inner_size(760.0, 560.0)
                .center()
                .build()
                .map_err(|error| error.to_string())
        });

    if let Err(error) = built {
        // Last resort: the window itself could not be opened. The console is
        // all that is left, and saying so is better than exiting silently.
        eprintln!("Solution Builder could not start, and could not show why: {error}");
        eprintln!("{detail}");
    }
}

/// Percent-encodes the bytes a `data:` URL cannot carry literally.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b'/'
            | b':'
            | b'='
            | b'('
            | b')'
            | b','
            | b';'
            | b'\'' => out.push(*byte as char),
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Whether the app is registered to start at login. The plugin's own
/// registration is the stored choice — there is no marker file to keep in
/// step.
#[tauri::command]
fn start_at_login(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Registers or removes the login item, taking effect at the next login.
#[tauri::command]
fn set_start_at_login(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if enabled { manager.enable() } else { manager.disable() };
    result.map_err(|error| error.to_string())
}

/// Quits the app. The exit handler stops the host with the same grace the
/// tray's Quit gives it — the page's stop button and the menu item are the
/// same path.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    let app = tauri::Builder::default()
        // §3: start-at-login is optional and reversible. Registered here so
        // the *capability* exists; whether it is enabled is a stored choice
        // the person makes, never a side effect of installing.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // Dictation runs in this process: the page asks to start and stop,
        // and hears levels, transcripts and the end as events.
        .manage(dictation::Dictation::default())
        .invoke_handler(tauri::generate_handler![
            dictation::dictation_start,
            dictation::dictation_stop,
            dictation::dictation_open_settings,
            start_at_login,
            set_start_at_login,
            quit_app
        ])
        .setup(|app| {
            // A failed start is a thing to read, not a thing to crash on.
            // Propagating this with `?` makes Tauri panic inside
            // `did_finish_launching`, which aborts without unwinding and prints
            // a Rust backtrace — accurate, and useless to the person holding
            // the app.
            let host = match resolve_shell_host(app.handle()) {
                Ok(host) => host,
                Err(error) => {
                    show_startup_failure(app.handle(), &error.to_string());
                    return Ok(());
                }
            };
            app.manage(host);
            open_window(app.handle())?;

            // The tray is a view of host state and the only place an explicit
            // stop lives. It exists precisely because closing the window is
            // not a stop.
            let open =
                MenuItem::with_id(app, "open", "Open Solution Builder", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "Stop the host and quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .tooltip("Solution Builder — the host keeps working with the window closed")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Err(error) = open_window(app) {
                            eprintln!("could not open the window: {error}");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Solution Builder desktop host");

    app.run(|app_handle, event| match event {
        // Quit is the only thing that stops the host.
        RunEvent::Exit => {
            if let Some(host) = app_handle.try_state::<HostProcess>() {
                host.shutdown();
            }
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            // Hide, do not exit. Authorised agents continue to the next human
            // gate and the host fires a desktop notification when they get there.
            api.prevent_close();
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_or_blank_hub_url_is_local_mode() {
        assert!(remote_hub_url_from(None).unwrap().is_none());
        assert!(remote_hub_url_from(Some("")).unwrap().is_none());
        assert!(remote_hub_url_from(Some("  \n")).unwrap().is_none());
    }

    #[test]
    fn remote_https_url_is_accepted_without_spawning() {
        let url = remote_hub_url_from(Some("https://hub.example.com/"))
            .unwrap()
            .expect("remote");
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("hub.example.com"));
        let host = HostProcess::remote(url);
        assert!(host.child.lock().unwrap().is_none());
    }

    #[test]
    fn remote_http_loopback_is_accepted() {
        let url = validate_remote_hub_url("http://127.0.0.1:8080/app/").unwrap();
        assert_eq!(url.scheme(), "http");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.port(), Some(8080));
    }

    #[test]
    fn remote_file_and_userinfo_urls_are_refused() {
        assert!(validate_remote_hub_url("file:///etc/passwd").is_err());
        assert!(validate_remote_hub_url("ftp://hub.example.com").is_err());
        assert!(validate_remote_hub_url("https://user:pass@hub.example.com").is_err());
    }

    #[test]
    fn local_handshake_url_still_requires_loopback_token() {
        let url = validate_launch_url("http://127.0.0.1:1234/?token=abc").unwrap();
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert!(validate_launch_url("https://hub.example.com/").is_err());
    }
}
