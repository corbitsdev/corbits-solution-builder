/**
 * Dictation: speaking into a composer instead of typing into it.
 *
 * Two backends behind one hook. In the desktop shell the shell owns the
 * microphone: Apple's recognizer runs in the app process and the page hears
 * levels, partial transcripts and the end as `dictation` events. That is the
 * product path. In a plain browser, for `bun run dev`, the browser's own
 * speech recognition stands in, with the microphone read alongside it for the
 * level. Where neither exists the control is absent.
 *
 * Words land in the composer as they are recognised, appended to whatever
 * was typed. The microphone goes green while it is open and a waveform
 * follows the input, because a live microphone must never be ambiguous. A
 * tap on the microphone ends it, and so does a short silence once something
 * has been said.
 */
import { Mic } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** How many recent levels the waveform shows. */
const WAVE_BARS = 24;
/** Silence after speech that ends a browser session; the shell keeps its own. */
const SILENCE_AFTER_SPEECH_MS = 1500;
const SOUND_FLOOR = 0.015;

type DictationEvent =
  | { kind: "level"; level: number }
  | { kind: "text"; text: string; final: boolean }
  | { kind: "end"; reason: string };

/** Why it stopped, in words a person can act on. Anything else is shown as is. */
const REFUSALS: Record<string, string> = {
  "not-allowed": "Dictation was not allowed. Microphone and speech recognition permission are needed.",
  "service-not-allowed": "Speech recognition is not available on this system.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition could not reach its service.",
};
/** Ends that are not failures. */
const QUIET_ENDS = new Set(["stopped", "silence", "final"]);

const inShell = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
};
function browserRecognizer(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** A running session, whichever backend: one way to stop it. */
type Session = { stop: () => void; abort: () => void };

export function useDictation(value: string, onValueChange: (value: string) => void) {
  const [listening, setListening] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(() => Array(WAVE_BARS).fill(0));
  const session = useRef<Session | null>(null);
  const current = useRef(value);
  current.current = value;
  const change = useRef(onValueChange);
  change.current = onValueChange;

  const supported = inShell() || browserRecognizer() !== null;

  const pushLevel = useCallback((level: number) => {
    setLevels((history) => [...history.slice(1), Math.max(0, Math.min(1, level))]);
  }, []);

  const finish = useCallback((reason: string) => {
    session.current = null;
    setListening(false);
    setLevels(Array(WAVE_BARS).fill(0));
    if (!QUIET_ENDS.has(reason)) setRefusal(reason);
  }, []);

  const start = useCallback(async () => {
    if (session.current) return;
    const typed = current.current.trimEnd();
    const base = typed.length > 0 ? `${typed} ` : "";
    setRefusal(null);
    setListening(true);

    if (inShell()) {
      let over = false;
      const unlisten = await listen<DictationEvent>("dictation", ({ payload }) => {
        if (over) return;
        if (payload.kind === "level") pushLevel(payload.level);
        else if (payload.kind === "text") change.current(base + payload.text);
        else {
          over = true;
          unlisten();
          finish(payload.reason);
        }
      });
      session.current = {
        stop: () => void invoke("dictation_stop"),
        abort: () => {
          over = true;
          unlisten();
          void invoke("dictation_stop");
        },
      };
      try {
        await invoke("dictation_start");
      } catch (cause) {
        over = true;
        unlisten();
        finish(String(cause));
      }
      return;
    }

    const Recognizer = browserRecognizer();
    if (!Recognizer) {
      finish("Speech recognition is not available in this browser.");
      return;
    }
    const recognition = new Recognizer();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    let heardSpeech = false;
    let lastSound = performance.now();
    let ended: string | null = null;
    let stoppedByUs = false;

    // The level, read from the microphone beside the recognizer. A browser
    // without it still dictates; it just has no waveform to show.
    let meter: { stream: MediaStream; context: AudioContext; timer: number } | null = null;
    const closeMeter = () => {
      if (!meter) return;
      clearInterval(meter.timer);
      meter.stream.getTracks().forEach((track) => track.stop());
      void meter.context.close();
      meter = null;
    };
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const timer = window.setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          const rms = Math.sqrt(sum / samples.length);
          pushLevel(rms * 6);
          if (rms > SOUND_FLOOR) lastSound = performance.now();
          else if (heardSpeech && performance.now() - lastSound > SILENCE_AFTER_SPEECH_MS) {
            stoppedByUs = true;
            recognition.stop();
          }
        }, 50);
        meter = { stream, context, timer };
      } catch {
        meter = null;
      }
    }

    recognition.onresult = (event) => {
      const heard: string[] = [];
      for (let at = 0; at < event.results.length; at++) {
        const text = event.results[at]?.[0]?.transcript.trim();
        if (text) heard.push(text);
      }
      if (heard.length > 0) {
        heardSpeech = true;
        lastSound = performance.now();
      }
      change.current(base + heard.join(" "));
    };
    recognition.onerror = (event) => {
      if (event.error === "aborted" || event.error === "no-speech") return;
      ended = REFUSALS[event.error] ?? `Dictation stopped: ${event.error}${event.message ? ` (${event.message})` : ""}.`;
    };
    recognition.onend = () => {
      closeMeter();
      finish(ended ?? (heardSpeech || stoppedByUs ? "final" : "Dictation ended before anything was heard."));
    };
    session.current = {
      stop: () => {
        stoppedByUs = true;
        recognition.stop();
      },
      abort: () => {
        closeMeter();
        recognition.abort();
      },
    };
    try {
      recognition.start();
    } catch (cause) {
      closeMeter();
      finish(String(cause));
    }
  }, [finish, pushLevel]);

  const stop = useCallback(() => session.current?.stop(), []);

  // Leaving the screen mid-sentence must not leave the microphone open.
  useEffect(() => () => session.current?.abort(), []);

  return { supported, listening, levels, refusal, start, stop };
}

/**
 * A composer with a microphone beside it, on the left, level with the send
 * button. Where there is no way to dictate the composer is rendered alone: a
 * control that does not exist is absent.
 *
 * While listening the microphone is green and a line under the composer says
 * "Listening:" with a waveform of the input beside it. A refusal takes the
 * same line. Otherwise the line is absent, so the row never changes shape.
 */
export function Dictated({
  value,
  onValueChange,
  disabled = false,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** The composer is busy; dictation into it would be lost. */
  disabled?: boolean;
  children: ReactNode;
}) {
  const { supported, listening, levels, refusal, start, stop } = useDictation(value, onValueChange);
  useEffect(() => {
    if (disabled && listening) stop();
  }, [disabled, listening, stop]);
  if (!supported) return <>{children}</>;
  return (
    <div className="dictated">
      <div className="dictated-row">
        <button
          type="button"
          className="dictate"
          aria-pressed={listening}
          aria-label={listening ? "Stop dictating" : "Dictate"}
          title={listening ? "Stop dictating" : "Dictate instead of typing"}
          disabled={disabled}
          onClick={listening ? stop : () => void start()}
        >
          <Mic aria-hidden="true" />
        </button>
        {children}
      </div>
      {listening ? (
        <p className="dictation-state" aria-live="polite">
          <span>Listening:</span>
          <span className="waveform" aria-hidden="true">
            {levels.map((level, at) => (
              <i key={at} style={{ transform: `scaleY(${Math.max(0.08, level)})` }} />
            ))}
          </span>
        </p>
      ) : refusal ? (
        <p className="dictation-state" role="alert">
          {refusal}
        </p>
      ) : null}
    </div>
  );
}
