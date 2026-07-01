import { getDb } from "./index";
import { getDisplayMessages, type DisplayMessage } from "./conversations";

export interface ToolCallLogEntry {
  id: number;
  session_id: string;
  name: string;
  input: string;
  result: string;
  is_error: number;
  created_at: string;
}

export function logToolCall(
  sessionId: string,
  name: string,
  input: unknown,
  result: { content: string; isError: boolean }
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO tool_call_log (session_id, name, input, result, is_error) VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, name, JSON.stringify(input ?? {}), result.content, result.isError ? 1 : 0);
}

export function getToolCalls(sessionId: string): ToolCallLogEntry[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM tool_call_log WHERE session_id = ? ORDER BY id ASC`)
    .all(sessionId) as ToolCallLogEntry[];
}

export interface CallSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  turnCount: number;
  escalated: boolean;
}

/** Calls are a derived view, not a separate table — grouped straight off conversation_messages + tool_call_log by session_id. */
export function listCalls(limit = 50): CallSummary[] {
  const db = getDb();
  const sessions = db
    .prepare(
      `SELECT session_id as sessionId, MIN(created_at) as startedAt, MAX(created_at) as endedAt
       FROM conversation_messages
       GROUP BY session_id
       ORDER BY startedAt DESC
       LIMIT ?`
    )
    .all(limit) as { sessionId: string; startedAt: string; endedAt: string }[];

  const escalatedStmt = db.prepare(
    `SELECT COUNT(*) as count FROM tool_call_log WHERE session_id = ? AND name = 'transfer_to_human' AND is_error = 0`
  );

  return sessions.map((row) => ({
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    // turnCount reuses getDisplayMessages' existing text-block filtering, which
    // already distinguishes a real user utterance from a tool_result-only "user"
    // message (tool results carry no text block, so they're excluded for free).
    turnCount: getDisplayMessages(row.sessionId).filter((m) => m.role === "user").length,
    escalated: (escalatedStmt.get(row.sessionId) as { count: number }).count > 0,
  }));
}

export interface CallDetail {
  sessionId: string;
  messages: DisplayMessage[];
  toolCalls: ToolCallLogEntry[];
  escalated: boolean;
}

export function getCallDetail(sessionId: string): CallDetail | null {
  const messages = getDisplayMessages(sessionId);
  if (messages.length === 0) return null;

  const toolCalls = getToolCalls(sessionId);
  const escalated = toolCalls.some((t) => t.name === "transfer_to_human" && !t.is_error);

  return { sessionId, messages, toolCalls, escalated };
}
