import { NextResponse } from "next/server";
import { listCalls } from "@/lib/db/callLog";

export async function GET() {
  return NextResponse.json({ calls: listCalls() });
}
