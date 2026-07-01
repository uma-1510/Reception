import type Anthropic from "@anthropic-ai/sdk";
import {
  bookAppointment,
  cancelAppointment,
  findAppointments,
  getAvailability,
  rescheduleAppointment,
  resolveDate,
  type TimeOfDay,
} from "@/lib/db/calendar";

export const tools: Anthropic.Tool[] = [
  {
    name: "check_availability",
    description:
      "Check open appointment slots for a given day. Call this before booking anything, " +
      "so you can offer the customer real open times rather than guessing.",
    input_schema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description:
            'The date to check. Use "today" or "tomorrow" for relative dates, or an ISO date (YYYY-MM-DD).',
        },
        time_of_day: {
          type: "string",
          enum: ["morning", "afternoon", "evening"],
          description: "Optional filter: morning (before 12pm), afternoon (12-5pm), or evening (5pm+).",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book a new appointment at a specific date and time. Only call this after you have " +
      "confirmed the slot is open (via check_availability) and have the customer's name.",
    input_schema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: '"today", "tomorrow", or an ISO date (YYYY-MM-DD).',
        },
        start_time: {
          type: "string",
          description: '24-hour time, e.g. "14:00" for 2pm.',
        },
        customer_name: {
          type: "string",
          description: "The customer's full name.",
        },
        phone: {
          type: "string",
          description: "The customer's phone number, if given.",
        },
        service: {
          type: "string",
          description: 'What the appointment is for, e.g. "cleaning", "checkup", "consultation".',
        },
      },
      required: ["date", "start_time", "customer_name"],
    },
  },
  {
    name: "reschedule_appointment",
    description:
      "Move an existing booked appointment to a new date/time. Identify the appointment by " +
      "appointment_id if the customer gave one, otherwise by customer_name and/or phone.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: {
          type: "integer",
          description: "The appointment ID, if known.",
        },
        customer_name: {
          type: "string",
          description: "The customer's name, used to look up the appointment if no ID is known.",
        },
        phone: {
          type: "string",
          description: "The customer's phone number, used to look up the appointment if no ID is known.",
        },
        new_date: {
          type: "string",
          description: '"today", "tomorrow", or an ISO date (YYYY-MM-DD).',
        },
        new_start_time: {
          type: "string",
          description: '24-hour time, e.g. "14:00" for 2pm.',
        },
      },
      required: ["new_date", "new_start_time"],
    },
  },
  {
    name: "cancel_appointment",
    description:
      "Cancel an existing booked appointment. Identify it by appointment_id if the customer " +
      "gave one, otherwise by customer_name and/or phone.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: {
          type: "integer",
          description: "The appointment ID, if known.",
        },
        customer_name: {
          type: "string",
          description: "The customer's name, used to look up the appointment if no ID is known.",
        },
        phone: {
          type: "string",
          description: "The customer's phone number, used to look up the appointment if no ID is known.",
        },
      },
      required: [],
    },
  },
  {
    name: "transfer_to_human",
    description:
      "Transfer the caller to a human staff member. Use this for anything you can't handle " +
      "yourself: billing disputes, medical questions, complaints, or if the customer directly asks for a person.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief reason for the transfer, for the human picking up.",
        },
      },
      required: ["reason"],
    },
  },
];

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
  transferred: boolean;
}

export function executeTool(name: string, rawInput: unknown): ToolExecutionResult {
  const input = (rawInput ?? {}) as Record<string, unknown>;

  console.log(`\n[tool_call] ${name}`, JSON.stringify(input));

  let result: ToolExecutionResult;
  try {
    result = runTool(name, input);
  } catch (err) {
    // A DB error, malformed input, etc. should degrade the turn, not crash it.
    console.error(`[tool_error] ${name} threw:`, err);
    result = {
      content: "Something went wrong looking that up. Let me get a person to help you.",
      isError: true,
      transferred: true,
    };
  }

  console.log(`[tool_result] ${name} -> ${result.isError ? "ERROR" : "OK"}:`, result.content);

  return result;
}

function runTool(name: string, input: Record<string, unknown>): ToolExecutionResult {
  switch (name) {
    case "check_availability": {
      const date = resolveDate(String(input.date ?? ""));
      const timeOfDay = input.time_of_day as TimeOfDay | undefined;
      const slots = getAvailability(date, timeOfDay);

      if (slots.length === 0) {
        return {
          content: `No open slots on ${date}${timeOfDay ? ` (${timeOfDay})` : ""}.`,
          isError: false,
          transferred: false,
        };
      }

      const times = slots.map((s) => s.start_time).join(", ");
      return {
        content: `Open slots on ${date}${timeOfDay ? ` (${timeOfDay})` : ""}: ${times}`,
        isError: false,
        transferred: false,
      };
    }

    case "book_appointment": {
      const date = resolveDate(String(input.date ?? ""));
      const result = bookAppointment({
        date,
        start_time: String(input.start_time ?? ""),
        customer_name: String(input.customer_name ?? ""),
        phone: input.phone ? String(input.phone) : undefined,
        service: input.service ? String(input.service) : undefined,
      });

      if (!result.ok) {
        return { content: result.error, isError: true, transferred: false };
      }

      const a = result.appointment;
      return {
        content: `Booked. Appointment ID ${a.id}: ${a.customer_name} on ${a.date} at ${a.start_time}${
          a.service ? ` for ${a.service}` : ""
        }.`,
        isError: false,
        transferred: false,
      };
    }

    case "reschedule_appointment": {
      const newDate = resolveDate(String(input.new_date ?? ""));
      const result = rescheduleAppointment({
        appointment_id: input.appointment_id ? Number(input.appointment_id) : undefined,
        customer_name: input.customer_name ? String(input.customer_name) : undefined,
        phone: input.phone ? String(input.phone) : undefined,
        new_date: newDate,
        new_start_time: String(input.new_start_time ?? ""),
      });

      if (!result.ok) {
        return { content: result.error, isError: true, transferred: false };
      }

      const a = result.appointment;
      return {
        content: `Rescheduled. Appointment ID ${a.id} is now ${a.date} at ${a.start_time}.`,
        isError: false,
        transferred: false,
      };
    }

    case "cancel_appointment": {
      if (!input.appointment_id && !input.customer_name && !input.phone) {
        const matches = findAppointments({});
        void matches;
        return {
          content: "Need an appointment ID, customer name, or phone number to find the appointment.",
          isError: true,
          transferred: false,
        };
      }

      const result = cancelAppointment({
        appointment_id: input.appointment_id ? Number(input.appointment_id) : undefined,
        customer_name: input.customer_name ? String(input.customer_name) : undefined,
        phone: input.phone ? String(input.phone) : undefined,
      });

      if (!result.ok) {
        return { content: result.error, isError: true, transferred: false };
      }

      const a = result.appointment;
      return {
        content: `Cancelled appointment ID ${a.id} for ${a.customer_name} on ${a.date} at ${a.start_time}.`,
        isError: false,
        transferred: false,
      };
    }

    case "transfer_to_human": {
      const reason = String(input.reason ?? "unspecified");
      return {
        content: `Transferring to a human staff member. Reason: ${reason}`,
        isError: false,
        transferred: true,
      };
    }

    default:
      return { content: `Unknown tool: ${name}`, isError: true, transferred: false };
  }
}
