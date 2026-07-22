export interface ContextBreakdown {
  messages: number;
  thinking: number;
  systemTools: number;
  systemPrompt: number;
  skills: number;
  meta: number;
}

/**
 * Estimate per-category context consumption from the raw inputs that
 * ChatThread has on hand. Returns a number-of-tokens value for each
 * category. The total should approximately equal `estTokens` (the
 * visible donut's numerator).
 *
 * Accuracy model: once a provider request has completed, the *true* current
 * context fill is the provider-reported `input_tokens` (captured by the
 * backend as `contextTokens` and surfaced to the gauge). The category
 * breakdown here is informational only — it is NOT the source of truth for
 * the ring percentage. Previously this function double-counted by adding
 * `thinking = messages * 0.15` on top of message content that already
 * includes thinking text, and by adding a flat `systemPrompt = 3000`
 * regardless of real size. Both are removed.
 *
 * Pass `scaleToTotal` (the server ground-truth total) when available: the
 * category estimates are proportionally scaled so `sum(categories) ===
 * scaleToTotal`, keeping the tooltip breakdown perfectly consistent with
 * the ring's numerator.
 */
export function estimateContextBreakdown(args: {
  messages: Array<{
    content: string;
    role: string;
    thinking?: string;
    blocks?: Array<{
      type?: string;
      content?: string;
      tool?: { args?: string; preview?: string; summary?: string };
    }>;
  }>;
  input: string;
  /** Number of available tool definitions the model can call. */
  toolCount: number;
  /** Optional: actual estimated token count of all serialized tool definitions
   *  (name + description + input_schema). When provided, this replaces the
   *  `toolCount * 180` heuristic with a real backend-calculated estimate. */
  toolTokenEstimate?: number;
  /** Optional: bytes of core memory / skills injected into the prompt. */
  coreMemoryBytes?: number;
  /** Optional ground-truth total to anchor the breakdown to. When provided,
   *  the category estimates are scaled so they sum exactly to this value
   *  (used when the backend reports the real current context fill). */
  scaleToTotal?: number;
}): ContextBreakdown {
  let messagesChars = args.input.length;
  let thinkingChars = 0;
  for (const m of args.messages) {
    if (m.blocks?.length) {
      let hasThinkingBlock = false;
      for (const b of m.blocks) {
        const len = b.content?.length ?? 0;
        if (b.type === 'thinking') {
          thinkingChars += len;
          hasThinkingBlock = true;
        } else {
          messagesChars += len;
        }
        if (b.tool) {
          messagesChars +=
            (b.tool.args?.length ?? 0) +
            (b.tool.preview?.length ?? 0) +
            (b.tool.summary?.length ?? 0);
        }
      }
      if (!hasThinkingBlock) thinkingChars += m.thinking?.length ?? 0;
    } else {
      messagesChars += m.content?.length ?? 0;
      thinkingChars += m.thinking?.length ?? 0;
    }
  }
  const messages = Math.ceil(messagesChars / 4);
  const thinking = Math.ceil(thinkingChars / 4);
  // Use the backend's actual serialized tool token estimate when available;
  // fall back to ~180 tokens per tool definition (name + description + JSON schema).
  const systemTools = args.toolTokenEstimate ?? Math.ceil(args.toolCount * 180);
  // System prompt is part of the provider-reported input_tokens when a ground
  // truth exists, so we do not add a separate flat constant that would inflate
  // the pre-request heuristic. Keep a small constant only for the fallback so
  // the tooltip has a non-zero row to display; it is scaled away when
  // `scaleToTotal` is provided.
  const systemPrompt = args.scaleToTotal != null ? 0 : 1200;
  const skills = Math.ceil((args.coreMemoryBytes ?? 0) / 4);
  const meta = 100; // session metadata, attachments index, etc.

  const raw = { messages, thinking, systemTools, systemPrompt, skills, meta };
  const scaleToTotal = args.scaleToTotal;
  if (scaleToTotal == null) return raw;

  // Scale categories to sum exactly to the server ground-truth total.
  const rawTotal =
    raw.messages + raw.thinking + raw.systemTools + raw.systemPrompt + raw.skills + raw.meta;
  if (rawTotal <= 0) {
    // No heuristic signal at all — attribute everything to messages.
    return { messages: scaleToTotal, thinking: 0, systemTools: 0, systemPrompt: 0, skills: 0, meta: 0 };
  }
  const factor = scaleToTotal / rawTotal;
  const scaled = {
    messages: Math.round(raw.messages * factor),
    thinking: Math.round(raw.thinking * factor),
    systemTools: Math.round(raw.systemTools * factor),
    systemPrompt: Math.round(raw.systemPrompt * factor),
    skills: Math.round(raw.skills * factor),
    meta: 0, // fold rounding remainder into messages so the sum is exact
  };
  const scaledTotal =
    scaled.messages + scaled.thinking + scaled.systemTools + scaled.systemPrompt + scaled.skills + scaled.meta;
  scaled.messages += scaleToTotal - scaledTotal; // exact-sum correction
  return scaled;
}
