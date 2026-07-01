"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { isChromiumBrowser, isSpeechRecognitionSupported } from "@/lib/audio/browserSupport";
import { ContinuousRecognizer, type RecognitionErrorReason } from "@/lib/audio/continuousRecognition";
import { Endpointer } from "@/lib/audio/endpointing";
import { SpeechQueue } from "@/lib/audio/speechSynthesis";
import { streamAgentTurn } from "@/lib/agent/streamClient";

type AgentState = "idle" | "listening" | "thinking" | "speaking";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

interface TurnMetric {
  ttft: number | null;
  ttfa: number | null;
}

// Endpointing: how long to wait after the last recognition update before
// treating the turn as finished, and the minimum transcript length to accept
// (filters noise blips like a cough or a stray "um").
const SILENCE_MS = 900;
const MIN_UTTERANCE_CHARS = 2;

// Grace window after we submit a turn during which we ignore recognition
// events for barge-in purposes — the browser's own trailing finalization of
// the utterance we JUST submitted can arrive a beat late, and without this
// it reads as the user interrupting their own turn.
const BARGE_IN_GRACE_MS = 500;

const MAX_METRICS_SHOWN = 5;

// Rough sentence-boundary heuristic: terminal punctuation, optional closing
// quote/paren, then whitespace. Good enough for short conversational replies
// — not a full NLP sentence splitter (abbreviations/decimals can trip it).
const SENTENCE_END_RE = /[.!?]+[\s"')\]]*\s/;

function newSessionId(): string {
  // crypto.randomUUID requires a secure context; this app is always served
  // over localhost/HTTPS, but fall back defensively rather than throw.
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const STATE_LABEL: Record<AgentState, string> = {
  idle: "Not connected",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const STATE_COLOR: Record<AgentState, string> = {
  idle: "#9aa0ab",
  listening: "#16a34a",
  thinking: "#d97706",
  speaking: "#2563eb",
};

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  return `${Math.round(ms)} ms`;
}

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [liveUserTranscript, setLiveUserTranscript] = useState("");
  const [liveAgentText, setLiveAgentText] = useState("");
  const [transferred, setTransferred] = useState(false);
  const [escalationReasons, setEscalationReasons] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sttSupported, setSttSupported] = useState(false);
  const [isChromium, setIsChromium] = useState(false);
  const [metrics, setMetrics] = useState<TurnMetric[]>([]);
  const [input, setInput] = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);

  const sessionIdRef = useRef<string | null>(null);
  const agentStateRef = useRef<AgentState>("idle");
  const streamDoneRef = useRef(true);
  const turnStartRef = useRef(0);
  const turnSubmittedAtRef = useRef(0);
  const ttftRecordedRef = useRef(false);
  const sentenceBufferRef = useRef("");
  const abortControllerRef = useRef<AbortController | null>(null);
  /** Cumulative interruption count for the current call — fed to the server as an escalation signal. */
  const bargeInCountRef = useRef(0);

  const recognizerRef = useRef<ContinuousRecognizer | null>(null);
  const endpointerRef = useRef<Endpointer | null>(null);
  const speechQueueRef = useRef<SpeechQueue | null>(null);

  useEffect(() => {
    agentStateRef.current = agentState;
  }, [agentState]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, liveUserTranscript, liveAgentText, agentState]);

  const updateLatestMetric = useCallback((patch: Partial<TurnMetric>) => {
    setMetrics((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], ...patch };
      return next;
    });
  }, []);

  /** Only return to "listening" once both the Claude stream AND the TTS queue have finished. */
  const syncStateAfterAsync = useCallback(() => {
    if (streamDoneRef.current && !speechQueueRef.current?.isSpeaking) {
      setAgentState("listening");
    }
  }, []);

  const flushSentences = useCallback((newText: string, isFinal = false) => {
    sentenceBufferRef.current += newText;
    let buffer = sentenceBufferRef.current;

    let match: RegExpExecArray | null;
    while ((match = SENTENCE_END_RE.exec(buffer))) {
      const cutIndex = match.index + match[0].length;
      const sentence = buffer.slice(0, cutIndex).trim();
      buffer = buffer.slice(cutIndex);
      if (sentence) speechQueueRef.current?.enqueue(sentence);
    }

    if (isFinal && buffer.trim()) {
      speechQueueRef.current?.enqueue(buffer.trim());
      buffer = "";
    }

    sentenceBufferRef.current = buffer;
  }, []);

  const runTurn = useCallback(
    async (text: string) => {
      setAgentState("thinking");
      setError(null);
      setEscalationReasons(null);
      setLiveAgentText("");
      sentenceBufferRef.current = "";
      ttftRecordedRef.current = false;
      streamDoneRef.current = false;
      speechQueueRef.current?.resetTurn();
      turnStartRef.current = performance.now();

      setMetrics((prev) => [...prev.slice(-(MAX_METRICS_SHOWN - 1)), { ttft: null, ttfa: null }]);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        await streamAgentTurn({
          sessionId: sessionIdRef.current!,
          message: text,
          consecutiveBargeIns: bargeInCountRef.current,
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "escalation_detected") {
              setEscalationReasons(event.reasons ?? []);
            } else if (event.type === "text_delta" && event.text) {
              if (!ttftRecordedRef.current) {
                ttftRecordedRef.current = true;
                updateLatestMetric({ ttft: performance.now() - turnStartRef.current });
              }
              setLiveAgentText((prev) => prev + event.text);
              flushSentences(event.text);
            } else if (event.type === "done") {
              flushSentences("", true);
              const finalReply = (event.reply ?? "").trim();
              if (finalReply) {
                setMessages((prev) => [...prev, { role: "assistant", text: finalReply }]);
              }
              setLiveAgentText("");
              if (event.transferred) setTransferred(true);
              streamDoneRef.current = true;
              syncStateAfterAsync();
            } else if (event.type === "error") {
              setError(event.message ?? "Something went wrong.");
              streamDoneRef.current = true;
              syncStateAfterAsync();
            }
          },
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Intentional barge-in cancellation — not a user-facing error.
        } else {
          setError(err instanceof Error ? err.message : "Something went wrong.");
        }
        streamDoneRef.current = true;
        syncStateAfterAsync();
      }
    },
    [flushSentences, syncStateAfterAsync, updateLatestMetric]
  );

  const submitTurn = useCallback(
    (text: string) => {
      recognizerRef.current?.clearTranscript();
      endpointerRef.current?.reset();
      turnSubmittedAtRef.current = Date.now();
      setLiveUserTranscript("");
      setMessages((prev) => [...prev, { role: "user", text }]);
      void runTurn(text);
    },
    [runTurn]
  );

  /** Barge-in: cancel whatever the agent is doing (mid-generation or mid-speech) and drop back to listening. */
  const bargeIn = useCallback(() => {
    bargeInCountRef.current += 1;
    speechQueueRef.current?.cancelAll();
    abortControllerRef.current?.abort();
    streamDoneRef.current = true;
    setLiveAgentText("");
    setAgentState("listening");
  }, []);

  const handleManualSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !sessionIdRef.current) return;
      if (agentStateRef.current === "thinking" || agentStateRef.current === "speaking") {
        bargeIn();
      }
      submitTurn(trimmed);
    },
    [bargeIn, submitTurn]
  );

  /** Full teardown — stop listening, cancel speech, abort in flight, reset transient UI state. Shared by "End conversation" and fatal recognition errors (denied mic, unsupported browser). */
  const stopEverything = useCallback(() => {
    recognizerRef.current?.stop();
    speechQueueRef.current?.cancelAll();
    abortControllerRef.current?.abort();
    endpointerRef.current?.reset();
    streamDoneRef.current = true;
    setLiveUserTranscript("");
    setLiveAgentText("");
    setAgentState("idle");
  }, []);

  useEffect(() => {
    setSttSupported(isSpeechRecognitionSupported());
    setIsChromium(isChromiumBrowser());

    const speechQueue = new SpeechQueue({
      onFirstAudioStart: () =>
        updateLatestMetric({ ttfa: performance.now() - turnStartRef.current }),
      onSpeakingChange: (speaking) => {
        if (speaking) {
          setAgentState("speaking");
        } else {
          syncStateAfterAsync();
        }
      },
      onError: (message) => setError(message),
    });
    speechQueueRef.current = speechQueue;

    const endpointer = new Endpointer({
      silenceMs: SILENCE_MS,
      minChars: MIN_UTTERANCE_CHARS,
      onTurnEnd: (text) => submitTurn(text),
    });
    endpointerRef.current = endpointer;

    const recognizer = new ContinuousRecognizer({
      onTranscriptUpdate: (text) => {
        setLiveUserTranscript(text);

        const withinGracePeriod = Date.now() - turnSubmittedAtRef.current < BARGE_IN_GRACE_MS;
        const agentBusy =
          agentStateRef.current === "thinking" || agentStateRef.current === "speaking";
        if (agentBusy && !withinGracePeriod) {
          bargeIn();
        }

        endpointerRef.current?.update(text);
      },
      onError: (reason: RecognitionErrorReason, message) => {
        if (message) setError(message);
        // Permission denied / no mic / unsupported are unrecoverable for this
        // session — drop back to idle rather than showing a stale "Listening"
        // indicator while nothing is actually listening. Transient errors
        // (network, "other") are left to the recognizer's own auto-restart.
        if (reason === "not-allowed" || reason === "audio-capture" || reason === "unsupported") {
          stopEverything();
        }
      },
    });
    recognizerRef.current = recognizer;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        recognizerRef.current?.ensureRunning();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      recognizer.stop();
      speechQueue.cancelAll();
      abortControllerRef.current?.abort();
    };
  }, [bargeIn, stopEverything, submitTurn, syncStateAfterAsync, updateLatestMetric]);

  function toggleConversation() {
    if (agentState === "idle") {
      if (!sttSupported) {
        setError("Voice input isn't supported in this browser. Try Chrome.");
        return;
      }
      setError(null);
      // Each "Start conversation" is a fresh call — like a phone ringing
      // again — so the call log shows distinct conversations rather than
      // one endlessly-growing session.
      const id = newSessionId();
      sessionIdRef.current = id;
      setSessionId(id);
      setMessages([]);
      setMetrics([]);
      setTransferred(false);
      setEscalationReasons(null);
      bargeInCountRef.current = 0;

      recognizerRef.current?.start();
      setAgentState("listening");
    } else {
      stopEverything();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleManualSubmit(input);
      setInput("");
    }
  }

  const conversationActive = agentState !== "idle";

  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        padding: "0 16px",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          padding: "20px 0 12px",
          borderBottom: "1px solid #e2e4e8",
        }}
      >
        <div>
          <h1 style={{ fontSize: 18, margin: 0 }}>Riverside Family Dental</h1>
          <p style={{ fontSize: 13, color: "#666", margin: "4px 0 0" }}>
            Talk with Casey, the AI receptionist
          </p>
        </div>
        <Link href="/calls" style={{ fontSize: 13, color: "#2563eb", whiteSpace: "nowrap" }}>
          📋 Call log
        </Link>
      </header>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 0",
          borderBottom: "1px solid #e2e4e8",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: STATE_COLOR[agentState],
              display: "inline-block",
              boxShadow: agentState !== "idle" ? `0 0 0 4px ${STATE_COLOR[agentState]}22` : "none",
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 600 }}>{STATE_LABEL[agentState]}</span>
        </div>

        <button
          onClick={toggleConversation}
          style={{
            padding: "8px 16px",
            borderRadius: 10,
            border: "none",
            background: conversationActive ? "#dc2626" : "#2563eb",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {conversationActive ? "☎ End conversation" : "🎙 Start conversation"}
        </button>
      </div>

      {conversationActive && (
        <p style={{ fontSize: 12, color: "#888", margin: "8px 0 0" }}>
          Tip: use headphones — without them, the agent's own voice through your speakers can be
          picked back up by the mic and misread as an interruption.
        </p>
      )}

      {!sttSupported && (
        <div
          style={{
            background: "#fdecea",
            border: "1px solid #f5b3ac",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 13,
            margin: "12px 0",
          }}
        >
          Voice input isn&apos;t supported in this browser. Try Chrome (or another Chromium
          browser) — text chat below still works.
        </div>
      )}

      {sttSupported && !isChromium && (
        <div
          style={{
            background: "#fff4e5",
            border: "1px solid #ffcf87",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 13,
            margin: "12px 0",
          }}
        >
          Voice input works most reliably in Chrome. You may see inconsistent results here.
        </div>
      )}

      {escalationReasons && escalationReasons.length > 0 && !transferred && (
        <div
          style={{
            background: "#fdecea",
            border: "1px solid #f5b3ac",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 13,
            margin: "12px 0",
          }}
        >
          ⚠ Detecting signs of frustration ({escalationReasons.join(", ")}) — Casey is being
          nudged to offer a transfer.
        </div>
      )}

      {transferred && (
        <div
          style={{
            background: "#fff4e5",
            border: "1px solid #ffcf87",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 13,
            margin: "12px 0",
          }}
        >
          This call has been flagged for transfer to a human staff member.
        </div>
      )}

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 0",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {messages.length === 0 && (
          <p style={{ color: "#888", fontSize: 14 }}>
            Click &ldquo;Start conversation&rdquo;, then say something like &ldquo;I need to book
            an appointment tomorrow afternoon.&rdquo;
          </p>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "80%",
              background: m.role === "user" ? "#2563eb" : "#fff",
              color: m.role === "user" ? "#fff" : "#1a1a1a",
              border: m.role === "user" ? "none" : "1px solid #e2e4e8",
              borderRadius: 14,
              padding: "10px 14px",
              fontSize: 14,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
            }}
          >
            {m.text}
          </div>
        ))}

        {liveAgentText && (
          <div
            style={{
              alignSelf: "flex-start",
              maxWidth: "80%",
              background: "#fff",
              color: "#1a1a1a",
              border: "1px dashed #7ea2e8",
              borderRadius: 14,
              padding: "10px 14px",
              fontSize: 14,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
            }}
          >
            <span aria-hidden>🔊 </span>
            {liveAgentText}
          </div>
        )}

        {agentState === "listening" && liveUserTranscript && (
          <div
            style={{
              alignSelf: "flex-end",
              maxWidth: "80%",
              background: "#dbe6fb",
              color: "#1a1a1a",
              border: "1px dashed #7ea2e8",
              borderRadius: 14,
              padding: "10px 14px",
              fontSize: 14,
              lineHeight: 1.45,
              fontStyle: "italic",
            }}
          >
            {liveUserTranscript}
          </div>
        )}

        {agentState === "thinking" && !liveAgentText && (
          <div style={{ alignSelf: "flex-start", color: "#888", fontSize: 13, padding: "0 4px" }}>
            Casey is thinking…
          </div>
        )}

        {error && <div style={{ color: "#c0392b", fontSize: 13, padding: "0 4px" }}>{error}</div>}

        <div ref={bottomRef} />
      </div>

      {metrics.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 10,
            overflowX: "auto",
            padding: "8px 0",
            borderTop: "1px solid #e2e4e8",
            fontSize: 11,
            color: "#666",
          }}
        >
          {metrics.map((m, i) => (
            <div
              key={i}
              style={{
                flexShrink: 0,
                border: "1px solid #e2e4e8",
                borderRadius: 8,
                padding: "4px 8px",
                background: "#fafafa",
              }}
            >
              <div style={{ fontWeight: 600 }}>Turn {i + 1}</div>
              <div>TTFT: {formatMs(m.ttft)}</div>
              <div>TTFA: {formatMs(m.ttfa)}</div>
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "12px 0 20px",
          borderTop: "1px solid #e2e4e8",
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Or type a message…"
          disabled={!sessionId}
          style={{
            flex: 1,
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #d0d3d9",
            fontSize: 14,
            outline: "none",
          }}
        />
        <button
          onClick={() => {
            handleManualSubmit(input);
            setInput("");
          }}
          disabled={!input.trim() || !sessionId}
          style={{
            padding: "10px 18px",
            borderRadius: 10,
            border: "none",
            background: !input.trim() ? "#b8c2d9" : "#2563eb",
            color: "#fff",
            fontSize: 14,
            cursor: !input.trim() ? "default" : "pointer",
          }}
        >
          Send
        </button>
      </div>
    </main>
  );
}
