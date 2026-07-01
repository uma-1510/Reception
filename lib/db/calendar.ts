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

export async function getAvailability(date: string, timeOfDay?: TimeOfDay): Promise<Slot[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT * FROM availability_slots WHERE date = ? AND is_booked = 0 ORDER BY start_time`,
    args: [date],
  });
  const slots = result.rows as unknown as Slot[];

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

/**
 * The slot-availability check and the booking write happen in the same
 * "write" transaction (not just a read-then-write pair) so two concurrent
 * bookings for the same slot can't both pass the check before either
 * commits — libSQL serializes write transactions on the server, so the
 * second one sees the first's update once it gets its turn.
 */
export async function bookAppointment(input: BookAppointmentInput): Promise<BookAppointmentResult> {
  const db = await getDb();
  const tx = await db.transaction("write");

  try {
    const slotResult = await tx.execute({
      sql: `SELECT * FROM availability_slots WHERE date = ? AND start_time = ? AND is_booked = 0`,
      args: [input.date, input.start_time],
    });
    const slot = slotResult.rows[0] as unknown as Slot | undefined;

    if (!slot) {
      await tx.rollback();
      return {
        ok: false,
        error: `No open slot at ${input.date} ${input.start_time}. It may already be booked or not exist.`,
      };
    }

    await tx.execute({
      sql: `UPDATE availability_slots SET is_booked = 1 WHERE id = ?`,
      args: [slot.id],
    });

    const insertResult = await tx.execute({
      sql: `INSERT INTO appointments (slot_id, customer_name, phone, service, date, start_time, end_time, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'booked')`,
      args: [
        slot.id,
        input.customer_name,
        input.phone ?? null,
        input.service ?? null,
        input.date,
        slot.start_time,
        slot.end_time,
      ],
    });
    const appointmentId = Number(insertResult.lastInsertRowid);

    const apptResult = await tx.execute({
      sql: `SELECT * FROM appointments WHERE id = ?`,
      args: [appointmentId],
    });

    await tx.commit();
    return { ok: true, appointment: apptResult.rows[0] as unknown as Appointment };
  } finally {
    tx.close();
  }
}

export interface FindAppointmentInput {
  appointment_id?: number;
  customer_name?: string;
  phone?: string;
}

export async function findAppointments(input: FindAppointmentInput): Promise<Appointment[]> {
  const db = await getDb();

  if (input.appointment_id) {
    const result = await db.execute({
      sql: `SELECT * FROM appointments WHERE id = ? AND status = 'booked'`,
      args: [input.appointment_id],
    });
    const appt = result.rows[0] as unknown as Appointment | undefined;
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

  const result = await db.execute({
    sql: `SELECT * FROM appointments WHERE ${clauses.join(" AND ")} ORDER BY date, start_time`,
    args: params,
  });
  return result.rows as unknown as Appointment[];
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

export async function rescheduleAppointment(
  input: RescheduleAppointmentInput
): Promise<RescheduleResult> {
  const db = await getDb();

  const matches = await findAppointments({
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

  const newSlotResult = await db.execute({
    sql: `SELECT * FROM availability_slots WHERE date = ? AND start_time = ? AND is_booked = 0`,
    args: [input.new_date, input.new_start_time],
  });
  const newSlot = newSlotResult.rows[0] as unknown as Slot | undefined;

  if (!newSlot) {
    return {
      ok: false,
      error: `No open slot at ${input.new_date} ${input.new_start_time}.`,
    };
  }

  const tx = await db.transaction("write");
  try {
    await tx.execute({
      sql: `UPDATE availability_slots SET is_booked = 0 WHERE id = ?`,
      args: [appointment.slot_id],
    });
    await tx.execute({
      sql: `UPDATE availability_slots SET is_booked = 1 WHERE id = ?`,
      args: [newSlot.id],
    });
    await tx.execute({
      sql: `UPDATE appointments
            SET slot_id = ?, date = ?, start_time = ?, end_time = ?, updated_at = datetime('now')
            WHERE id = ?`,
      args: [newSlot.id, newSlot.date, newSlot.start_time, newSlot.end_time, appointment.id],
    });
    await tx.commit();
  } finally {
    tx.close();
  }

  const updatedResult = await db.execute({
    sql: `SELECT * FROM appointments WHERE id = ?`,
    args: [appointment.id],
  });

  return { ok: true, appointment: updatedResult.rows[0] as unknown as Appointment };
}

export interface CancelAppointmentInput {
  appointment_id?: number;
  customer_name?: string;
  phone?: string;
}

export type CancelResult = { ok: true; appointment: Appointment } | { ok: false; error: string };

export async function cancelAppointment(input: CancelAppointmentInput): Promise<CancelResult> {
  const db = await getDb();

  const matches = await findAppointments(input);

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

  const tx = await db.transaction("write");
  try {
    await tx.execute({
      sql: `UPDATE availability_slots SET is_booked = 0 WHERE id = ?`,
      args: [appointment.slot_id],
    });
    await tx.execute({
      sql: `UPDATE appointments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
      args: [appointment.id],
    });
    await tx.commit();
  } finally {
    tx.close();
  }

  const updatedResult = await db.execute({
    sql: `SELECT * FROM appointments WHERE id = ?`,
    args: [appointment.id],
  });

  return { ok: true, appointment: updatedResult.rows[0] as unknown as Appointment };
}
