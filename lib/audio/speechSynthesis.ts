import { isSpeechSynthesisSupported } from "./browserSupport";

export { isSpeechSynthesisSupported };

export function stopSpeaking(): void {
  if (isSpeechSynthesisSupported()) {
    window.speechSynthesis.cancel();
  }
}

export interface SpeechQueueHandlers {
  /** Fired once per turn, the first time any queued utterance actually starts playing — used for time-to-first-audio. Rearm with resetTurn(). */
  onFirstAudioStart?: () => void;
  /** True the instant the first queued utterance starts; false once the whole queue has drained. */
  onSpeakingChange?: (speaking: boolean) => void;
  onError?: (message: string) => void;
}

/**
 * Sentence-chunked TTS: enqueue() is called once per complete sentence as it
 * streams in, rather than waiting for the full reply. The browser's
 * SpeechSynthesis already queues utterances FIFO when speak() is called
 * while one is in progress, so this class just wraps that with turn-level
 * bookkeeping (first-audio timing, an aggregate "is anything queued/playing"
 * flag) and a cancelAll() for barge-in.
 */
export class SpeechQueue {
  private pending = 0;
  private firstAudioFired = false;
  private readonly handlers: SpeechQueueHandlers;

  constructor(handlers: SpeechQueueHandlers = {}) {
    this.handlers = handlers;
  }

  /** Call at the start of each new agent turn, before the first enqueue(), so onFirstAudioStart fires again for this turn. */
  resetTurn(): void {
    this.firstAudioFired = false;
  }

  get isSpeaking(): boolean {
    return this.pending > 0;
  }

  enqueue(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !isSpeechSynthesisSupported()) return;

    this.pending += 1;
    if (this.pending === 1) this.handlers.onSpeakingChange?.(true);

    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.lang = "en-US";
    utterance.rate = 1;

    utterance.onstart = () => {
      if (!this.firstAudioFired) {
        this.firstAudioFired = true;
        this.handlers.onFirstAudioStart?.();
      }
    };
    utterance.onend = () => this.settle();
    utterance.onerror = (event) => {
      // "canceled"/"interrupted" happen whenever cancelAll() cuts this off — expected, not an error.
      if (event.error !== "canceled" && event.error !== "interrupted") {
        this.handlers.onError?.("Couldn't play the spoken response.");
      }
      this.settle();
    };

    window.speechSynthesis.speak(utterance);
  }

  private settle(): void {
    this.pending = Math.max(0, this.pending - 1);
    if (this.pending === 0) this.handlers.onSpeakingChange?.(false);
  }

  /** Barge-in: stop whatever is playing and drop everything still queued. */
  cancelAll(): void {
    const wasSpeaking = this.pending > 0;
    this.pending = 0;
    stopSpeaking();
    if (wasSpeaking) this.handlers.onSpeakingChange?.(false);
  }
}
