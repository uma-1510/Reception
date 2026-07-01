import { getSpeechRecognitionCtor, isSpeechRecognitionSupported } from "./browserSupport";

export type RecognitionErrorReason =
  | "not-allowed"
  | "no-speech"
  | "audio-capture"
  | "network"
  | "aborted"
  | "unsupported"
  | "other";

export interface ContinuousRecognizerHandlers {
  /** Fired on every interim/final result with the combined (finalized + interim) transcript for the current utterance. */
  onTranscriptUpdate: (text: string) => void;
  /** Permission denied, no mic, network drop, etc. Not fired for our own stop()/abort() calls. */
  onError?: (reason: RecognitionErrorReason, message: string) => void;
  onListeningChange?: (listening: boolean) => void;
}

function mapErrorReason(error: string): RecognitionErrorReason {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "not-allowed";
    case "no-speech":
      return "no-speech";
    case "audio-capture":
      return "audio-capture";
    case "network":
      return "network";
    case "aborted":
      return "aborted";
    default:
      return "other";
  }
}

export function describeRecognitionError(reason: RecognitionErrorReason): string {
  switch (reason) {
    case "not-allowed":
      return "Microphone access was denied. Enable it in your browser's site settings to use voice.";
    case "audio-capture":
      return "No microphone was found. Check your device and try again.";
    case "network":
      return "Speech recognition needs an internet connection.";
    case "no-speech":
      return "";
    case "unsupported":
      return "Voice input isn't supported in this browser. Try Chrome.";
    default:
      return "Something went wrong with voice input.";
  }
}

const RESTART_BACKOFF_MS = 250;

/**
 * Wraps SpeechRecognition in `continuous` mode for an always-on conversational
 * mic. Unlike push-to-talk, this is meant to run for the lifetime of a call:
 * it auto-restarts on unexpected `end` events (Chrome's continuous sessions
 * can time out on their own after long silence or ~60s) so listening never
 * silently stops. It does NOT decide when a user's turn is "done" — that's
 * the Endpointer's job, fed by onTranscriptUpdate.
 */
export class ContinuousRecognizer {
  private recognition: SpeechRecognition | null = null;
  private finalTranscript = "";
  private shouldRun = false;
  private lastLaunchAt = 0;
  private readonly handlers: ContinuousRecognizerHandlers;

  constructor(handlers: ContinuousRecognizerHandlers) {
    this.handlers = handlers;
  }

  static isSupported(): boolean {
    return isSpeechRecognitionSupported();
  }

  start(): void {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.launch();
  }

  /** Clears the accumulated transcript. Call this once a turn has been submitted, so the next utterance starts clean. */
  clearTranscript(): void {
    this.finalTranscript = "";
  }

  /**
   * Defensive resync: some browsers silently stop delivering audio to a
   * SpeechRecognition session when a tab is backgrounded, without firing
   * `end`. Call this (e.g. on `visibilitychange`) to relaunch if we think we
   * should be listening but the underlying session has gone quiet.
   */
  ensureRunning(): void {
    if (this.shouldRun && !this.recognition) {
      this.launch();
    }
  }

  /** Fully stops continuous listening — no auto-restart. Use on unmount or when the user ends the conversation. */
  stop(): void {
    this.shouldRun = false;
    this.finalTranscript = "";
    this.teardown();
  }

  private teardown(): void {
    if (!this.recognition) return;
    const r = this.recognition;
    this.recognition = null;
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    r.abort();
  }

  private scheduleRelaunch(): void {
    const elapsed = Date.now() - this.lastLaunchAt;
    const delay = Math.max(0, RESTART_BACKOFF_MS - elapsed);
    setTimeout(() => {
      if (this.shouldRun) this.launch();
    }, delay);
  }

  private launch(): void {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      this.handlers.onError?.("unsupported", describeRecognitionError("unsupported"));
      this.shouldRun = false;
      return;
    }

    this.lastLaunchAt = Date.now();

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          this.finalTranscript += transcript;
        } else {
          interim += transcript;
        }
      }
      this.handlers.onTranscriptUpdate((this.finalTranscript + interim).trim());
    };

    recognition.onerror = (event) => {
      const reason = mapErrorReason(event.error);
      // Intentional stop/abort — not a user-facing error.
      if (reason === "aborted") return;
      // Expected during natural pauses in continuous mode — the Endpointer, not this error, decides turn-end.
      if (reason === "no-speech") return;
      if (reason === "not-allowed" || reason === "audio-capture") {
        // Fatal — stop trying to auto-restart until the user re-enables voice mode.
        this.shouldRun = false;
      }
      this.handlers.onError?.(reason, describeRecognitionError(reason));
    };

    recognition.onend = () => {
      this.recognition = null;
      this.handlers.onListeningChange?.(false);
      if (this.shouldRun) {
        this.scheduleRelaunch();
      }
    };

    this.recognition = recognition;

    try {
      recognition.start();
      this.handlers.onListeningChange?.(true);
    } catch {
      this.recognition = null;
      this.handlers.onListeningChange?.(false);
      if (this.shouldRun) this.scheduleRelaunch();
    }
  }
}
