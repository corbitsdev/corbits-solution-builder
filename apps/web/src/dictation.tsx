/**
 * Dictation: speaking into a composer instead of typing into it.
 *
 * Built on the browser's speech recognition. In the desktop shell that is
 * Apple's recognizer behind WebKit, the same one the system dictation key
 * uses; in Chrome it is Chrome's. Where the API is absent the control is
 * absent too, and where it is present but refused, the refusal is said once
 * rather than left as a button that appears to work.
 *
 * Words land in the composer as they are recognised, so a person sees the
 * sentence form and can stop the moment it goes wrong. Whatever was already
 * typed stays; dictation appends to it.
 */
import { Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type RecognitionResult = ArrayLike<{ transcript: string }> & { isFinal: boolean };
type RecognitionEvent = { results: ArrayLike<RecognitionResult> };
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognizer(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** Why it stopped, in words a person can act on. Anything else is shown as is. */
const REFUSALS: Record<string, string> = {
  "not-allowed": "Dictation was not allowed. Microphone and speech recognition permission are needed.",
  "service-not-allowed": "Speech recognition is not available on this system.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition could not reach its service.",
};

export function useDictation(value: string, onValueChange: (value: string) => void) {
  const [listening, setListening] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const active = useRef<Recognition | null>(null);
  // What was in the composer when dictation began; every result is appended
  // to it, so an interim phrase is replaced by its final form, not doubled.
  const base = useRef("");
  const current = useRef(value);
  current.current = value;
  const change = useRef(onValueChange);
  change.current = onValueChange;

  const stop = useCallback(() => active.current?.stop(), []);
  const start = useCallback(() => {
    const Recognizer = recognizer();
    if (!Recognizer || active.current) return;
    const recognition = new Recognizer();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    const typed = current.current.trimEnd();
    base.current = typed.length > 0 ? `${typed} ` : "";
    recognition.onresult = (event) => {
      const heard: string[] = [];
      for (let at = 0; at < event.results.length; at++) {
        const text = event.results[at]?.[0]?.transcript.trim();
        if (text) heard.push(text);
      }
      change.current(base.current + heard.join(" "));
    };
    recognition.onerror = (event) => {
      // Silence is not a failure, and stopping it ourselves is not one either.
      if (event.error === "no-speech" || event.error === "aborted") return;
      setRefusal(REFUSALS[event.error] ?? `Dictation stopped: ${event.error}.`);
    };
    recognition.onend = () => {
      active.current = null;
      setListening(false);
    };
    active.current = recognition;
    setRefusal(null);
    setListening(true);
    try {
      recognition.start();
    } catch {
      active.current = null;
      setListening(false);
    }
  }, []);

  // Leaving the screen mid-sentence must not leave the microphone open.
  useEffect(() => () => active.current?.abort(), []);

  return { supported: recognizer() !== null, listening, refusal, start, stop };
}

/**
 * The microphone control for a composer. Renders nothing where the browser
 * has no speech recognition: a control that does not exist is absent.
 */
export function DictationButton({
  value,
  onValueChange,
  disabled = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** The composer is busy; dictation into it would be lost. */
  disabled?: boolean;
}) {
  const { supported, listening, refusal, start, stop } = useDictation(value, onValueChange);
  useEffect(() => {
    if (disabled && listening) stop();
  }, [disabled, listening, stop]);
  if (!supported) return null;
  return (
    <span className="dictation">
      <button
        type="button"
        className="dictate"
        aria-pressed={listening}
        aria-label={listening ? "Stop dictating" : "Dictate"}
        title={listening ? "Stop dictating" : "Dictate instead of typing"}
        disabled={disabled}
        onClick={listening ? stop : start}
      >
        {listening ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
      </button>
      {listening ? (
        <span className="dictation-state" aria-live="polite">
          Listening…
        </span>
      ) : refusal ? (
        <span className="dictation-state" role="alert">
          {refusal}
        </span>
      ) : null}
    </span>
  );
}
