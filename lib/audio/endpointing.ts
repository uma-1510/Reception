export interface EndpointerOptions {
  /** How long to wait after the last recognition update before treating the turn as finished. */
  silenceMs?: number;
  /** Minimum trimmed transcript length (characters) to accept as a real utterance — filters noise blips ("uh", a cough, a stray word) that shouldn't end the turn. */
  minChars?: number;
  onTurnEnd: (finalText: string) => void;
}

/**
 * Decides when the user has finished talking. Deliberately does NOT rely on
 * the browser's own `isFinal` flag (Chrome's built-in endpointing is eager
 * and inconsistent across versions/platforms) — instead it watches the
 * *recency* of recognition activity as a proxy for acoustic silence: every
 * update() call (interim or final) rearms a silence timer, and only once
 * that timer elapses AND the buffered transcript clears the minimum length
 * does it fire onTurnEnd. A short blip that trails off gets silently
 * discarded rather than submitted as a turn.
 */
export class Endpointer {
  private readonly silenceMs: number;
  private readonly minChars: number;
  private readonly onTurnEnd: (text: string) => void;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private latestText = "";

  constructor(options: EndpointerOptions) {
    this.silenceMs = options.silenceMs ?? 900;
    this.minChars = options.minChars ?? 2;
    this.onTurnEnd = options.onTurnEnd;
  }

  /** Feed every recognition update (interim or final) here. Rearms the silence timer. */
  update(text: string): void {
    this.latestText = text;
    this.clearTimer();
    this.silenceTimer = setTimeout(() => this.maybeEnd(), this.silenceMs);
  }

  private maybeEnd(): void {
    this.clearTimer();
    const text = this.latestText.trim();
    if (text.length >= this.minChars) {
      this.latestText = "";
      this.onTurnEnd(text);
    }
    // Otherwise: too short to be a real utterance (noise/breath) — stay quiet.
    // The buffer is left as-is; the next update() call will pick up any
    // further speech and re-run the same threshold check.
  }

  private clearTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /** Call when a turn has been submitted (normally or via barge-in) so the next utterance starts from a clean slate. */
  reset(): void {
    this.clearTimer();
    this.latestText = "";
  }
}
