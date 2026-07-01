import { createClient, type Client, type InStatement } from "@libsql/client";

declare global {
  // eslint-disable-next-line no-var
  var __voiceAgentDb: Client | undefined;
  // eslint-disable-next-line no-var
  var __voiceAgentDbInit: Promise<void> | undefined;
}

function createConnection(): Client {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is not set. Create a Turso database and set TURSO_DATABASE_URL " +
        "(and TURSO_AUTH_TOKEN, if the database requires one) in .env.local — see README.md. " +
        'For local-only testing without a Turso account, TURSO_DATABASE_URL can also be a ' +
        'local file URL, e.g. "file:./data/local.db".'
    );
  }

  return createClient({ url, authToken });
}

async function initializeSchema(client: Client): Promise<void> {
  const schema: InStatement[] = [
    `CREATE TABLE IF NOT EXISTS availability_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      is_booked INTEGER NOT NULL DEFAULT 0,
      UNIQUE(date, start_time)
    )`,
    `CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL REFERENCES availability_slots(id),
      customer_name TEXT NOT NULL,
      phone TEXT,
      service TEXT,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_conversation_messages_session
      ON conversation_messages(session_id, id)`,
    `CREATE TABLE IF NOT EXISTS tool_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      input TEXT NOT NULL,
      result TEXT NOT NULL,
      is_error INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tool_call_log_session
      ON tool_call_log(session_id, id)`,
  ];

  await client.batch(schema, "write");
  await seedAvailability(client);
}

/** Business hours: Mon-Sat, 9:00-18:00, 30-minute slots. Closed Sunday. */
async function seedAvailability(client: Client): Promise<void> {
  const countResult = await client.execute("SELECT COUNT(*) as count FROM availability_slots");
  const count = countResult.rows[0]?.count as number;
  if (count > 0) return;

  const statements: InStatement[] = [];
  const today = new Date();
  const days = 21; // seed three weeks ahead

  for (let dayOffset = 0; dayOffset < days; dayOffset++) {
    const day = new Date(today);
    day.setDate(today.getDate() + dayOffset);
    if (day.getDay() === 0) continue; // closed Sundays

    const dateStr = formatDate(day);
    for (let minutes = 9 * 60; minutes < 18 * 60; minutes += 30) {
      const start = minutesToTime(minutes);
      const end = minutesToTime(minutes + 30);
      statements.push({
        sql: `INSERT OR IGNORE INTO availability_slots (date, start_time, end_time) VALUES (?, ?, ?)`,
        args: [dateStr, start, end],
      });
    }
  }

  await client.batch(statements, "write");
}

export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function minutesToTime(totalMinutes: number): string {
  const h = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const m = String(totalMinutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/** Returns the shared libSQL client, creating the schema and seed data on first use. */
export async function getDb(): Promise<Client> {
  if (!global.__voiceAgentDb) {
    global.__voiceAgentDb = createConnection();
  }
  if (!global.__voiceAgentDbInit) {
    global.__voiceAgentDbInit = initializeSchema(global.__voiceAgentDb);
  }
  await global.__voiceAgentDbInit;
  return global.__voiceAgentDb;
}
