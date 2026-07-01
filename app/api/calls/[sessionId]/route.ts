import { NextResponse } from "next/server";
import { getCallDetail } from "@/lib/db/callLog";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const detail = getCallDetail(sessionId);

  if (!detail) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 });
  }

  return NextResponse.json(detail);
}
