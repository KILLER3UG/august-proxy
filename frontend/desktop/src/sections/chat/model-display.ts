/* ── Model display helpers (pure) ─────────────────────────────────────── */
/* Pretty names, context-window labels, and variant tags for model UIs.   */

export interface ModelItem {
  id: string;
  name: string;
  provider: string;
  /** Tokens; defaults to 128k when the provider model has no override. */
  contextWindow: number;
  isFree?: boolean;
  /** User-pinned models always sort to the top (settings + dropdown). */
  pinned?: boolean;
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

export function modelDisplayParts(id: string | null | undefined): { name: string; tag: string } {
  // Sessions can carry an unset model (legacy rows, chats that never sent a
  // turn). Sidebar rows call this unconditionally for status lines — a throw
  // here blackens the whole app (no boundary below the root).
  if (!id) return { name: '', tag: '' };
  const sepIdx = id.search(/[/:]/);
  const prefix = sepIdx >= 0 ? id.slice(0, sepIdx) : '';
  const base = stripProviderPrefix(id);

  // OpenRouter and Kilo carry the tier as a COLON suffix (`poolside/laguna-s-2.1:free`)
  // where every other catalog uses a hyphen (`…-free`). The hyphen form was the only
  // one VARIANT_TAGS knew, so the colon form fell through to titleCase and rendered
  // as "Laguna S 2.1:Free" — the tier glued to the name with a capital F.
  //
  // The peel only sees a colon suffix that survives `stripProviderPrefix`, which
  // cuts at the FIRST `[/:]` — so a bare `laguna-s-2.1:free` (no vendor prefix)
  // still parses as vendor `laguna-s-2.1` + model `free`. Every entry in the live
  // catalog is vendor-prefixed, so that case is documented rather than handled:
  // changing `stripProviderPrefix` would move `getModelDisplayName`, which sorts
  // the pickers and labels sessions.
  const tier = /:([\w.-]+)$/.exec(base);
  const suffix = tier ? titleCase(tier[1]) : '';
  let cleaned = tier ? base.slice(0, tier.index) : base;

  // `Preview` from `…-preview`, plus whatever the colon suffix carried.
  const joinTag = (variant: string) => {
    const text = [variant, suffix].filter(Boolean).join(' ');
    if (!prefix) return text;
    return text ? `${prefix}:${text}` : prefix;
  };

  for (const [pattern, label] of VARIANT_TAGS) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '');
      return {
        name: prettifyBase(cleaned) || id,
        tag: joinTag(label),
      };
    }
  }

  return {
    name: prettifyBase(cleaned) || id,
    tag: joinTag(''),
  };
}

export function getModelDisplayName(id: string): string {
  return stripProviderPrefix(id);
}

/** Shared model ranking: pinned first, then free, then display name.
 *  Used by the composer dropdown and the model settings lists so pinning
 *  a model has the same effect everywhere. */
export function compareModelsRanked(
  a: { id: string; isFree?: boolean; pinned?: boolean },
  b: { id: string; isFree?: boolean; pinned?: boolean },
): number {
  if (a.pinned && !b.pinned) return -1;
  if (!a.pinned && b.pinned) return 1;
  if (a.isFree && !b.isFree) return -1;
  if (!a.isFree && b.isFree) return 1;
  return getModelDisplayName(a.id).localeCompare(getModelDisplayName(b.id));
}

/** Model ids are NOT unique across gateways. The live catalog lists
 *  `stepfun/step-3.7-flash` under both OpenRouter and KiloCode (and
 *  `openrouter/auto` under both too), with OpenRouter first in the aggregate. An
 *  id-only lookup therefore re-points a session at a gateway the user never
 *  chose — and one persisted id can tick two rows. Prefer the entry that matches
 *  the provider as well; fall back to id alone when none does, because a provider
 *  can be renamed or removed and the model is still the model. */
export function findCatalogModel<T extends { id: string; provider: string }>(
  list: T[],
  id: string,
  provider?: string | null,
): T | undefined {
  const lower = id.toLowerCase();
  const sameId = (m: T) => m.id.toLowerCase() === lower;
  if (provider) {
    const exact = list.find((m) => sameId(m) && m.provider === provider);
    if (exact) return exact;
  }
  return list.find(sameId);
}

/** A `<option value>` that names the GATEWAY as well as the id. Ids repeat
 *  across providers, so an id-only value resolves to whichever match comes first
 *  and two identical ids collide as React keys. encodeURIComponent escapes any
 *  `/` inside either half, so the first unescaped one is the separator. */
export function modelKey(m: { provider: string; id: string }): string {
  return `${encodeURIComponent(m.provider)}/${encodeURIComponent(m.id)}`;
}

/** The pair a `modelKey` encodes. Anything that is not a key — a bare id stored
 *  before this existed — comes back with an empty provider, so the caller's
 *  lookup falls back to matching on id alone. */
export function parseModelKey(key: string): { id: string; provider: string } {
  const sep = key.indexOf('/');
  if (sep <= 0) return { id: key, provider: '' };
  return {
    provider: decodeURIComponent(key.slice(0, sep)),
    id: decodeURIComponent(key.slice(sep + 1)),
  };
}

/** Resolve a `modelKey`, or a legacy bare id, against the catalog. */
export function findModelByKey<T extends { id: string; provider: string }>(
  list: T[],
  key: string,
): T | undefined {
  if (!key) return undefined;
  const { id, provider } = parseModelKey(key);
  return (
    findCatalogModel(list, id, provider) ??
    // A preset stored before the key carried a gateway holds a bare id, which can
    // itself contain a `/` (`poolside/laguna-s-2.1:free`).
    (provider ? findCatalogModel(list, key) : undefined)
  );
}

/** Best-effort context window from the model id when catalog/profile is missing.
 * This is a UI PLACEHOLDER only — used by `modelFromSession` before the
 * `/api/models` catalog hydrates. Once the catalog loads, `useChatModels`
 * overrides `contextWindow` with the server-resolved value (which honors the
 * per-model entry from providers.json). The heuristics below are a sensible
 * default for the brief pre-hydration window, NOT the source of truth.
 */
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
