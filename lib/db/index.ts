import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "calendar.sqlite");

declare global {
  // eslint-disable-next-line no-var
  var __voiceAgentDb: Database.Database | undefined;
}

function createConnection(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS availability_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      is_booked INTEGER NOT NULL DEFAULT 0,
      UNIQUE(date, start_time)
    );

    CREATE TABLE IF NOT EXISTS appointments (
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
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_session
      ON conversation_messages(session_id, id);

    CREATE TABLE IF NOT EXISTS tool_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      input TEXT NOT NULL,
      result TEXT NOT NULL,
      is_error INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tool_call_log_session
      ON tool_call_log(session_id, id);
  `);

  seedAvailability(db);

  return db;
}

/** Business hours: Mon-Sat, 9:00-18:00, 30-minute slots. Closed Sunday. */
function seedAvailability(db: Database.Database) {
  const row = db.prepare("SELECT COUNT(*) as count FROM availability_slots").get() as {
    count: number;
  };
  if (row.count > 0) return;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO availability_slots (date, start_time, end_time) VALUES (?, ?, ?)`
  );

  const insertMany = db.transaction((days: number) => {
    const today = new Date();
    for (let dayOffset = 0; dayOffset < days; dayOffset++) {
      const day = new Date(today);
      day.setDate(today.getDate() + dayOffset);
      if (day.getDay() === 0) continue; // closed Sundays

      const dateStr = formatDate(day);
      for (let minutes = 9 * 60; minutes < 18 * 60; minutes += 30) {
        const start = minutesToTime(minutes);
        const end = minutesToTime(minutes + 30);
        insert.run(dateStr, start, end);
      }
    }
  });

  insertMany(21); // seed three weeks ahead
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

export function getDb(): Database.Database {
  if (!global.__voiceAgentDb) {
    global.__voiceAgentDb = createConnection();
  }
  return global.__voiceAgentDb;
}
