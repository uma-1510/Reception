"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface CallSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  turnCount: number;
  escalated: boolean;
}

function formatTimestamp(sqliteUtc: string): string {
  // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC with no
  // timezone marker — normalize to ISO so the browser parses it as UTC
  // instead of (incorrectly) local time.
  const iso = sqliteUtc.includes("T") ? sqliteUtc : `${sqliteUtc.replace(" ", "T")}Z`;
  return new Date(iso).toLocaleString();
}

export default function CallLogPage() {
  const [calls, setCalls] = useState<CallSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/calls")
      .then((res) => res.json())
      .then((data: { calls?: CallSummary[] }) => setCalls(data.calls ?? []))
      .catch(() => setError("Couldn't load the call log."));
  }, []);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 18, margin: 0 }}>Call log</h1>
          <p style={{ fontSize: 13, color: "#666", margin: "4px 0 0" }}>
            Past conversations with Casey, most recent first.
          </p>
        </div>
        <Link href="/" style={{ fontSize: 13, color: "#2563eb" }}>
          ← Back to phone
        </Link>
      </div>

      <p style={{ fontSize: 12, color: "#a15c00", background: "#fff8e8", border: "1px solid #ffe4a8", borderRadius: 8, padding: "8px 12px", marginTop: 16 }}>
        Demo-only: this page has no access control and shows customer names/phone numbers. Don&apos;t
        expose it publicly in a real deployment — see README.md.
      </p>

      {error && <p style={{ color: "#c0392b", fontSize: 13 }}>{error}</p>}

      {calls === null && !error && (
        <p style={{ color: "#888", fontSize: 14, marginTop: 16 }}>Loading…</p>
      )}

      {calls && calls.length === 0 && (
        <p style={{ color: "#888", fontSize: 14, marginTop: 16 }}>No calls yet.</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
        {calls?.map((call) => (
          <Link
            key={call.sessionId}
            href={`/calls/${call.sessionId}`}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              border: "1px solid #e2e4e8",
              borderRadius: 10,
              padding: "12px 14px",
              textDecoration: "none",
              color: "#1a1a1a",
              background: "#fff",
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{formatTimestamp(call.startedAt)}</div>
              <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                {call.turnCount} {call.turnCount === 1 ? "turn" : "turns"}
              </div>
            </div>
            {call.escalated && (
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#a15c00",
                  background: "#fff4e5",
                  border: "1px solid #ffcf87",
                  borderRadius: 6,
                  padding: "2px 8px",
                }}
              >
                ⚠ Escalated
              </span>
            )}
          </Link>
        ))}
      </div>
    </main>
  );
}
