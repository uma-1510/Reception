import { NextResponse } from "next/server";
import { getCallDetail } from "@/lib/db/callLog";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  try {
    const detail = await getCallDetail(sessionId);
    if (!detail) {
      return NextResponse.json({ error: "Call not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (err) {
    console.error("[api/calls/:sessionId] failed to load call:", err);
    return NextResponse.json({ error: "Failed to load call." }, { status: 500 });
  }
}
