import type Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./index";

export type StoredMessage = Anthropic.MessageParam;

export function getConversation(sessionId: string): StoredMessage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT role, content FROM conversation_messages WHERE session_id = ? ORDER BY id ASC`
    )
    .all(sessionId) as { role: string; content: string }[];

  return rows.map((row) => ({
    role: row.role as "user" | "assistant",
    content: JSON.parse(row.content),
  }));
}

export function appendMessage(sessionId: string, message: StoredMessage): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO conversation_messages (session_id, role, content) VALUES (?, ?, ?)`
  ).run(sessionId, message.role, JSON.stringify(message.content));
}

export interface DisplayMessage {
  role: "user" | "assistant";
  text: string;
}

/** Text-only view of the transcript, for rendering in the chat UI (skips pure tool_use/tool_result turns). */
export function getDisplayMessages(sessionId: string): DisplayMessage[] {
  const messages = getConversation(sessionId);
  const display: DisplayMessage[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const role = message.role;

    if (typeof message.content === "string") {
      if (message.content.trim()) {
        display.push({ role, text: message.content });
      }
      continue;
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (text) {
      display.push({ role, text });
    }
  }

  return display;
}
