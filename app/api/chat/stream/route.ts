import { NextRequest, NextResponse } from "next/server";
import { runAgentTurnStream, type AgentStreamEvent } from "@/lib/agent/orchestrator";

// Needed for better-sqlite3 / the Anthropic SDK — not edge-compatible.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId, message, consecutiveBargeIns } = (body ?? {}) as {
    sessionId?: string;
    message?: string;
    consecutiveBargeIns?: number;
  };

  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }
  if (!message || typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AgentStreamEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        await runAgentTurnStream(sessionId, message.trim(), emit, {
          consecutiveBargeIns:
            typeof consecutiveBargeIns === "number" ? consecutiveBargeIns : undefined,
        });
      } catch (err) {
        console.error("[api/chat/stream] agent turn failed:", err);
        emit({ type: "error", message: "Agent failed to respond." });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
