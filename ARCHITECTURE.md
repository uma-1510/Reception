# Architecture

This document explains how the voice agent pipeline fits together, where time
goes on a typical turn, and what would change if this moved from a browser
prototype to a real phone line backed by paid streaming STT/TTS.

## Pipeline overview

Everything runs in two places: the browser tab (audio I/O only) and the
Next.js server (everything that talks to Claude, the calendar, and the DB).
No audio ever leaves the browser as audio — it's converted to text by the
browser's own STT before anything goes over the network, and the reply comes
back as text that's converted to speech locally too.

```
 ┌─────────────────────────── BROWSER ───────────────────────────┐
 │                                                                 │
 │   Mic ──▶ ContinuousRecognizer ──▶ Endpointer ──▶ submitTurn() │
 │           (Web Speech API STT,        (silence timer +         │
 │            continuous=true,            min-length gate)        │
 │            auto-restart)                     │                 │
 │                │                              │                 │
 │                │ every result event           ▼                 │
 │                │ (barge-in check)      POST /api/chat/stream    │
 │                │                        { message, sessionId,   │
 │                ▼                          consecutiveBargeIns } │
 │           bargeIn() ──────────────────────────┐                 │
 │           (cancels TTS + aborts fetch)         │                 │
 │                ▲                               │ NDJSON stream   │
 │                │                               ▼                 │
 │   Speakers ◀── SpeechQueue ◀── flushSentences() ◀── text_delta   │
 │   (Web Speech      (native utterance    (regex sentence          │
 │    Synthesis        queue, first-audio    splitter)              │
 │    API TTS)          timing)                                     │
 └─────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP (same-origin)
                                    ▼
 ┌─────────────────────────── SERVER ────────────────────────────┐
 │                                                                 │
 │  app/api/chat/stream/route.ts                                  │
 │       │                                                         │
 │       ▼                                                         │
 │  runAgentTurnStream()  (lib/agent/orchestrator.ts)              │
 │       │                                                         │
 │       ├─ detectFrustrationSignals() ──▶ ephemeral system nudge  │
 │       │        (lib/agent/escalation.ts)   (not persisted)      │
 │       │                                                         │
 │       ├─ client.messages.stream()  (claude-opus-4-8, tools,     │
 │       │        │                    effort: low, streamed)      │
 │       │        └─ stream.on("text") ──▶ emit text_delta         │
 │       │                                                         │
 │       ├─ tool_use? ──▶ executeTool() (lib/agent/tools.ts)       │
 │       │        │         │                                      │
 │       │        │         └─ SQLite calendar (lib/db/calendar.ts)│
 │       │        └─ logToolCall() ──▶ tool_call_log table         │
 │       │                                                         │
 │       └─ done ──▶ emit {reply, transferred}                     │
 │                                                                  │
 │  All messages + tool calls persisted to SQLite                  │
 │  (conversation_messages, tool_call_log) — feeds the call log UI │
 └──────────────────────────────────────────────────────────────────┘
```

The same orchestrator loop backs a non-streaming variant (`runAgentTurn`,
used by `POST /api/chat`) for programmatic/non-UI callers — it's the same
tool loop and DB persistence, just without the incremental events.

## Latency budget per stage

These are the components that stack up between "user stops talking" and
"user hears the first word of the reply," with realistic ranges for this
browser-based implementation:

| Stage | Typical latency | Notes |
|---|---|---|
| Endpointing silence wait | **900 ms fixed** | The single biggest *fixed* cost — see below on why it's fixed and how it'd change with real VAD. |
| Network to `/api/chat/stream` | 5–30 ms | Same-origin, local dev; would be real WAN latency in production. |
| Claude time-to-first-token | 300 ms – 2 s+ | Dominant *variable* cost. Depends on whether the first turn needs a tool call (check_availability, etc.) before any text streams — a turn that opens with "Let me check that for you" streams fast; a turn that goes straight into a tool call and waits for the DB before speaking can take longer. `effort: "low"` is set specifically to keep this down for a receptionist-style turn. |
| Sentence boundary detection | ~0 ms | Client-side regex on each token as it arrives — negligible. |
| TTS engine startup (`utterance.onstart`) | 50–200 ms | Browser-dependent; Chrome's local voices start fast, some network-backed voices are slower. |
| **Total, typical** | **~1.3–3.5 s** | From last word spoken to first word heard back. |

The metrics panel in the UI reports the two numbers that matter most —
**TTFT** (request sent → first `text_delta`) and **TTFA** (request sent →
first `utterance.onstart`) — measured client-side with `performance.now()`,
per turn, so you can see this budget in practice rather than take it on
faith.

### Why the endpointing wait is fixed, and what that costs

900ms is a deliberate tradeoff, not a limitation we didn't notice: shorter
would clip callers who pause mid-sentence to think; longer would make the
agent feel slow to respond after a clearly-finished sentence. It's a single
global constant (`SILENCE_MS` in `app/page.tsx`) rather than adaptive,
because the Web Speech API gives us no acoustic signal to adapt against —
see below.

## Endpointing approach

`lib/audio/endpointing.ts` implements turn-taking with two rules:

1. **Silence timer**: every recognition update (interim *or* final) rearms a
   timer. Only once `SILENCE_MS` (900ms) passes with no new update does the
   turn end.
2. **Minimum length gate**: when the timer fires, the buffered transcript
   must be at least `MIN_UTTERANCE_CHARS` (2) characters, or it's discarded
   as noise (a cough, a stray "um") and the turn stays open.

This is deliberately **not** true acoustic voice-activity detection (VAD).
The Web Speech API exposes no raw audio energy — only recognition results —
so "silence" here really means "time since the last recognition event,"
which is a reasonable proxy (Chrome's recognizer only emits new results
while it hears something) but not the real thing. It also deliberately does
**not** trust the browser's own `isFinal` flag as the turn-end signal:
Chrome's internal endpointing is eager and inconsistent across versions, so
we treat every result (interim or final) as just "more transcript," and let
our own silence timer be the sole authority on when the user is actually
done. See the "Evolving to Deepgram" section for what a proper VAD signal
would look like.

## How barge-in is detected

`ContinuousRecognizer` runs in `continuous: true` mode for the entire call —
including while the agent is speaking — because barge-in has no other signal
to work from. `app/page.tsx`'s `onTranscriptUpdate` handler checks, on
*every* recognition event, whether `agentState` is `"thinking"` or
`"speaking"`; if so, it calls `bargeIn()`, which:

1. Cancels the `SpeechQueue` (`window.speechSynthesis.cancel()` — no
   waiting for the current utterance to finish a sentence).
2. Aborts the in-flight fetch to `/api/chat/stream` via `AbortController`
   (so Claude's generation doesn't keep running for a response nobody will
   hear).
3. Drops the agent state back to `"listening"`.

The recognizer keeps accumulating the interrupting speech from that same
moment; once *it* pauses long enough, the normal endpointing path fires and
submits it as a new turn. Barge-in doesn't submit a fragment immediately —
it just clears the way and lets the standard turn-end logic take over, so a
caller who interrupts mid-word to say something different gets their full
new sentence sent, not a truncated one.

**Known limitation — self-triggered barge-in over speakers.** Because the
mic stays live while the agent talks, playing the agent's TTS output through
open speakers can get picked back up by the mic and misread as the user
interrupting. There's no acoustic echo cancellation in this pipeline — the
Web Speech API gives no control over it. Two mitigations are in place: a
500ms grace period after submitting a turn (`BARGE_IN_GRACE_MS`) that
ignores trailing recognition events from the utterance just submitted, and
an on-screen tip recommending headphones. Neither is a real fix — a
production stack solves this properly (see below).

## Evolving to a paid streaming STT/TTS stack (Deepgram + ElevenLabs)

The orchestrator (`lib/agent/orchestrator.ts`), tools (`lib/agent/tools.ts`),
system prompt, and SQLite layer are already transport-agnostic — none of
them know or care that today's audio is browser-based. That's the part of
this stack that *doesn't* change. What does:

### STT: Web Speech API → Deepgram streaming

- **Cross-browser and telephony-ready.** Web Speech API's `SpeechRecognition`
  is a Chromium-only, browser-only feature — a real phone call has no
  browser at all. Deepgram's streaming API takes raw audio frames over a
  WebSocket from anywhere: a browser tab, a Twilio Media Stream, a mobile SDK.
- **Real endpointing.** Deepgram's streaming API emits `speech_final` and
  `UtteranceEnd` events computed from actual acoustic VAD, word timing, and
  confidence — replacing our recognition-event-recency proxy with the real
  signal it was standing in for. `SILENCE_MS` becomes a Deepgram
  `endpointing` / `utterance_end_ms` config value tuned server-side, and
  `MIN_UTTERANCE_CHARS` becomes a confidence threshold instead of a raw
  character count.
- **Lower interim latency**, word-level timestamps, and optional speaker
  diarization if the call ever needs to distinguish multiple speakers.

### TTS: Web Speech Synthesis → ElevenLabs streaming

- **True audio streaming, not sentence chunking.** Our `flushSentences()`
  waits for a complete sentence before speaking because that's the coarsest
  unit the browser's TTS can start on. ElevenLabs' streaming endpoint (or
  WebSocket API) returns audio *bytes* as they're generated — text can be
  piped to it in much smaller chunks (even mid-sentence), cutting
  time-to-first-audio further below what sentence-level chunking allows.
- **Real barge-in via stream cancellation.** Instead of
  `speechSynthesis.cancel()`, barge-in becomes closing the ElevenLabs audio
  stream / stopping playback of the buffered PCM — same idea, cleaner
  mechanism, no dependence on a browser API's queue semantics.
- **Voice quality and consistency** — a persistent, brand-appropriate voice
  instead of whatever the OS/browser happens to ship.

### Where audio processing moves

Today, STT and TTS both run **in the browser**; only the LLM + tools are
server-side. A real phone integration (see README.md's Twilio section) has
no browser, so **all** audio processing moves server-side too: a persistent
WebSocket per call carries audio frames in from the telephony provider,
through Deepgram, into the same `runAgentTurnStream`-shaped orchestrator
loop, out through ElevenLabs, and back to the caller. Telephony audio
streams are inherently full-duplex — the provider delivers caller audio
continuously regardless of whether the server is currently sending audio
back — which is the server-side equivalent of what "continuous recognition
while speaking" gives us here, but without the speaker-into-mic feedback
problem, since it's carried over the PSTN/carrier path rather than open air.

### Realistic target numbers with that stack

| Metric | This build (browser Web Speech) | Deepgram + ElevenLabs target |
|---|---|---|
| Endpointing | 900ms fixed wait | 200–500ms, adaptive (real VAD + confidence) |
| STT interim latency | Browser-dependent, ~100–300ms | Sub-300ms, consistently |
| TTFA (first audio out) | ~1.3–3.5s (see budget table) | Sub-800ms achievable, mostly bounded by Claude's own TTFT |

The Claude TTFT term doesn't go away with a better audio stack — it's
already the dominant cost here and would remain so. The audio-stack upgrade
mainly attacks the *fixed* 900ms endpointing tax and the sentence-chunking
tax on TTS start, not the model's own thinking time.
