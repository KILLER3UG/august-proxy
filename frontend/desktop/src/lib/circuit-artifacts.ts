/* ── Circuit artifact extraction ────────────────────────────────────────── *
 * One source of truth for "which files did this circuit tool produce", used
 * by the chat deliverable cards, the Circuit panel's artifact list and the
 * waveform picker.
 *
 * The distinguishing detail: results, not arguments, name what a tool wrote.
 * `block.tool.context` has always carried the model's INPUT
 * (`makeStreamHandlers.onToolUse` → `JSON.stringify(input)`), and the
 * `toolResult` reducer branch never touches it — so collectors that parsed
 * `context` for `savedTo` / `waveFile` / `svgFile` only found a path when the
 * caller happened to pass one. These collectors now read `message.tools[]`,
 * the same record `CircuitInstruments` already parses successfully.
 */

/** The subset of `ChatMessage['tools']` this module needs. */
export interface CircuitToolEntry {
  name?: string;
  context?: string;
  status?: string;
  /** Full, untruncated result text — see `makeStreamHandlers.onToolResult`. */
  result?: string;
  startedAt?: number;
}

export interface CircuitArtifact {
  path: string;
  /** Basename with forward slashes — what the row label shows. */
  label: string;
  tool: string;
  startedAt: number;
  /** Tool arguments merged with the parsed result; the result wins. */
  data: Record<string, unknown>;
}

const CIRCUIT_TOOLS = /^(circuit_|firmware_|hdl_|vcd_parse|fpga_compile|kicad_)/i;
export const NETLIST_EXT = /\.(cir|net|ckt|sp)$/i;
export const WAVEFORM_EXT = /\.(vcd|fst|ghw)$/i;
export const BINARY_ARTIFACT_EXT = /\.(sof|pof|glb|uf2)$/i;

/** A deletion produced nothing worth surfacing — the old key list happily
 *  listed the deck `circuit_delete_netlist` had just removed. */
const DESTROYING_TOOLS = /^circuit_delete_netlist$/i;

/** Ordered by "what did this tool actually produce", then the caller-chosen
 *  output path. `hexFile` / `vcdFile` / `tracesFile`-style keys are results;
 *  `path` is an argument on the render tools and a result elsewhere, so it
 *  sits after `savedTo`. */
const ARTIFACT_KEYS = [
  'savedTo',
  'svgFile',
  'waveFile',
  'vcdFile',
  'junitFile',
  'sofFile',
  'renderedFile',
  'hexFile',
  'path',
  'filePath',
] as const;

/** The drawer re-derives its list on every stream tick, so a pathological
 *  result must not turn a render into a JSON parse of hundreds of KB. */
const MAX_PARSE_CHARS = 500_000;

/** Results repeat verbatim across ticks; caching keeps that off the hot path. */
const jsonCache = new Map<string, Record<string, unknown> | null>();
const JSON_CACHE_MAX = 128;

function readJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (!text || text.length > MAX_PARSE_CHARS) return null;
  if (jsonCache.has(text)) return jsonCache.get(text) ?? null;
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = JSON.parse(text) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    /* not JSON — the tool returned prose */
  }
  if (jsonCache.size >= JSON_CACHE_MAX) jsonCache.clear();
  jsonCache.set(text, parsed);
  return parsed;
}

function firstString(source: Record<string, unknown> | null): string | null {
  if (!source) return null;
  for (const key of ARTIFACT_KEYS) {
    const v = source[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** Result JSON over argument JSON — a result key is what the tool wrote. */
export function artifactFields(entry: CircuitToolEntry): Record<string, unknown> {
  const args = readJsonObject(entry.context);
  const result = readJsonObject(entry.result);
  return { ...(args ?? {}), ...(result ?? {}) };
}

/** Artifacts from one assistant message's tool run, oldest first, deduped by
 *  path (first occurrence wins — the waveform picker sorts afterwards). */
export function collectArtifacts(
  tools?: CircuitToolEntry[] | null,
): CircuitArtifact[] {
  if (!tools?.length) return [];
  const seen = new Set<string>();
  const out: CircuitArtifact[] = [];
  for (const entry of tools) {
    const name = entry.name || '';
    if (!CIRCUIT_TOOLS.test(name) || DESTROYING_TOOLS.test(name)) continue;
    // An errored tool wrote nothing; `result` still carries the failure text.
    if (entry.status && entry.status !== 'done') continue;
    const data = artifactFields(entry);
    const path = firstString(data);
    if (!path) continue;
    const key = path.replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path,
      label: key.split('/').pop() || path,
      tool: name.replace(/^(?:@[^:]+:)/, ''),
      startedAt: entry.startedAt ?? 0,
      data,
    });
  }
  return out;
}

/** Artifacts across a whole session. Deduped by path GLOBALLY, not per
 *  message — one deck re-simulated in five turns is one artifact, and the
 *  panel's count badge must not read five. */
export function artifactsForMessages(
  messages?: Array<{ tools?: CircuitToolEntry[] | null }> | null,
): CircuitArtifact[] {
  if (!messages?.length) return [];
  const seen = new Set<string>();
  const out: CircuitArtifact[] = [];
  for (const art of messages.flatMap((m) => collectArtifacts(m.tools))) {
    const key = art.path.replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(art);
  }
  return out;
}
