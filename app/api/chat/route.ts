import { NextRequest, NextResponse } from "next/server";
import { runAgentTurn } from "@/lib/agent/orchestrator";
import { getDisplayMessages } from "@/lib/db/conversations";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }
  return NextResponse.json({ messages: getDisplayMessages(sessionId) });
}

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

  try {
    const result = await runAgentTurn(sessionId, message.trim(), {
      consecutiveBargeIns:
        typeof consecutiveBargeIns === "number" ? consecutiveBargeIns : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/chat] agent turn failed:", err);
    return NextResponse.json({ error: "Agent failed to respond." }, { status: 500 });
  }
}
