import { getDb, formatDate } from "./index";

export interface Slot {
  id: number;
  date: string;
  start_time: string;
  end_time: string;
  is_booked: number;
}

export interface Appointment {
  id: number;
  slot_id: number;
  customer_name: string;
  phone: string | null;
  service: string | null;
  date: string;
  start_time: string;
  end_time: string;
  status: "booked" | "cancelled";
  created_at: string;
  updated_at: string;
}

export type TimeOfDay = "morning" | "afternoon" | "evening";

function timeOfDayFilter(startTime: string, timeOfDay?: TimeOfDay): boolean {
  if (!timeOfDay) return true;
  if (timeOfDay === "morning") return startTime < "12:00";
  if (timeOfDay === "afternoon") return startTime >= "12:00" && startTime < "17:00";
  return startTime >= "17:00"; // evening
}

/** Resolve a natural-language-ish date keyword ("today", "tomorrow") or pass through an ISO date. */
export function resolveDate(dateInput: string): string {
  const today = new Date();
  const normalized = dateInput.trim().toLowerCase();

  if (normalized === "today") return formatDate(today);
  if (normalized === "tomorrow") {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return formatDate(d);
  }
  // Assume already an ISO date (YYYY-MM-DD)
  return dateInput;
}

export function getAvailability(date: string, timeOfDay?: TimeOfDay): Slot[] {
  const db = getDb();
  const slots = db
    .prepare(
      `SELECT * FROM availability_slots WHERE date = ? AND is_booked = 0 ORDER BY start_time`
    )
    .all(date) as Slot[];

  return slots.filter((s) => timeOfDayFilter(s.start_time, timeOfDay));
}

export interface BookAppointmentInput {
  date: string;
  start_time: string;
  customer_name: string;
  phone?: string;
  service?: string;
}

export type BookAppointmentResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; error: string };

export function bookAppointment(input: BookAppointmentInput): BookAppointmentResult {
  const db = getDb();

  const slot = db
    .prepare(
      `SELECT * FROM availability_slots WHERE date = ? AND start_time = ? AND is_booked = 0`
    )
    .get(input.date, input.start_time) as Slot | undefined;

  if (!slot) {
    return {
      ok: false,
      error: `No open slot at ${input.date} ${input.start_time}. It may already be booked or not exist.`,
    };
  }

  const txn = db.transaction(() => {
    db.prepare(`UPDATE availability_slots SET is_booked = 1 WHERE id = ?`).run(slot.id);
    const result = db
      .prepare(
        `INSERT INTO appointments (slot_id, customer_name, phone, service, date, start_time, end_time, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'booked')`
      )
      .run(
        slot.id,
        input.customer_name,
        input.phone ?? null,
        input.service ?? null,
        input.date,
        slot.start_time,
        slot.end_time
      );
    return result.lastInsertRowid as number;
  });

  const appointmentId = txn();
  const appointment = db
    .prepare(`SELECT * FROM appointments WHERE id = ?`)
    .get(appointmentId) as Appointment;

  return { ok: true, appointment };
}

export interface FindAppointmentInput {
  appointment_id?: number;
  customer_name?: string;
  phone?: string;
}

export function findAppointments(input: FindAppointmentInput): Appointment[] {
  const db = getDb();

  if (input.appointment_id) {
    const appt = db
      .prepare(`SELECT * FROM appointments WHERE id = ? AND status = 'booked'`)
      .get(input.appointment_id) as Appointment | undefined;
    return appt ? [appt] : [];
  }

  const clauses: string[] = [`status = 'booked'`];
  const params: string[] = [];

  if (input.customer_name) {
    clauses.push(`customer_name LIKE ?`);
    params.push(`%${input.customer_name}%`);
  }
  if (input.phone) {
    clauses.push(`phone = ?`);
    params.push(input.phone);
  }

  if (params.length === 0) return [];

  return db
    .prepare(`SELECT * FROM appointments WHERE ${clauses.join(" AND ")} ORDER BY date, start_time`)
    .all(...params) as Appointment[];
}

export interface RescheduleAppointmentInput {
  appointment_id?: number;
  customer_name?: string;
  phone?: string;
  new_date: string;
  new_start_time: string;
}

export type RescheduleResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; error: string };

export function rescheduleAppointment(input: RescheduleAppointmentInput): RescheduleResult {
  const db = getDb();

  const matches = findAppointments({
    appointment_id: input.appointment_id,
    customer_name: input.customer_name,
    phone: input.phone,
  });

  if (matches.length === 0) {
    return { ok: false, error: "No matching booked appointment found." };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `Found ${matches.length} matching appointments. Ask the customer for their appointment ID or phone number to disambiguate.`,
    };
  }

  const appointment = matches[0];

  const newSlot = db
    .prepare(
      `SELECT * FROM availability_slots WHERE date = ? AND start_time = ? AND is_booked = 0`
    )
    .get(input.new_date, input.new_start_time) as Slot | undefined;

  if (!newSlot) {
    return {
      ok: false,
      error: `No open slot at ${input.new_date} ${input.new_start_time}.`,
    };
  }

  const txn = db.transaction(() => {
    db.prepare(`UPDATE availability_slots SET is_booked = 0 WHERE id = ?`).run(
      appointment.slot_id
    );
    db.prepare(`UPDATE availability_slots SET is_booked = 1 WHERE id = ?`).run(newSlot.id);
    db.prepare(
      `UPDATE appointments
       SET slot_id = ?, date = ?, start_time = ?, end_time = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(newSlot.id, newSlot.date, newSlot.start_time, newSlot.end_time, appointment.id);
  });
  txn();

  const updated = db
    .prepare(`SELECT * FROM appointments WHERE id = ?`)
    .get(appointment.id) as Appointment;

  return { ok: true, appointment: updated };
}

export interface CancelAppointmentInput {
  appointment_id?: number;
  customer_name?: string;
  phone?: string;
}

export type CancelResult = { ok: true; appointment: Appointment } | { ok: false; error: string };

export function cancelAppointment(input: CancelAppointmentInput): CancelResult {
  const db = getDb();

  const matches = findAppointments(input);

  if (matches.length === 0) {
    return { ok: false, error: "No matching booked appointment found." };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `Found ${matches.length} matching appointments. Ask the customer for their appointment ID or phone number to disambiguate.`,
    };
  }

  const appointment = matches[0];

  const txn = db.transaction(() => {
    db.prepare(`UPDATE availability_slots SET is_booked = 0 WHERE id = ?`).run(
      appointment.slot_id
    );
    db.prepare(
      `UPDATE appointments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
    ).run(appointment.id);
  });
  txn();

  const updated = db
    .prepare(`SELECT * FROM appointments WHERE id = ?`)
    .get(appointment.id) as Appointment;

  return { ok: true, appointment: updated };
}
