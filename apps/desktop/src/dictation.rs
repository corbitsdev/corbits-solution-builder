//! Dictation: Apple's speech recognizer fed by the audio engine, in this
//! process, streamed to the page as events.
//!
//! The webview's own speech API is not usable here. In a WKWebView it starts
//! the system session, the chime plays, and then nothing reaches the page:
//! no result, no error, no end. And it could never report the input level
//! the composer's waveform draws. So the shell owns the microphone: it asks
//! for the two permissions, taps the input node, hands each buffer to the
//! recognizer, and emits `dictation` events with the level, each partial
//! transcript, and the end.
//!
//! A session ends on the first of: the person tapping the microphone again,
//! 1.5 seconds of silence after they have spoken, six seconds of nothing at
//! all, the recognizer delivering its final result, or the recognizer
//! reporting an error. Every end is an event with a reason.
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};
use objc2_avf_audio::{AVAudioEngine, AVAudioInputNode, AVAudioPCMBuffer, AVAudioTime};
use objc2_foundation::NSError;
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Where events go: the page, through the app handle, or a test's stdout.
pub type Emit = Box<dyn Fn(Event) + Send + Sync>;

const EVENT: &str = "dictation";
const SILENCE_AFTER_SPEECH: Duration = Duration::from_millis(1500);
const SILENCE_BEFORE_SPEECH: Duration = Duration::from_secs(6);
/// After the audio is closed, how long the recognizer gets to say its last word.
const FINAL_RESULT_GRACE: Duration = Duration::from_secs(2);
/// RMS above which a buffer counts as sound. Room noise sits well under it.
const SOUND_FLOOR: f32 = 0.015;
/// Levels go out no more often than this; the tap fires forty times a second.
const LEVEL_INTERVAL: Duration = Duration::from_millis(50);
const PERMISSION_WAIT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Event {
    /// Input level, 0 to 1, roughly forty times a second while listening.
    Level { level: f32 },
    /// The transcript so far. `final` is the recognizer's last word on it.
    Text {
        text: String,
        #[serde(rename = "final")]
        is_final: bool,
    },
    /// Why it stopped: `stopped`, `silence`, `final`, or the recognizer's message.
    /// When the reason is a setting the person can change, `help` says which.
    End {
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        help: Option<Help>,
    },
}

/// A reason turned into something to do: what is wrong, and the System
/// Settings pane that fixes it.
#[derive(Clone, Debug, Serialize)]
pub struct Help {
    pub title: String,
    pub detail: String,
    /// The button's label.
    pub action: String,
    /// A key `dictation_open_settings` understands.
    pub pane: String,
}

impl Event {
    fn end(reason: &str) -> Event {
        Event::End { reason: reason.to_owned(), help: help_for(reason) }
    }
}

/// The recognizer's and the permissions' failures that are settings, with
/// where to change them. Anything else is shown as it came.
fn help_for(reason: &str) -> Option<Help> {
    let lower = reason.to_lowercase();
    let help = |title: &str, detail: &str, action: &str, pane: &str| {
        Some(Help {
            title: title.into(),
            detail: detail.into(),
            action: action.into(),
            pane: pane.into(),
        })
    };
    if lower.contains("siri and dictation") {
        return help(
            "Turn on Dictation or Siri",
            "Speech recognition on this Mac runs through Siri or Dictation, and both are off. Turn on Dictation in the Keyboard settings, or turn on Siri, then tap the microphone again.",
            "Open Keyboard settings",
            "dictation",
        );
    }
    if lower.contains("microphone was not allowed") {
        return help(
            "Allow the microphone",
            "macOS is not letting Solution Builder use the microphone. Turn it on under Privacy & Security, Microphone, then tap the microphone again.",
            "Open Microphone privacy settings",
            "microphone",
        );
    }
    if lower.contains("speech recognition was not allowed") {
        return help(
            "Allow speech recognition",
            "macOS is not letting Solution Builder use speech recognition. Turn it on under Privacy & Security, Speech Recognition, then tap the microphone again.",
            "Open Speech Recognition privacy settings",
            "speech",
        );
    }
    None
}

/// The System Settings panes `Help::pane` can name.
fn settings_url(pane: &str) -> Option<&'static str> {
    match pane {
        "dictation" => Some("x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Dictation"),
        "siri" => Some("x-apple.systempreferences:com.apple.Siri-Settings.extension"),
        "microphone" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"),
        "speech" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"),
        _ => None,
    }
}


/// Everything a session holds. The Objective-C objects are documented as
/// usable from any thread and are only ever reached through this struct's
/// methods, which is what the `Send`/`Sync` below rests on.
struct Inner {
    emit: Emit,
    engine: Retained<AVAudioEngine>,
    input: Retained<AVAudioInputNode>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Mutex<Option<Retained<SFSpeechRecognitionTask>>>,
    /// Kept so the recognizer outlives the task it is running.
    _recognizer: Retained<SFSpeechRecognizer>,
    started: Instant,
    last_sound: Mutex<Instant>,
    heard_speech: AtomicBool,
    /// Audio closed; nothing more goes to the recognizer.
    closing: AtomicBool,
    /// The end event has gone out; nothing more goes to the page.
    ended: AtomicBool,
}

unsafe impl Send for Inner {}
unsafe impl Sync for Inner {}

impl Inner {
    fn noticed_sound(&self) {
        if let Ok(mut at) = self.last_sound.lock() {
            *at = Instant::now();
        }
    }

    /// Close the audio and let the recognizer finish. `reason` is what the
    /// page hears if the recognizer does not deliver a final result in time.
    fn close(self: &Arc<Self>, reason: &str) {
        if self.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        unsafe {
            self.engine.stop();
            self.input.removeTapOnBus(0);
            self.request.endAudio();
        }
        let this = Arc::clone(self);
        let reason = reason.to_owned();
        thread::spawn(move || {
            thread::sleep(FINAL_RESULT_GRACE);
            if !this.ended.load(Ordering::SeqCst) {
                if let Ok(mut task) = this.task.lock() {
                    if let Some(task) = task.take() {
                        unsafe { task.cancel() };
                    }
                }
                this.end(&reason);
            }
        });
    }

    fn end(&self, reason: &str) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        self.closing.store(true, Ordering::SeqCst);
        (self.emit)(Event::end(reason));
    }
}

/// Managed state. Cloned into the thread a command runs on, so the command
/// itself never blocks the main thread: the permission dialogs need that
/// thread to appear, and a command waiting on them from it waited forever.
#[derive(Default, Clone)]
pub struct Dictation(Arc<Shared>);

#[derive(Default)]
struct Shared {
    session: Mutex<Option<Arc<Inner>>>,
    /// Counts starts. A stop records the start it is answering, so a start
    /// still waiting on a permission dialog learns it has been stopped.
    generation: AtomicU64,
    stopped_through: AtomicU64,
}

/// Asks, and waits for the answer, which can take as long as a person takes.
fn microphone_allowed() -> bool {
    let (tx, rx) = mpsc::channel();
    let handler = RcBlock::new(move |granted: Bool| {
        let _ = tx.send(granted.as_bool());
    });
    unsafe {
        let Some(audio) = AVMediaTypeAudio else { return false };
        AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler);
    }
    rx.recv_timeout(PERMISSION_WAIT).unwrap_or(false)
}

fn speech_allowed() -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let handler = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
        let _ = tx.send(status);
    });
    unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
    match rx.recv_timeout(PERMISSION_WAIT) {
        Ok(SFSpeechRecognizerAuthorizationStatus::Authorized) => Ok(()),
        Ok(SFSpeechRecognizerAuthorizationStatus::Denied) => Err(
            "Speech recognition was not allowed. Turn it on for Solution Builder in System Settings, Privacy & Security."
                .into(),
        ),
        Ok(SFSpeechRecognizerAuthorizationStatus::Restricted) => {
            Err("Speech recognition is restricted on this Mac.".into())
        }
        _ => Err("Speech recognition permission was not answered.".into()),
    }
}

fn rms(buffer: &AVAudioPCMBuffer) -> f32 {
    unsafe {
        let frames = buffer.frameLength() as usize;
        let channels = buffer.floatChannelData();
        if frames == 0 || channels.is_null() {
            return 0.0;
        }
        let first: NonNull<f32> = *channels;
        let samples = std::slice::from_raw_parts(first.as_ptr(), frames);
        (samples.iter().map(|s| s * s).sum::<f32>() / frames as f32).sqrt()
    }
}

pub struct Running(Arc<Inner>);

impl Running {
    pub fn stop(&self) {
        self.0.close("stopped");
    }
}

/// Opens the microphone and starts recognising, sending every event to
/// `emit`. Returns once the engine is running, or with the reason it could
/// not start.
pub fn start(emit: Emit) -> Result<Running, String> {
    match start_session(emit, || false)? {
        Some(inner) => Ok(Running(inner)),
        None => Err("stopped before it started".into()),
    }
}

/// `None` means a stop arrived while the permissions were being asked; the
/// end has been told and there is nothing to run.
fn start_session(emit: Emit, stopped: impl Fn() -> bool) -> Result<Option<Arc<Inner>>, String> {
    if !microphone_allowed() {
        return Err(
            "The microphone was not allowed. Turn it on for Solution Builder in System Settings, Privacy & Security."
                .into(),
        );
    }
    if stopped() {
        emit(Event::end("stopped"));
        return Ok(None);
    }
    speech_allowed()?;
    if stopped() {
        emit(Event::end("stopped"));
        return Ok(None);
    }

    let (recognizer, request, engine, input) = unsafe {
        let recognizer = SFSpeechRecognizer::new();
        if !recognizer.isAvailable() {
            return Err("The speech recognizer is not available right now.".into());
        }
        let request = SFSpeechAudioBufferRecognitionRequest::new();
        request.setShouldReportPartialResults(true);
        request.setAddsPunctuation(true);
        // Kept on this Mac when it can be; nothing leaves unless the system
        // has no local model for the language.
        request.setRequiresOnDeviceRecognition(recognizer.supportsOnDeviceRecognition());
        let engine = AVAudioEngine::new();
        let input = engine.inputNode();
        (recognizer, request, engine, input)
    };

    let inner = Arc::new(Inner {
        emit,
        engine,
        input,
        request,
        task: Mutex::new(None),
        _recognizer: recognizer,
        started: Instant::now(),
        last_sound: Mutex::new(Instant::now()),
        heard_speech: AtomicBool::new(false),
        closing: AtomicBool::new(false),
        ended: AtomicBool::new(false),
    });

    // Each buffer goes to the recognizer and, at most twenty times a second,
    // its level goes to the page.
    let tap_inner = Arc::clone(&inner);
    let last_level = Mutex::new(Instant::now() - LEVEL_INTERVAL);
    let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
        if tap_inner.closing.load(Ordering::SeqCst) {
            return;
        }
        let buffer = unsafe { buffer.as_ref() };
        unsafe { tap_inner.request.appendAudioPCMBuffer(buffer) };
        let level = rms(buffer);
        if level > SOUND_FLOOR {
            tap_inner.noticed_sound();
        }
        if let Ok(mut at) = last_level.lock() {
            if at.elapsed() >= LEVEL_INTERVAL {
                *at = Instant::now();
                (tap_inner.emit)(Event::Level { level: (level * 6.0).min(1.0) });
            }
        }
    });

    let result_inner = Arc::clone(&inner);
    let on_result = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
        if !result.is_null() {
            let (text, is_final) = unsafe {
                let result = &*result;
                (result.bestTranscription().formattedString().to_string(), result.isFinal())
            };
            if !text.is_empty() {
                result_inner.heard_speech.store(true, Ordering::SeqCst);
                result_inner.noticed_sound();
            }
            (result_inner.emit)(Event::Text { text, is_final });
            if is_final {
                result_inner.end("final");
            }
            return;
        }
        if !error.is_null() {
            // Cancelling our own task is reported as an error too; that end
            // has already been told.
            if result_inner.closing.load(Ordering::SeqCst) {
                result_inner.end("final");
                return;
            }
            let message = unsafe { (*error).localizedDescription().to_string() };
            result_inner.close("error");
            result_inner.end(&message);
        }
    });

    // The audio engine throws Objective-C exceptions rather than returning
    // errors, and one of those crossing into Rust aborts the process. Caught
    // here, they become the reason the page is shown.
    let started = objc2::exception::catch(std::panic::AssertUnwindSafe(|| unsafe {
        let format = inner.input.inputFormatForBus(0);
        let out = inner.input.outputFormatForBus(0);
        let shape = format!(
            "input {} ch at {} Hz, tap {} ch at {} Hz",
            format.channelCount(),
            format.sampleRate(),
            out.channelCount(),
            out.sampleRate()
        );
        if format.sampleRate() <= 0.0 || format.channelCount() == 0 {
            return Err("No microphone input is available to the app.".to_owned());
        }
        // The tap takes the bus's output format, as Apple's own sample does.
        inner.input.installTapOnBus_bufferSize_format_block(
            0,
            1024,
            Some(&out),
            &*tap as *const _ as *mut _,
        );
        inner.engine.prepare();
        inner.engine.startAndReturnError().map_err(|error| {
            format!(
                "The microphone could not be opened: {} ({shape})",
                error.localizedDescription()
            )
        })?;
        let task = inner
            ._recognizer
            .recognitionTaskWithRequest_resultHandler(&inner.request, &on_result);
        if let Ok(mut slot) = inner.task.lock() {
            *slot = Some(task);
        }
        Ok(())
    }));
    match started {
        Ok(Ok(())) => {}
        Ok(Err(reason)) => return Err(reason),
        Err(exception) => {
            let detail = exception
                .map(|e| e.to_string())
                .unwrap_or_else(|| "an unknown exception".to_owned());
            return Err(format!("The audio engine refused to start: {detail}"));
        }
    }

    // Silence ends it: a short pause once they have spoken, a longer one if
    // they never do.
    let watch = Arc::clone(&inner);
    thread::spawn(move || {
        while !watch.closing.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(100));
            let heard = watch.heard_speech.load(Ordering::SeqCst);
            let quiet = watch.last_sound.lock().map(|at| at.elapsed()).unwrap_or_default();
            if heard && quiet >= SILENCE_AFTER_SPEECH {
                watch.close("silence");
            } else if !heard && watch.started.elapsed() >= SILENCE_BEFORE_SPEECH {
                watch.close("silence");
            }
        }
    });

    Ok(Some(inner))
}

/// Opens the microphone and starts recognising. Returns once the engine is
/// running, or with the reason it could not start. Events follow. Runs on a
/// worker thread: the permission dialogs need the main thread free.
#[tauri::command]
pub async fn dictation_start(app: AppHandle, state: State<'_, Dictation>) -> Result<(), String> {
    let shared = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let generation = shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut slot) = shared.session.lock() {
            if let Some(previous) = slot.take() {
                previous.close("stopped");
            }
        }
        let emitter = app.clone();
        let emit: Emit = Box::new(move |event| {
            let _ = emitter.emit(EVENT, event);
        });
        let watch = Arc::clone(&shared);
        let session = start_session(emit, move || {
            watch.stopped_through.load(Ordering::SeqCst) >= generation
        })?;
        if let Some(session) = session {
            if let Ok(mut slot) = shared.session.lock() {
                *slot = Some(session);
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The person tapped the microphone again, or the composer went busy.
#[tauri::command]
pub async fn dictation_stop(state: State<'_, Dictation>) -> Result<(), String> {
    let shared = Arc::clone(&state.0);
    shared
        .stopped_through
        .store(shared.generation.load(Ordering::SeqCst), Ordering::SeqCst);
    if let Ok(mut slot) = shared.session.lock() {
        if let Some(session) = slot.take() {
            session.close("stopped");
        }
    }
    Ok(())
}

/// Opens the System Settings pane a `Help` named. Only the panes this file
/// knows are opened; the page cannot name an arbitrary URL.
#[tauri::command]
pub async fn dictation_open_settings(pane: String) -> Result<(), String> {
    let url = settings_url(&pane).ok_or_else(|| format!("No settings pane is known as {pane}."))?;
    let status = std::process::Command::new("open")
        .arg(url)
        .status()
        .map_err(|error| format!("System Settings could not be opened: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("System Settings could not be opened.".into())
    }
}
