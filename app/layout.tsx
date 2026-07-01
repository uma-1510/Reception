import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Receptionist Agent — Stage 1",
  description: "Text-based chat interface for the voice agent receptionist prototype",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
