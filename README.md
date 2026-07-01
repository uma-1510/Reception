# Voice Agent — AI Receptionist Prototype

A real-time, voice-driven AI receptionist ("Casey") for a fictional dental
practice, built in four stages: text chat → push-to-talk voice → continuous
real-time conversation with barge-in → production-polish (error handling,
call log, escalation detection). See `ARCHITECTURE.md` for how the pipeline
works and how it'd evolve for a real phone line.

## Setup

Requirements: Node 20+, an [Anthropic API key](https://console.anthropic.com/),
and **Chrome** (or another Chromium browser — Firefox/Safari don't support
the Web Speech API's `SpeechRecognition`).

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
npm run dev
```

Open http://localhost:3000, click **Start conversation**, allow the
microphone permission prompt, and talk. Click **📋 Call log** to review past
conversations and which tools were invoked.

**Use headphones for the voice demo.** With open speakers, the agent's own
voice can be picked back up by the mic and misread as an interruption — see
`ARCHITECTURE.md`'s barge-in section for why, and what a real production
stack does differently.

Text input works in every browser as a fallback/supplement to voice, and
doesn't require a microphone.

## What's real vs. mocked

**Real:**
- Actual Claude API calls (`claude-opus-4-8`) with real tool-calling and
  streaming — no canned responses.
- A real SQLite calendar (`better-sqlite3`) with genuine slot-collision
  prevention, reschedule/cancel logic, and seeded availability — booking the
  same slot twice actually fails.
- Real browser speech recognition and synthesis (Web Speech API) — not a
  simulated transcript.
- Conversation history, tool-call logs, and call summaries are persisted to
  SQLite and genuinely queryable (`app/calls`).
- The escalation detector (`lib/agent/escalation.ts`) runs real pattern
  matching against the actual transcript text and barge-in counts, not a
  canned demo trigger.

**Mocked / out of scope:**
- **The business itself.** "Riverside Family Dental" doesn't exist; the
  services, hours, and calendar are fictional demo data
  (`lib/agent/system-prompt.ts`, `lib/db/index.ts`'s seed function).
- **The phone line.** This is a browser tab simulating a call — there's no
  real phone number, PSTN, or telephony provider involved. See "Extending
  with Twilio" below for what that would take.
- **`transfer_to_human`.** It flags the call in the UI and DB
  (`transferred: true`, an on-screen banner, and a `transfer_to_human` row in
  `tool_call_log`) but doesn't ring an actual person or queue.
- **No CRM/insurance/payment integration.** Booking only captures name,
  phone, and service — no real patient records.
- **No SMS/email confirmations** after booking.
- **No auth on the call log** (`/calls`) — it shows real names and phone
  numbers from every call with zero access control. Fine for a local demo;
  do not deploy this as-is.

## Project structure

```
app/
  page.tsx                 Main call UI — state machine, live transcript, metrics panel
  error.tsx                Route-level error boundary (never blank-screens on a render error)
  api/chat/route.ts         Non-streaming turn endpoint (JSON in, JSON out)
  api/chat/stream/route.ts  Streaming turn endpoint (NDJSON) — what the UI actually uses
  calls/page.tsx            Call log list
  calls/[sessionId]/page.tsx  Call detail: transcript + tool calls
  api/calls/                Call log read endpoints

lib/
  agent/
    orchestrator.ts         The tool-calling loop (streaming + non-streaming variants)
    tools.ts                Tool schemas + executors (calendar operations)
    system-prompt.ts        Casey's persona and phone-conversation style rules
    escalation.ts           Frustration/distress signal detection
    errors.ts                Claude API error → safe reply mapping
    streamClient.ts          Browser-side NDJSON stream consumer
  audio/
    continuousRecognition.ts  Always-on STT wrapper (auto-restart, error mapping)
    endpointing.ts             Silence-timer + min-length turn-end detector
    speechSynthesis.ts         Sentence-chunked TTS queue (SpeechQueue)
    browserSupport.ts          Feature detection (Chrome-only STT, etc.)
  db/
    calendar.ts               Availability/booking/reschedule/cancel logic
    conversations.ts          Message persistence
    callLog.ts                Tool-call logging + call summaries (backs /calls)
    index.ts                  SQLite connection + schema + seed data
```

## Extending with Twilio for real phone calls

The orchestrator/tools/DB layer needs essentially no changes — it already
takes text in and produces text + tool calls out, independent of how the
audio got there. The parts that change:

1. **Telephony connection.** Point a Twilio phone number at a
   [Media Streams](https://www.twilio.com/docs/voice/media-streams) webhook
   (or use [Twilio ConversationRelay](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay),
   which is purpose-built for this exact "LLM + tools" pattern and handles
   more of the plumbing for you). Either way, a call opens a WebSocket
   carrying mu-law 8kHz audio frames in both directions instead of a browser
   tab.

2. **Replace Web Speech API with Deepgram.** Pipe the inbound Twilio audio
   frames to Deepgram's streaming STT over its own WebSocket. Deepgram's
   `speech_final`/`UtteranceEnd` events replace `lib/audio/endpointing.ts`'s
   silence-timer heuristic with real VAD — see `ARCHITECTURE.md` for the
   detailed mapping.

3. **Replace Web Speech Synthesis with ElevenLabs.** Stream `text_delta`
   events (the orchestrator already emits these) to ElevenLabs' streaming
   TTS endpoint instead of `SpeechQueue`, convert the returned audio to
   Twilio's mu-law format, and write it back to the Media Stream.

4. **Move the orchestrator server-side loop into the call's WebSocket
   handler** instead of an HTTP request/response — `runAgentTurnStream`'s
   `emit()` callback shape (text_delta / tool_call / tool_result / done)
   maps directly onto "send these bytes/events over the WebSocket" instead
   of "write NDJSON lines to an HTTP response."

5. **Make `transfer_to_human` real.** Instead of just flagging the UI, it
   would call Twilio's REST API (or a TwiML `<Dial>`) to actually redirect
   the live call to a human queue or number, and pass along the
   conversation summary.

6. **Persistence stays the same.** `lib/db` doesn't know or care whether the
   caller was a browser tab or a phone number — `session_id` just becomes
   the Twilio Call SID instead of a browser-generated UUID.

## Known limitations

- Voice input requires a Chromium browser (Chrome, Edge, Brave, Opera) — see
  `lib/audio/browserSupport.ts`. Text chat works everywhere.
- No echo cancellation for the continuous-listening + barge-in combination —
  use headphones (see above and `ARCHITECTURE.md`).
- SQLite (`better-sqlite3`) is a single-file, single-process database — fine
  for this demo, not for horizontally-scaled production traffic.
- The call log has no authentication (see above).
- Escalation detection is a deterministic pattern matcher feeding a soft
  prompt nudge, not a hard override — Claude still decides whether to
  actually call `transfer_to_human`. See `lib/agent/escalation.ts`.
