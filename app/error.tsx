"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ui error boundary]", error);
  }, [error]);

  return (
    <main
      style={{
        maxWidth: 480,
        margin: "80px auto",
        padding: "0 16px",
        textAlign: "center",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 18 }}>Something went wrong</h1>
      <p style={{ fontSize: 14, color: "#666" }}>
        The page hit an unexpected error. Your call history is safe — try reloading.
      </p>
      <button
        onClick={reset}
        style={{
          marginTop: 12,
          padding: "10px 18px",
          borderRadius: 10,
          border: "none",
          background: "#2563eb",
          color: "#fff",
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </main>
  );
}
