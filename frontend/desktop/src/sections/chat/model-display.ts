/* ── Model display helpers (pure) ─────────────────────────────────────── */
/* Pretty names, context-window labels, and variant tags for model UIs.   */

export interface ModelItem {
  id: string;
  name: string;
  provider: string;
  /** Tokens; defaults to 128k when the provider model has no override. */
  contextWindow: number;
  isFree?: boolean;
  supportsReasoning?: boolean;
  supportsThinking?: boolean;
}

const VARIANT_TAGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-fast$/i, 'Fast'],
  [/-thinking$/i, 'Thinking'],
  [/-preview$/i, 'Preview'],
  [/-latest$/i, 'Latest'],
  [/-free$/i, 'Free'],
];

const titleCase = (text: string): string => text.replace(/\b\w/g, (c) => c.toUpperCase()).trim();

const prettifyBase = (base: string): string => {
  if (/^claude-/i.test(base)) return titleCase(base.replace(/^claude-/i, '').replace(/-/g, ' '));
  if (/^gpt-/i.test(base)) return base.replace(/^gpt-/i, 'GPT-');
  if (/^gemini-/i.test(base)) return base.replace(/^gemini-/i, 'Gemini ').replace(/-/g, ' ');
  if (/^deepseek-/i.test(base)) return titleCase(base.replace(/^deepseek-/i, 'DeepSeek '));
  if (/^llama-/i.test(base)) return titleCase(base.replace(/^llama-/i, 'Llama '));
  if (/^qwen-/i.test(base) || /^qwq-/i.test(base)) return titleCase(base.replace(/-/g, ' '));
  if (/^mistral-/i.test(base)) return titleCase(base.replace(/^mistral-/i, 'Mistral '));
  if (/^minimax-/i.test(base)) return titleCase(base.replace(/^minimax-/i, 'MiniMax '));
  return titleCase(base.replace(/-/g, ' '));
};

export function stripProviderPrefix(id: string): string {
  const sepIdx = id.search(/[/:]/);
  return sepIdx >= 0 ? id.slice(sepIdx + 1) : id;
}

export function isLikelyReasoningModel(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes('o1') ||
    lower.includes('o3') ||
    lower.includes('o4') ||
    lower.includes('reasoner') ||
    lower.includes('thinking') ||
    lower.includes('reasoning') ||
    // Broad Claude / GPT-5 / reasoner families so Effort shows before catalog hydrates.
    lower.includes('claude') ||
    lower.includes('gpt-5') ||
    lower.includes('deepseek') ||
    lower.includes('qwen3') ||
    lower.includes('qwq') ||
    lower.includes('glm-4') ||
    lower.includes('glm-5') ||
    lower.includes('kimi-k2') ||
    lower.includes('grok-4') ||
    lower.includes('grok-3')
  );
}

export function modelFromSession(
  session: { model?: string | null; provider?: string | null } | null,
): ModelItem | null {
  if (!session?.model) return null;
  return {
    id: session.model,
    name: session.model,
    provider: session.provider || '',
    // Placeholder until catalog hydrates — estimateContextWindow fills a
    // sensible family size so the dropdown doesn't always read "128k".
    contextWindow: estimateContextWindow(session.model),
    supportsReasoning: isLikelyReasoningModel(session.model),
    supportsThinking: isLikelyReasoningModel(session.model),
  };
}

export function loadLastModel(): ModelItem | null {
  try {
    const saved = localStorage.getItem('august_last_model');
    return saved ? (JSON.parse(saved) as ModelItem) : null;
  } catch {
    return null;
  }
}

export function modelDisplayParts(id: string): { name: string; tag: string } {
  const sepIdx = id.search(/[/:]/);
  const base = stripProviderPrefix(id);
  let cleaned = base;

  for (const [pattern, label] of VARIANT_TAGS) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '');
      return {
        name: prettifyBase(cleaned) || id,
        tag: sepIdx >= 0 ? `${id.slice(0, sepIdx)}:${label}` : label,
      };
    }
  }

  return {
    name: prettifyBase(cleaned) || id,
    tag: sepIdx >= 0 ? id.slice(0, sepIdx) : '',
  };
}

export function getModelDisplayName(id: string): string {
  return stripProviderPrefix(id);
}

/** Best-effort context window from the model id when catalog/profile is missing. */
export function estimateContextWindow(id?: string | null): number {
  const mid = (id || '').toLowerCase();
  if (!mid) return 128000;
  if (mid.includes('claude')) return 200000;
  if (
    mid.includes('gemini') &&
    ['1.5', '2.0', '2.5', 'pro', 'flash', 'ultra'].some((x) => mid.includes(x))
  ) {
    return 1_000_000;
  }
  if (mid.includes('deepseek-v4') || /deepseek[-_]?v4/.test(mid)) return 1_000_000;
  if (/\b(o1|o3|o4)\b/.test(mid)) return 200000;
  if (mid.includes('gpt-4.1')) return 1_047_576;
  if (mid.includes('gpt-4o') || mid.includes('chatgpt-4o')) return 128000;
  if (mid.includes('deepseek')) return 128000;
  if (mid.includes('kimi') || mid.includes('moonshot')) return 128000;
  if (mid.includes('grok')) return 131072;
  return 128000;
}

export function formatContextWindow(num?: number): string {
  if (!num || num <= 0) return '—';
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num % 1_000_000 === 0 ? 0 : 1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(0)}k`;
  return String(num);
}
