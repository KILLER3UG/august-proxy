/* ── ImportMemoryDialog ──────────────────────────────────────────────────── */
/* Bulk-import facts from another AI's memory export.                        */
/*                                                                           */
/* Supports four input shapes:                                               */
/*   1. August's own Markdown export — `---` frontmatter entries             */
/*      (`name:` / `description:` / `type:` / `updated:` + body)             */
/*   2. Claude memory dumps — plain sentence bullets (`- Prefers …`),        */
/*      with headings kept as category hints                                 */
/*   3. Generic Markdown bullet lists (`- key: value`, numbered items,       */
/*      `- [Title](file) — hook` index rows)                                 */
/*   4. JSON arrays of { key, value, ... } or Claude's { fact, details }     */
/*                                                                           */
/* The parsed entries are shown in a preview table; the user picks a         */
/* provider label (e.g. "claude", "chatgpt") and a default category, then   */
/* confirms the import. Each row is persisted with a per-row `source` of     */
/* `imported:<provider>` so the Memory UI can badge imported rows.          */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FileUp, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { cn } from '@/lib/utils';

interface ParsedEntry {
  /** Stable id used by the React list (file basename + line index). */
  uid: string;
  key: string;
  value: string;
  category: string;
  /** Per-row confidence; 0–1. The Markdown parser leaves this undefined. */
  confidence?: number;
}

interface ImportResult {
  ok: boolean;
  count: number;
  total: number;
  results: Array<{ index: number; key: string; category: string; source: string }>;
  failed: Array<{ index: number; error: string }>;
}

const CATEGORIES = ['user', 'feedback', 'project', 'reference', 'general'] as const;
type Category = (typeof CATEGORIES)[number];

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB — generous for memory exports

function slugifyKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 64);
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith('[') || t.startsWith('{');
}

function tryParseJsonEntries(text: string): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
    }
    if (parsed && typeof parsed === 'object') {
      // Common wrapper: { items: [...] } or { memories: [...] } or { facts: [...] }
      const obj = parsed as Record<string, unknown>;
      for (const key of ['items', 'memories', 'facts', 'entries', 'data']) {
        const v = obj[key];
        if (Array.isArray(v)) {
          return v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
        }
      }
    }
  } catch {
    /* fall through to MD parser */
  }
  return null;
}

/** Strip lightweight Markdown emphasis so derived keys/values read clean. */
function stripMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim();
}

/** Derive a stable fact key from free text: first words, slugified. */
function deriveKey(text: string): string {
  const cleaned = stripMd(text).replace(/[.!?;:,\u2026]+\s*$/g, '');
  return slugifyKey(cleaned.split(/\s+/).slice(0, 6).join(' '));
}

/** Horizontal rules, fence markers — never entries on their own. */
const NOISE_LINE = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|```|~~~)\s*$/;

/** `- [Title](target) — hook` memory-index bullet. */
const LINK_BULLET = /^\[([^\]]+)\]\([^)]*\)\s*(?:[—–:]\s*(.+))?$/;

/** Explicit `key: value` separator inside a bullet. */
const KV_BULLET = /^(.+?)\s*[:—–]\s+(.+)$/;

function parseBulletLine(line: string, categoryHint: string, uid: string): ParsedEntry | null {
  if (!line || NOISE_LINE.test(line)) return null;
  // Bullet markers: -, *, •, or numbered "1." / "1)".
  const bullet = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+)$/.exec(line);
  if (!bullet) return null;
  const text = stripMd(bullet[1]).trim();
  if (!text) return null;

  // "- [Title](file.md) — hook" (memory-index style): title → key, hook → value.
  const link = LINK_BULLET.exec(text);
  if (link) {
    const key = slugifyKey(link[1]);
    const value = (link[2] ?? '').trim() || link[1].trim();
    if (!key || !value) return null;
    return { uid, key, value, category: normalizeCategory(categoryHint) };
  }

  // "- key: value" / "- key — value". A digit right before the separator is
  // a time or ratio ("at 3:00 pm"), not a label — keep those whole.
  const kv = KV_BULLET.exec(text);
  if (kv && !/\d$/.test(kv[1]) && kv[1].length <= 48) {
    const key = slugifyKey(kv[1]);
    const value = kv[2].trim();
    if (key && value) return { uid, key, value, category: normalizeCategory(categoryHint) };
  }

  // Plain sentence bullet (Claude memory dumps): the whole text is the
  // value; the key is derived from the first words.
  const key = deriveKey(text);
  if (!key) return null;
  return { uid, key, value: text, category: normalizeCategory(categoryHint) };
}

/** Field names August's own export writes into a frontmatter block. */
const FRONTMATTER_FIELDS = new Set([
  'name', 'description', 'type', 'updated', 'key', 'category', 'source', 'fact', 'details',
]);

/** Parse a segment as a `---` frontmatter block: every non-empty line must
 *  be a `field: value` pair and at least one field must be a known one, so a
 *  list of plain "Key: value" sentences is never mistaken for frontmatter. */
function parseFrontmatterFields(segment: string): Record<string, string> | null {
  const lines = segment.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!m || line.startsWith('-') || line.startsWith('*')) return null;
    fields[m[1].toLowerCase()] = m[2].trim();
  }
  return Object.keys(fields).some((k) => FRONTMATTER_FIELDS.has(k)) ? fields : null;
}

/** Later duplicates overwrite earlier ones — matches save_fact's upsert on key. */
function dedupeByKey(entries: ParsedEntry[]): ParsedEntry[] {
  const seen = new Map<string, ParsedEntry>();
  for (const e of entries) seen.set(e.key, e);
  return [...seen.values()];
}

function parseMarkdownEntries(text: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  // August's own export wraps each entry in a `---` frontmatter block and
  // joins entries with `---`, so split on horizontal rules and classify
  // each segment; everything else falls through to the bullet parser.
  const segments = text.split(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m);
  let pending: { fields: Record<string, string>; hint: string; uid: string } | null = null;
  let bodyParts: string[] = [];
  let headingHint = '';

  const flushPending = () => {
    if (!pending) return;
    const f = pending.fields;
    const value = (bodyParts.join('\n\n').trim()) || f.description || f.fact || '';
    const key = slugifyKey(f.name || f.key || '') || deriveKey(value);
    if (key && value.trim()) {
      out.push({
        uid: pending.uid,
        key,
        value: value.trim(),
        category: normalizeCategory(f.category || f.type || pending.hint),
      });
    }
    pending = null;
    bodyParts = [];
  };

  segments.forEach((segment, si) => {
    const fields = parseFrontmatterFields(segment);
    if (fields) {
      flushPending();
      pending = { fields, hint: headingHint, uid: `md-fm-${si}` };
      return;
    }
    if (pending) {
      const body = segment.trim();
      if (body) bodyParts.push(body);
      return;
    }
    // No pending frontmatter: parse bullets line by line, with headings as
    // category hints and indented lines as continuations of the last bullet.
    let inFence = false;
    let last: ParsedEntry | null = null;
    const lines = segment.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trimEnd();
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        last = null;
        continue;
      }
      if (inFence) continue;
      const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        headingHint = heading[1];
        last = null;
        continue;
      }
      const entry = parseBulletLine(line, headingHint, `md-${si}-${i}`);
      if (entry) {
        out.push(entry);
        last = entry;
        continue;
      }
      if (last && /^\s{2,}\S/.test(line)) {
        last.value += `\n${line.trim()}`;
        continue;
      }
      last = null;
    }
  });
  flushPending();
  return dedupeByKey(out);
}

function normalizeCategory(raw: string): Category {
  const s = slugifyKey(raw).toLowerCase();
  if ((CATEGORIES as readonly string[]).includes(s)) return s as Category;
  // Map common synonyms.
  if (s.startsWith('user') || s.includes('profile') || s.includes('work-context')) return 'user';
  if (s.includes('feedback') || s.includes('preference') || s.includes('rule')) return 'feedback';
  if (s.includes('project') || s.includes('task') || s.includes('trading')) return 'project';
  if (s.includes('reference') || s.includes('book') || s.includes('doc')) return 'reference';
  return 'general';
}

/** Parse a memory-export file (.md / .json) into preview entries.
 *  Exported for tests — the dialog renders the result for review before
 *  anything is persisted. */
export function parseMemoryImportEntries(text: string, source: string): ParsedEntry[] {
  if (looksLikeJson(text)) {
    const arr = tryParseJsonEntries(text);
    if (arr) {
      const parsed = arr
        .map((item, idx): ParsedEntry | null => {
          const keyRaw = (item.key ?? item.factKey ?? item.fact ?? item.title ?? '') as
            | string
            | undefined;
          const key = slugifyKey(String(keyRaw ?? ''));
          if (!key) return null;
          let value: string;
          const v = item.value;
          if (typeof v === 'string') value = v;
          else if (v && typeof v === 'object') {
            // Claude / August {fact, details} shape — flatten for the preview.
            const obj = v as Record<string, unknown>;
            const fact = obj.fact;
            const details = obj.details;
            value =
              (typeof fact === 'string' ? fact : '') +
              (details && typeof details === 'string' && details.trim()
                ? `\n\n${details.trim()}`
                : '');
          } else {
            value = v == null ? '' : String(v);
          }
          if (!value.trim()) return null;
          const cat = normalizeCategory(String(item.category ?? ''));
          const conf = typeof item.confidence === 'number' ? item.confidence : undefined;
          return { uid: `${source}-${idx}`, key, value: value.trim(), category: cat, confidence: conf };
        })
        .filter((x): x is ParsedEntry => x !== null);
      return dedupeByKey(parsed);
    }
  }
  return parseMarkdownEntries(text);
}

export function ImportMemoryDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [entries, setEntries] = useState<ParsedEntry[] | null>(null);
  const [provider, setProvider] = useState('claude');
  const [defaultCategory, setDefaultCategory] = useState<Category>('general');
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset state whenever the dialog re-opens (so previous parses don't leak).
  useEffect(() => {
    if (!open) {
      setFileName(null);
      setEntries(null);
      setParseError(null);
      setImporting(false);
    }
  }, [open]);

  const providerSource = useMemo(() => {
    const p = (provider || '').trim().toLowerCase().replace(/[^\w-]/g, '');
    return p ? `imported:${p}` : 'imported';
  }, [provider]);

  const groupedCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of entries ?? []) {
      counts[e.category] = (counts[e.category] ?? 0) + 1;
    }
    return counts;
  }, [entries]);

  async function handleFile(file: File) {
    setParseError(null);
    if (file.size > MAX_FILE_BYTES) {
      setParseError(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MiB > 5 MiB).`);
      return;
    }
    const text = await file.text();
    const parsed = parseMemoryImportEntries(text, file.name);
    if (parsed.length === 0) {
      setParseError(
        'No entries found. The file should be a Markdown bullet list, an August export, or a JSON array of {key, value}.',
      );
      setEntries(null);
      setFileName(file.name);
      return;
    }
    setEntries(parsed);
    setFileName(file.name);
  }

  function applyCategoryOverride() {
    if (!entries) return;
    setEntries(entries.map((e) => ({ ...e, category: defaultCategory })));
  }

  async function doImport() {
    if (!entries || entries.length === 0) return;
    setImporting(true);
    try {
      const items = entries.map((e) => ({
        key: e.key,
        value: e.value,
        category: e.category,
        source: providerSource,
        ...(typeof e.confidence === 'number' ? { confidence: e.confidence } : {}),
      }));
      const res = await api.post<ImportResult>('/api/august/memory/import', {
        items,
        defaultCategory,
        defaultSource: providerSource,
      });
      const failed = res?.failed?.length ?? 0;
      const ok = res?.count ?? 0;
      if (failed > 0) {
        toast.warning(`Imported ${ok} of ${res?.total ?? items.length} entries`, {
          description: `${failed} failed — check the response body.`,
        });
      } else {
        toast.success(`Imported ${ok} ${ok === 1 ? 'entry' : 'entries'} from ${provider || 'import'}`);
      }
      onImported();
      onClose();
    } catch (err) {
      toast.error(`Import failed: ${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Import memory from another AI"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="flex items-center gap-2">
            <FileUp className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Import memory from another AI</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <p className="text-xs text-muted-foreground">
            Drop a <code className="font-mono">.md</code> or <code className="font-mono">.json</code>{' '}
            memory export. Supported: August's own export, Claude memory dumps, generic
            <code className="font-mono"> {'{ key, value }'} </code> JSON arrays, and
            <code className="font-mono"> - key: value </code> bullet lists.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.json,.txt,text/markdown,application/json,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/60 px-3 py-1.5 text-xs text-foreground hover:border-primary/40"
            >
              <Upload className="size-3.5" /> Choose file…
            </button>
            {fileName && (
              <span className="text-[11px] text-muted-foreground" title={fileName}>
                {fileName}
              </span>
            )}
          </div>

          {parseError && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {parseError}
            </div>
          )}

          {entries && entries.length > 0 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">Source label</span>
                  <input
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder="claude, chatgpt, …"
                    className="w-full rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-xs outline-none focus:border-primary/40"
                  />
                  <span className="block text-[10px] text-muted-foreground/80">
                    Stored as <code className="font-mono">{providerSource}</code> on each row.
                  </span>
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-muted-foreground">Default category</span>
                  <div className="relative">
                    <select
                      value={defaultCategory}
                      onChange={(e) => setDefaultCategory(e.target.value as Category)}
                      className="w-full appearance-none rounded-md border border-border/60 bg-background/60 px-2 py-1.5 pr-7 text-xs outline-none focus:border-primary/40"
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                  </div>
                  <button
                    type="button"
                    onClick={applyCategoryOverride}
                    className="text-[10px] text-primary hover:underline"
                    title="Apply the default category to every parsed row"
                  >
                    apply to all rows
                  </button>
                </label>
              </div>

              <div className="rounded-lg border border-border/60 bg-card/40">
                <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
                  <span>
                    {entries.length} parsed ·{' '}
                    {Object.entries(groupedCount)
                      .map(([k, v]) => `${k}:${v}`)
                      .join(' · ')}
                  </span>
                  <span className="text-[10px] text-muted-foreground/70">
                    source: <code className="font-mono">{providerSource}</code>
                  </span>
                </div>
                <ul className="max-h-72 divide-y divide-border/40 overflow-y-auto">
                  {entries.slice(0, 50).map((e) => (
                    <li
                      key={e.uid}
                      className={cn(
                        'flex items-start gap-3 px-3 py-2 text-xs',
                        e.key.length === 0 && 'bg-destructive/5',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[11px] text-foreground/90">{e.key}</div>
                        <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                          {e.value}
                        </div>
                      </div>
                      <select
                        value={e.category}
                        onChange={(ev) => {
                          const next = ev.target.value as Category;
                          setEntries((prev) =>
                            prev ? prev.map((p) => (p.uid === e.uid ? { ...p, category: next } : p)) : prev,
                          );
                        }}
                        className="rounded border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] outline-none focus:border-primary/40"
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
                {entries.length > 50 && (
                  <div className="border-t border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
                    showing 50 of {entries.length} — all will be imported
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-muted/20 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={doImport}
            disabled={!entries || entries.length === 0 || importing}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            {importing && <Loader2 className="size-3 animate-spin" />}
            {importing
              ? 'Importing…'
              : entries && entries.length > 0
                ? `Import ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`
                : 'Import'}
          </button>
        </footer>
      </div>
    </div>
  );
}
