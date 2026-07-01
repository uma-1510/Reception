import Anthropic from "@anthropic-ai/sdk";

export interface AgentErrorOutcome {
  reply: string;
  transferred: boolean;
}

/**
 * Maps a thrown error from the Claude API call to a safe, spoken-friendly
 * response instead of letting it propagate as a raw 500. Every branch
 * escalates (transferred: true) — if the AI itself is failing, the safest
 * default is a human, not a caller stuck talking to a broken bot.
 */
export function describeAgentError(err: unknown): AgentErrorOutcome {
  if (err instanceof Anthropic.RateLimitError) {
    console.error("[agent error] rate limited:", err.message);
    return {
      reply: "I'm getting a lot of calls right now. Let me get a person to help you instead.",
      transferred: true,
    };
  }

  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    console.error("[agent error] auth/permission failure:", err.message);
    return {
      reply: "Sorry, I'm having a technical problem on my end. Let me get you a person.",
      transferred: true,
    };
  }

  if (err instanceof Anthropic.APIConnectionError) {
    console.error("[agent error] connection failure:", err.message);
    return {
      reply: "Sorry, I'm having trouble connecting right now. Let me get a person to help you.",
      transferred: true,
    };
  }

  if (err instanceof Anthropic.APIError) {
    console.error(`[agent error] API error (${err.status}):`, err.message);
    return {
      reply: "Sorry, something went wrong on my end. Let me get a person to help you.",
      transferred: true,
    };
  }

  console.error("[agent error] unexpected failure:", err);
  return {
    reply: "Sorry, something went wrong. Let me get a person to help you.",
    transferred: true,
  };
}
