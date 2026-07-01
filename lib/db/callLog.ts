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

export async function logToolCall(
  sessionId: string,
  name: string,
  input: unknown,
  result: { content: string; isError: boolean }
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO tool_call_log (session_id, name, input, result, is_error) VALUES (?, ?, ?, ?, ?)`,
    args: [sessionId, name, JSON.stringify(input ?? {}), result.content, result.isError ? 1 : 0],
  });
}

export async function getToolCalls(sessionId: string): Promise<ToolCallLogEntry[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT * FROM tool_call_log WHERE session_id = ? ORDER BY id ASC`,
    args: [sessionId],
  });
  return result.rows as unknown as ToolCallLogEntry[];
}

export interface CallSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  turnCount: number;
  escalated: boolean;
}

/** Calls are a derived view, not a separate table — grouped straight off conversation_messages + tool_call_log by session_id. */
export async function listCalls(limit = 50): Promise<CallSummary[]> {
  const db = await getDb();
  const sessionsResult = await db.execute({
    sql: `SELECT session_id as sessionId, MIN(created_at) as startedAt, MAX(created_at) as endedAt
          FROM conversation_messages
          GROUP BY session_id
          ORDER BY startedAt DESC
          LIMIT ?`,
    args: [limit],
  });
  const sessions = sessionsResult.rows as unknown as {
    sessionId: string;
    startedAt: string;
    endedAt: string;
  }[];

  return Promise.all(
    sessions.map(async (row) => {
      // turnCount reuses getDisplayMessages' existing text-block filtering, which
      // already distinguishes a real user utterance from a tool_result-only "user"
      // message (tool results carry no text block, so they're excluded for free).
      const [displayMessages, escalatedResult] = await Promise.all([
        getDisplayMessages(row.sessionId),
        db.execute({
          sql: `SELECT COUNT(*) as count FROM tool_call_log WHERE session_id = ? AND name = 'transfer_to_human' AND is_error = 0`,
          args: [row.sessionId],
        }),
      ]);

      const escalatedCount = escalatedResult.rows[0]?.count as number;

      return {
        sessionId: row.sessionId,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        turnCount: displayMessages.filter((m) => m.role === "user").length,
        escalated: escalatedCount > 0,
      };
    })
  );
}

export interface CallDetail {
  sessionId: string;
  messages: DisplayMessage[];
  toolCalls: ToolCallLogEntry[];
  escalated: boolean;
}

export async function getCallDetail(sessionId: string): Promise<CallDetail | null> {
  const messages = await getDisplayMessages(sessionId);
  if (messages.length === 0) return null;

  const toolCalls = await getToolCalls(sessionId);
  const escalated = toolCalls.some((t) => t.name === "transfer_to_human" && !t.is_error);

  return { sessionId, messages, toolCalls, escalated };
}
