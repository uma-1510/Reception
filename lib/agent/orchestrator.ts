import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, MODEL } from "./client";
import { tools, executeTool } from "./tools";
import { buildSystemPrompt } from "./system-prompt";
import { appendMessage, getConversation } from "@/lib/db/conversations";
import { logToolCall } from "@/lib/db/callLog";
import { detectFrustrationSignals } from "./escalation";
import { describeAgentError } from "./errors";

const MAX_TOOL_ITERATIONS = 8;

export interface TurnContext {
  /** How many times the caller has interrupted the agent so far this call — a distress signal in its own right. */
  consecutiveBargeIns?: number;
}

interface EscalationSignal {
  flagged: boolean;
  reasons: string[];
}

/**
 * Runs frustration detection on the user's message and, if triggered,
 * appends an ephemeral system-role steering message (Claude Opus 4.8's
 * mid-conversation system message support — see shared/prompt-caching.md).
 * Never persisted to the DB: it applies only to this turn's API calls, not
 * to conversation history, so it doesn't linger into later turns.
 */
function applyEscalationNudge(
  messages: Anthropic.MessageParam[],
  userText: string,
  sessionId: string,
  context: TurnContext
): EscalationSignal {
  const signal = detectFrustrationSignals(userText, context);
  if (signal.flagged) {
    console.log(`[escalation] session=${sessionId} reasons=${signal.reasons.join(", ")}`);
    messages.push({
      role: "system",
      content: `The customer's message shows signs of frustration or distress (${signal.reasons.join(
        ", "
      )}). Prioritize offering to transfer them to a human staff member unless you're confident you can fully resolve this yourself right now.`,
    });
  }
  return signal;
}

export interface AgentTurnResult {
  reply: string;
  transferred: boolean;
  escalationReasons?: string[];
}

export async function runAgentTurn(
  sessionId: string,
  userText: string,
  context: TurnContext = {}
): Promise<AgentTurnResult> {
  const client = getAnthropicClient();

  const userMessage: Anthropic.MessageParam = { role: "user", content: userText };
  appendMessage(sessionId, userMessage);

  const messages: Anthropic.MessageParam[] = [...getConversation(sessionId)];
  const escalation = applyEscalationNudge(messages, userText, sessionId, context);
  const escalationReasons = escalation.flagged ? escalation.reasons : undefined;

  let transferred = false;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(),
        tools,
        output_config: { effort: "low" },
        messages,
      });
    } catch (err) {
      return { ...describeAgentError(err), escalationReasons };
    }

    console.log(
      `\n[agent] turn iteration=${iteration} stop_reason=${response.stop_reason} usage=${JSON.stringify(
        response.usage
      )}`
    );

    const assistantMessage: Anthropic.MessageParam = {
      role: "assistant",
      content: response.content,
    };
    appendMessage(sessionId, assistantMessage);
    messages.push(assistantMessage);

    if (response.stop_reason === "refusal") {
      return {
        reply: "Sorry, I'm not able to help with that. Let me get you a person to talk to.",
        transferred: true,
        escalationReasons,
      };
    }

    if (response.stop_reason !== "tool_use") {
      const reply = extractText(response.content);
      return { reply, transferred, escalationReasons };
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const result = executeTool(block.name, block.input);
      logToolCall(sessionId, block.name, block.input, result);
      if (result.transferred) transferred = true;

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      });
    }

    const toolResultMessage: Anthropic.MessageParam = { role: "user", content: toolResults };
    appendMessage(sessionId, toolResultMessage);
    messages.push(toolResultMessage);
  }

  return {
    reply: "Sorry, I'm having trouble finishing that up. Let me get a person to help you.",
    transferred: true,
    escalationReasons,
  };
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export interface AgentStreamEvent {
  type: "text_delta" | "tool_call" | "tool_result" | "escalation_detected" | "done" | "error";
  text?: string;
  name?: string;
  input?: unknown;
  isError?: boolean;
  reply?: string;
  transferred?: boolean;
  message?: string;
  reasons?: string[];
}

/**
 * Streaming counterpart to runAgentTurn, for the real-time UI: emits a
 * text_delta as each token of assistant text arrives (so the client can
 * start speaking a sentence before the full reply is done), plus tool_call/
 * tool_result/escalation_detected markers and a final done event. Same tool
 * loop, system prompt, and DB persistence as runAgentTurn — only the
 * transport differs. Any error from the Claude call is caught and turned
 * into a graceful "done" event rather than an unhandled rejection, so a
 * flaky API call degrades the call instead of dropping it.
 */
export async function runAgentTurnStream(
  sessionId: string,
  userText: string,
  emit: (event: AgentStreamEvent) => void,
  context: TurnContext = {}
): Promise<void> {
  const client = getAnthropicClient();

  const userMessage: Anthropic.MessageParam = { role: "user", content: userText };
  appendMessage(sessionId, userMessage);

  const messages: Anthropic.MessageParam[] = [...getConversation(sessionId)];
  const escalation = applyEscalationNudge(messages, userText, sessionId, context);
  if (escalation.flagged) {
    emit({ type: "escalation_detected", reasons: escalation.reasons });
  }

  let transferred = false;
  let fullReplyText = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let response: Anthropic.Message;
    try {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(),
        tools,
        output_config: { effort: "low" },
        messages,
      });

      stream.on("text", (delta) => {
        fullReplyText += delta;
        emit({ type: "text_delta", text: delta });
      });

      response = await stream.finalMessage();
    } catch (err) {
      const outcome = describeAgentError(err);
      emit({ type: "done", reply: outcome.reply, transferred: outcome.transferred });
      return;
    }

    console.log(
      `\n[agent] turn iteration=${iteration} stop_reason=${response.stop_reason} usage=${JSON.stringify(
        response.usage
      )}`
    );

    const assistantMessage: Anthropic.MessageParam = {
      role: "assistant",
      content: response.content,
    };
    appendMessage(sessionId, assistantMessage);
    messages.push(assistantMessage);

    if (response.stop_reason === "refusal") {
      emit({
        type: "done",
        reply: "Sorry, I'm not able to help with that. Let me get you a person to talk to.",
        transferred: true,
      });
      return;
    }

    if (response.stop_reason !== "tool_use") {
      const reply = fullReplyText.trim() || extractText(response.content);
      emit({ type: "done", reply, transferred });
      return;
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      emit({ type: "tool_call", name: block.name, input: block.input });
      const result = executeTool(block.name, block.input);
      logToolCall(sessionId, block.name, block.input, result);
      if (result.transferred) transferred = true;
      emit({ type: "tool_result", name: block.name, isError: result.isError });

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      });
    }

    const toolResultMessage: Anthropic.MessageParam = { role: "user", content: toolResults };
    appendMessage(sessionId, toolResultMessage);
    messages.push(toolResultMessage);
  }

  emit({
    type: "done",
    reply: "Sorry, I'm having trouble finishing that up. Let me get a person to help you.",
    transferred: true,
  });
}
