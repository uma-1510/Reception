export interface EscalationSignal {
  flagged: boolean;
  reasons: string[];
}

const ANGER_PATTERN =
  /\b(ridiculous|unacceptable|terrible|awful|horrible|worst|useless|pointless|waste of (my )?time|forget it|screw this|sick of this|fed up|furious|so angry|this is insane|i give up)\b/i;

const MILD_PROFANITY_PATTERN = /\b(damn|hell|crap|bullsh\w*)\b/i;

const DISTRESS_PATTERN =
  /\b(emergency|urgent(ly)?|in (severe |so much |a lot of )?pain|bleeding|can'?t breathe|dying|passed out)\b/i;

const REPETITION_PATTERN =
  /\b(i (already|just) (told|said)|for the (second|third|\d+(th|rd|nd)) time|i said that already|again\?!|how many times)\b/i;

// A shouted word of 4+ letters, excluding common short-form acronyms that
// aren't actually shouting (ASAP, APPT, ETA, ...).
const COMMON_ACRONYMS = new Set(["ASAP", "APPT", "ETA", "OK", "ID"]);
const SHOUTING_PATTERN = /\b[A-Z]{4,}\b/g;

const MULTI_EXCLAMATION_PATTERN = /!{2,}/;

function hasShouting(text: string): boolean {
  const matches = text.match(SHOUTING_PATTERN);
  if (!matches) return false;
  return matches.some((word) => !COMMON_ACRONYMS.has(word));
}

/**
 * Deterministic, text-pattern-based frustration/distress detector. Not meant
 * to be a hard override — it feeds a soft nudge into the system prompt for
 * that turn (see orchestrator.ts), leaving the actual transfer_to_human
 * decision to the model. False positives here just bias the model toward
 * offering a transfer, not force one.
 */
export function detectFrustrationSignals(
  text: string,
  context: { consecutiveBargeIns?: number } = {}
): EscalationSignal {
  const reasons: string[] = [];

  if (ANGER_PATTERN.test(text)) reasons.push("negative/angry language");
  if (MILD_PROFANITY_PATTERN.test(text)) reasons.push("profanity");
  if (DISTRESS_PATTERN.test(text)) reasons.push("possible medical/urgent distress");
  if (REPETITION_PATTERN.test(text)) reasons.push("repeated complaint");
  if (hasShouting(text)) reasons.push("shouting (all caps)");
  if (MULTI_EXCLAMATION_PATTERN.test(text)) reasons.push("emphatic punctuation");

  const bargeIns = context.consecutiveBargeIns ?? 0;
  if (bargeIns >= 3) reasons.push(`interrupted the agent ${bargeIns} times`);

  return { flagged: reasons.length > 0, reasons };
}
