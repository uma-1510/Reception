import { NextResponse } from "next/server";
import { listCalls } from "@/lib/db/callLog";

export async function GET() {
  try {
    return NextResponse.json({ calls: await listCalls() });
  } catch (err) {
    console.error("[api/calls] failed to list calls:", err);
    return NextResponse.json({ error: "Failed to load call log." }, { status: 500 });
  }
}
