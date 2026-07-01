"use client";

export interface StreamedAgentEvent {
  type: "text_delta" | "tool_call" | "tool_result" | "escalation_detected" | "done" | "error";
  text?: string;
  name?: string;
  input?: unknown;
  isError?: boolean;
  reply?: string;
  transferred?: boolean;
  message?: string;
  reasons?: string[];
}

export interface StreamAgentTurnOptions {
  sessionId: string;
  message: string;
  /** How many times the caller has interrupted the agent so far this call — fed into escalation detection. */
  consecutiveBargeIns?: number;
  signal?: AbortSignal;
  onEvent: (event: StreamedAgentEvent) => void;
}

/**
 * Calls POST /api/chat/stream and invokes onEvent for each NDJSON line as it
 * arrives over the response body. Pass `signal` to abort mid-stream on
 * barge-in — the fetch throws a DOMException("AbortError") the caller should
 * treat as an intentional cancellation, not a real error.
 */
export async function streamAgentTurn({
  sessionId,
  message,
  consecutiveBargeIns,
  signal,
  onEvent,
}: StreamAgentTurnOptions): Promise<void> {
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message, consecutiveBargeIns }),
    signal,
  });

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // last line may be incomplete — keep it for the next chunk

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as StreamedAgentEvent);
      } catch {
        // malformed line — skip rather than kill the whole stream
      }
    }
  }

  if (buffer.trim()) {
    try {
      onEvent(JSON.parse(buffer) as StreamedAgentEvent);
    } catch {
      // ignore trailing partial garbage
    }
  }
}
