"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

interface DisplayMessage {
  role: "user" | "assistant";
  text: string;
}

interface ToolCallLogEntry {
  id: number;
  session_id: string;
  name: string;
  input: string;
  result: string;
  is_error: number;
  created_at: string;
}

interface CallDetail {
  sessionId: string;
  messages: DisplayMessage[];
  toolCalls: ToolCallLogEntry[];
  escalated: boolean;
}

function formatTimestamp(sqliteUtc: string): string {
  const iso = sqliteUtc.includes("T") ? sqliteUtc : `${sqliteUtc.replace(" ", "T")}Z`;
  return new Date(iso).toLocaleString();
}

function formatInput(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
}

export default function CallDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  const [detail, setDetail] = useState<CallDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/calls/${encodeURIComponent(sessionId)}`)
      .then(async (res) => {
        if (!res.ok) {
          setDetail(null);
          return;
        }
        setDetail((await res.json()) as CallDetail);
      })
      .catch(() => setError("Couldn't load this call."));
  }, [sessionId]);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 18, margin: 0 }}>Call detail</h1>
          <p style={{ fontSize: 12, color: "#888", margin: "4px 0 0", fontFamily: "monospace" }}>
            {sessionId}
          </p>
        </div>
        <Link href="/calls" style={{ fontSize: 13, color: "#2563eb" }}>
          ← Back to call log
        </Link>
      </div>

      {error && <p style={{ color: "#c0392b", fontSize: 13 }}>{error}</p>}
      {detail === undefined && !error && (
        <p style={{ color: "#888", fontSize: 14, marginTop: 16 }}>Loading…</p>
      )}
      {detail === null && <p style={{ color: "#888", fontSize: 14, marginTop: 16 }}>Call not found.</p>}

      {detail && (
        <>
          {detail.escalated && (
            <div
              style={{
                background: "#fff4e5",
                border: "1px solid #ffcf87",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 13,
                margin: "16px 0",
              }}
            >
              ⚠ This call was transferred to a human staff member.
            </div>
          )}

          <section style={{ marginTop: 16 }}>
            <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Transcript</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {detail.messages.map((m, i) => (
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
                    display: "flex",
                  }}
                >
                  {m.text}
                </div>
              ))}
              {detail.messages.length === 0 && (
                <p style={{ color: "#888", fontSize: 13 }}>No transcript text for this call.</p>
              )}
            </div>
          </section>

          <section style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Tool calls</h2>
            {detail.toolCalls.length === 0 && (
              <p style={{ color: "#888", fontSize: 13 }}>No tools were called during this call.</p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {detail.toolCalls.map((t) => (
                <div
                  key={t.id}
                  style={{
                    border: "1px solid #e2e4e8",
                    borderRadius: 8,
                    padding: "8px 12px",
                    fontSize: 12,
                    background: t.is_error ? "#fdecea" : "#fafafa",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {t.name} {t.is_error ? "— error" : ""}
                    <span style={{ fontWeight: 400, color: "#888", marginLeft: 8 }}>
                      {formatTimestamp(t.created_at)}
                    </span>
                  </div>
                  <div style={{ marginTop: 4, fontFamily: "monospace", color: "#444" }}>
                    input: {formatInput(t.input)}
                  </div>
                  <div style={{ marginTop: 2, color: "#444" }}>result: {t.result}</div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
