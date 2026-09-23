/* ── Model capability families ────────────────────────────────────────── */
/* What August may put on the wire for a given model id: reasoning_effort, */
/* Anthropic thinking budgets, and the effort tier to default to.          */
/* Writes config.json:modelParams.families through /api/config/model-params */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export interface ModelFamily {
  id: string;
  tokens: string[];
  excludes: string[];
  reasoningEffort: boolean;
  extendedThinking: boolean;
  defaultEffort: string | null;
  maxEffort: string | null;
  source?: string;
}

interface FamiliesResponse {
  operator: ModelFamily[];
  builtin: ModelFamily[];
  rules?: string;
}

const EFFORT_OPTIONS = ['', 'low', 'medium', 'high', 'max'] as const;

const EMPTY: ModelFamily = {
  id: '',
  tokens: [],
  excludes: [],
  reasoningEffort: true,
  extendedThinking: false,
  defaultEffort: '',
  maxEffort: '',
};

async function fetchFamilies(): Promise<FamiliesResponse> {
  const res = await fetch('/api/config/model-params');
  if (!res.ok) throw new Error(`Could not read model capability families (${res.status})`);
  return (await res.json()) as FamiliesResponse;
}

async function saveFamilies(families: ModelFamily[]): Promise<FamiliesResponse> {
  const res = await fetch('/api/config/model-params', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ families }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: { message?: string } } | null;
    throw new Error(detail?.detail?.message || `Could not save families (${res.status})`);
  }
  return (await res.json()) as FamiliesResponse;
}

const list = (text: string): string[] =>
  text
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

interface ResolveResponse {
  modelId: string;
  family: ModelFamily | null;
  reasoningEffort: boolean;
  extendedThinking: boolean;
  defaultEffort: string | null;
  maxEffort: string | null;
}

/** "Why did this model get no thinking budget?" answered from the same table
 *  the harness consults, instead of by reading the config file. */
function FamilyResolver() {
  const [modelId, setModelId] = useState('');
  const trimmed = modelId.trim();
  const { data, isFetching } = useQuery({
    queryKey: ['model-params', 'resolve', trimmed],
    queryFn: async (): Promise<ResolveResponse> => {
      const res = await fetch(`/api/config/model-params/resolve?modelId=${encodeURIComponent(trimmed)}`);
      if (!res.ok) throw new Error('Could not resolve this model id');
      return (await res.json()) as ResolveResponse;
    },
    enabled: trimmed.length > 0,
  });

  return (
    <div className="space-y-1.5">
      <label className="block space-y-1 max-w-md">
        <span className="text-[11px] text-muted-foreground">
          Check what a model id gets — paste one from your provider
        </span>
        <input
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] font-mono outline-none focus:ring-1 focus:ring-primary"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="deepseek-reasoner"
          aria-label="Model id to check"
        />
      </label>
      {trimmed && !isFetching && data ? (
        <p className="text-[12px] text-muted-foreground" data-testid="family-resolution">
          {data.family ? (
            <>
              <span className="font-mono text-foreground">{data.family.id}</span>{' '}
              <span className="opacity-70">({data.family.source === 'config' ? 'yours' : 'built-in'})</span>{' '}
              — reasoning_effort {data.reasoningEffort ? 'yes' : 'no'}, thinking budget{' '}
              {data.extendedThinking ? 'yes' : 'no'}
              {data.maxEffort ? `, max ${data.maxEffort}` : ''}
              {data.defaultEffort ? `, default ${data.defaultEffort}` : ''}
            </>
          ) : (
            <>
              No family matches{' '}
              <span className="font-mono text-foreground">{data.modelId}</span> — August sends this
              model neither reasoning_effort nor a thinking budget. Add a family that matches it to
              change that.
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}

export function ModelFamiliesSection() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['model-params'],
    queryFn: fetchFamilies,
  });
  // null = nothing edited yet, so the server list stays authoritative.
  const [draft, setDraft] = useState<ModelFamily[] | null>(null);

  const rows = draft ?? data?.operator ?? [];
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(data?.operator ?? []);

  const save = useMutation({
    // `source` is what the server reports, not part of what it stores.
    mutationFn: () => saveFamilies(rows.map(({ source: _source, ...rest }) => rest)),
    onSuccess: (next) => {
      qc.setQueryData(['model-params'], next);
      setDraft(null);
      toast.success('Capability families saved', {
        description: 'The next request to a matching model uses them.',
      });
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Could not save families'),
  });

  const patch = (index: number, changes: Partial<ModelFamily>) =>
    setDraft(rows.map((row, i) => (i === index ? { ...row, ...changes } : row)));

  const addOverride = (family: ModelFamily) => {
    setDraft([...rows.filter((r) => r.id !== family.id), { ...family, source: undefined }]);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-2xl">
        August only sends a model a wire parameter its family accepts. Add a family to teach it a
        new gateway — matched by substring against the model id, so it covers every deployment of
        that name. An entry that reuses a built-in id replaces it.
      </p>

      <FamilyResolver />

      <div className="space-y-2">
        {rows.map((row, index) => (
          <FamilyRow
            key={`${row.id || 'new'}-${index}`}
            row={row}
            onChange={(changes) => patch(index, changes)}
            onRemove={() => setDraft(rows.filter((_, i) => i !== index))}
          />
        ))}
        {rows.length === 0 && (
          <Card>
            <CardContent className="p-4 text-sm text-muted-foreground">
              No overrides yet — every model is answered by the built-in table below.
            </CardContent>
          </Card>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setDraft([...rows, { ...EMPTY }])}>
            <Plus className="size-3.5" /> Add family
          </Button>
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)} title="Discard edits">
              <RotateCcw className="size-3.5" /> Discard
            </Button>
          )}
        </div>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          Built-in table
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : 'Could not read the family table.'}
          </p>
        ) : (
          <div className="space-y-1.5">
            {(data?.builtin ?? []).map((family) => {
              const overridden = rows.some((r) => r.id === family.id);
              return (
                <div
                  key={family.id}
                  className="flex items-center gap-3 rounded-md border border-border/60 px-2.5 py-1.5 text-[12px]"
                >
                  <span className="font-medium w-44 truncate">{family.id}</span>
                  <span className="text-muted-foreground flex-1 min-w-0 truncate font-mono">
                    {family.tokens.join(', ')}
                  </span>
                  {family.reasoningEffort && <Badge variant="secondary">reasoning_effort</Badge>}
                  {family.extendedThinking && <Badge variant="secondary">thinking</Badge>}
                  {overridden ? (
                    <span className="text-warning shrink-0">replaced by yours</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      onClick={() => addOverride(family)}
                      title="Copy this family into your overrides and edit it"
                    >
                      Override
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function FamilyRow({
  row,
  onChange,
  onRemove,
}: {
  row: ModelFamily;
  onChange: (changes: Partial<ModelFamily>) => void;
  onRemove: () => void;
}) {
  const field =
    'rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-primary';
  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <input
            className={`${field} flex-1 min-w-0 font-medium`}
            value={row.id}
            onChange={(e) => onChange({ id: e.target.value })}
            placeholder="family id, e.g. vectorgen"
            aria-label="Family id"
          />
          <Button size="icon-sm" variant="ghost" onClick={onRemove} title="Remove family">
            <Trash2 className="size-3 text-destructive" />
          </Button>
        </div>
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">
            Model-id substrings (comma-separated)
          </span>
          <input
            className={`${field} w-full font-mono`}
            value={row.tokens.join(', ')}
            onChange={(e) => onChange({ tokens: list(e.target.value) })}
            placeholder="vg-4, vector-pro"
            aria-label="Model-id substrings"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">
            Excluded substrings — win over the matches above
          </span>
          <input
            className={`${field} w-full font-mono`}
            value={row.excludes.join(', ')}
            onChange={(e) => onChange({ excludes: list(e.target.value) })}
            placeholder="vg-4-mini"
            aria-label="Excluded substrings"
          />
        </label>
        <div className="flex flex-wrap items-center gap-4 text-[12px]">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={row.reasoningEffort}
              onChange={(e) => onChange({ reasoningEffort: e.target.checked })}
            />
            accepts reasoning_effort
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={row.extendedThinking}
              onChange={(e) => onChange({ extendedThinking: e.target.checked })}
            />
            accepts thinking budget
          </label>
          <label className="flex items-center gap-1.5">
            default
            <select
              className={field}
              value={row.defaultEffort ?? ''}
              onChange={(e) => onChange({ defaultEffort: e.target.value })}
              aria-label="Default effort tier"
            >
              {EFFORT_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v || 'no opinion'}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            max
            <select
              className={field}
              value={row.maxEffort ?? ''}
              onChange={(e) => onChange({ maxEffort: e.target.value })}
              aria-label="Maximum effort tier"
            >
              {EFFORT_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v || 'no cap'}
                </option>
              ))}
            </select>
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
