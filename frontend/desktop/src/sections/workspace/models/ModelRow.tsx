/* Single model row inside a provider's model list.
 * Supports inline context-window edit (next to the connection probe), display
 * name / reasoning via pencil edit, and remove — results surface as badges.
 */

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Pencil,
  Pin,
  Trash2,
  Plug,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { providersApi, type ApiFormat, type Provider } from '@/api/providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { API_FORMATS, fmtContextWindow } from './modelSettingsShared';

/** Suggest a wire format from the model id family (multi-format gateways like
 *  OpenCode Zen serve Claude at /v1/messages while the provider defaults to
 *  chat/completions). Advisory only — never auto-applied. */
export function suggestModelApiFormat(id: string): ApiFormat | null {
  const mid = id.toLowerCase();
  if (mid.startsWith('claude-') || mid.startsWith('anthropic/') || mid.startsWith('claude/')) {
    return 'anthropicMessages';
  }
  return null;
}

export function ModelRow({
  providerId,
  model,
  onChanged,
}: {
  providerId: string;
  model: Provider['models'][number];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(model.name ?? model.id);
  const [contextWindow, setContextWindow] = useState(
    (model.contextWindow ?? 128000).toString(),
  );
  const [reasoning, setReasoning] = useState(!!model.reasoning);
  const [format, setFormat] = useState<ApiFormat | ''>(model.apiFormat ?? '');
  const [toolSurface, setToolSurface] = useState<'full' | 'reduced' | 'bare' | ''>(
    (model as { toolSurface?: string }).toolSurface as 'full' | 'reduced' | 'bare' | '' ?? '',
  );
  const [reasoningEffortSupport, setReasoningEffortSupport] = useState<'' | 'yes' | 'no'>(
    model.supportsReasoningEffort === true ? 'yes' : model.supportsReasoningEffort === false ? 'no' : '',
  );
  const [maxReasoningEffort, setMaxReasoningEffort] = useState<string>(model.maxReasoningEffort ?? '');
  const [maxTools, setMaxTools] = useState<string>(
    ((model as { maxTools?: number }).maxTools ?? 0).toString(),
  );
  const [maxToolResultChars, setMaxToolResultChars] = useState<string>(
    ((model as { maxToolResultChars?: number }).maxToolResultChars ?? 0).toString(),
  );
  const [testResult, setTestResult] = useState<null | {
    ok: boolean;
    error?: string;
    latencyMs: number;
    content?: string;
  }>(null);

  useEffect(() => {
    setName(model.name ?? model.id);
    setContextWindow((model.contextWindow ?? 128000).toString());
    setReasoning(!!model.reasoning);
    setFormat(model.apiFormat ?? '');
    setReasoningEffortSupport(
      model.supportsReasoningEffort === true ? 'yes' : model.supportsReasoningEffort === false ? 'no' : '',
    );
    setMaxReasoningEffort(model.maxReasoningEffort ?? '');
    setMaxTools(((model as { maxTools?: number }).maxTools ?? 0).toString());
    setMaxToolResultChars(
      ((model as { maxToolResultChars?: number }).maxToolResultChars ?? 0).toString(),
    );
  }, [model.id, model.name, model.contextWindow, model.reasoning, model.apiFormat, model.supportsReasoningEffort, model.maxReasoningEffort]);

  const update = useMutation({
    mutationFn: (body: {
      name?: string;
      contextWindow?: number | null;
      reasoning?: boolean;
      apiFormat?: ApiFormat | null;
      supportsReasoningEffort?: boolean | null;
      maxReasoningEffort?: string | null;
      toolSurface?: string | null;
      maxTools?: number | null;
      maxToolResultChars?: number | null;
    }) => providersApi.updateModel(providerId, model.id, body),
    onSuccess: () => {
      setEditing(false);
      onChanged();
      toast.success('Saved');
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    },
  });
  const remove = useMutation({
    mutationFn: () => providersApi.removeModel(providerId, model.id),
    onSuccess: () => {
      onChanged();
      toast.success(`Removed ${model.id}`);
    },
  });
  const connect = useMutation({
    mutationFn: () => providersApi.connectModel(providerId, model.id),
    onSuccess: (res) => {
      // Strict: only Connected when backend says success AND returned non-empty content
      const reallyOk = Boolean(res.success && res.content && res.content.trim().length > 0 && !res.error);
      setTestResult({
        ok: reallyOk,
        error: reallyOk ? undefined : (res.error || 'Model returned no text'),
        latencyMs: res.latencyMs ?? 0,
        content: res.content,
      });
      if (reallyOk) {
        toast.success(`${model.id} connected · ${res.latencyMs}ms`);
      } else {
        toast.error(res.error || `${model.id} test failed`);
      }
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Connection failed';
      setTestResult({ ok: false, error: msg, latencyMs: 0 });
      toast.error(msg);
    },
  });

  const saveContextWindow = () => {
    const trimmed = contextWindow.trim();
    const next = trimmed ? Number(trimmed) : 128000;
    if (!Number.isFinite(next) || next <= 0) {
      toast.error('Context window must be a positive number');
      setContextWindow((model.contextWindow ?? 128000).toString());
      return;
    }
    const prev = model.contextWindow ?? 128000;
    if (next === prev) {
      setContextWindow(String(next));
      return;
    }
    update.mutate({ contextWindow: next });
  };

  if (editing) {
    return (
      <div
        className="px-3 py-3 space-y-2 bg-primary/5 border-l-2 border-primary"
        data-editing="true"
      >
        <div className="flex items-center gap-2">
          <Pencil className="size-3 text-primary" />
          <span className="text-[11px] uppercase tracking-caps font-semibold text-primary">
            Editing
          </span>
          <span className="text-xs font-mono text-muted-foreground truncate">{model.id}</span>
        </div>
        <div className="border-t border-border/30 pt-2 space-y-2">
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
              aria-label="Display name"
            />
            <Input
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
              placeholder="Context window"
              type="number"
              min={1}
              aria-label="Context window"
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
            Supports reasoning
          </label>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs">
              <span className="shrink-0">Wire format</span>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as ApiFormat | '')}
                aria-label="Wire format override"
                className="h-7 flex-1 rounded border border-input bg-background px-2 text-[11px] font-mono"
              >
                <option value="">Auto (provider format)</option>
                {API_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            {!format && suggestModelApiFormat(model.id) && (
              <p className="text-[11px] text-amber-500/90">
                {model.id} looks like an Anthropic model — multi-format gateways
                (e.g. OpenCode Zen) need{' '}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => setFormat('anthropicMessages')}
                >
                  v1/messages
                </button>{' '}
                for it.
              </p>
            )}
            <label className="flex items-center gap-2 text-xs">
              <span className="shrink-0">reasoning_effort</span>
              <select
                value={reasoningEffortSupport}
                onChange={(e) => setReasoningEffortSupport(e.target.value as '' | 'yes' | 'no')}
                aria-label="Supports reasoning_effort"
                className="h-7 flex-1 rounded border border-input bg-background px-2 text-[11px] font-mono"
              >
                <option value="">Auto (heuristic)</option>
                <option value="yes">Yes — always send</option>
                <option value="no">No — never send</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <span className="shrink-0">Tool surface</span>
              <select
                value={toolSurface}
                onChange={(e) => setToolSurface(e.target.value as 'full' | 'reduced' | 'bare' | '')}
                aria-label="Tool surface"
                className="h-7 flex-1 rounded border border-input bg-background px-2 text-[11px] font-mono"
              >
                <option value="">Full (default)</option>
                <option value="reduced">Reduced — drop heavy tools</option>
                <option value="bare">Bare — read/write/run_command/state only</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <span className="shrink-0">Max tools</span>
              <input
                type="number"
                min={0}
                value={maxTools}
                onChange={(e) => setMaxTools(e.target.value)}
                aria-label="Max tools"
                placeholder="0 = no cap"
                className="h-7 flex-1 rounded border border-input bg-background px-2 text-[11px] font-mono"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <span className="shrink-0">Result cap (KB)</span>
              <input
                type="number"
                min={0}
                value={maxToolResultChars}
                onChange={(e) => setMaxToolResultChars(e.target.value)}
                aria-label="Max tool result chars"
                placeholder="0 = 64 KB default"
                className="h-7 flex-1 rounded border border-input bg-background px-2 text-[11px] font-mono"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <span className="shrink-0">Max effort</span>
              <select
                value={maxReasoningEffort}
                onChange={(e) => setMaxReasoningEffort(e.target.value)}
                aria-label="Max reasoning effort"
                className="h-7 flex-1 rounded border border-input bg-background px-2 text-[11px] font-mono"
              >
                <option value="">Auto (no cap)</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                update.mutate({
                  name,
                  contextWindow: contextWindow.trim()
                    ? Number(contextWindow)
                    : 128000,
                  reasoning,
                  apiFormat: format || null,
                  supportsReasoningEffort: reasoningEffortSupport === '' ? null : reasoningEffortSupport === 'yes',
                  maxReasoningEffort: maxReasoningEffort || null,
                  toolSurface: toolSurface || null,
                  maxTools: maxTools.trim() ? Number(maxTools) : null,
                  maxToolResultChars: maxToolResultChars.trim() ? Number(maxToolResultChars) : null,
                })
              }
              disabled={update.isPending}
            >
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const ctxLabel = fmtContextWindow(model.contextWindow);

  return (
    <div className="px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <span className="font-medium truncate">
            {model.pinned && (
              <Pin className="size-3 inline mr-1 -mt-0.5 text-primary" aria-label="Pinned" />
            )}
            {model.name || model.id}
          </span>
        </div>
        <span
          className={cn(
            'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono',
            model.source === 'fetched'
              ? 'bg-blue-500/15 text-blue-400'
              : 'bg-white/[0.06] text-muted-foreground',
          )}
          title={`source: ${model.source}`}
        >
          {model.source}
        </span>
        {model.apiFormat && (
          <span
            className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono bg-primary/10 text-primary"
            title="Per-model wire-format override (overrides the provider format)"
          >
            {API_FORMATS.find((f) => f.value === model.apiFormat)?.label ?? model.apiFormat}
          </span>
        )}
        <label className="flex items-center gap-1 shrink-0" title="Context window (tokens)">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">ctx</span>
          <Input
            value={contextWindow}
            onChange={(e) => setContextWindow(e.target.value)}
            onBlur={saveContextWindow}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
            placeholder="128000"
            type="number"
            min={1}
            aria-label="Context window"
            disabled={update.isPending}
            className="h-7 w-[7.5rem] px-2 text-[11px] font-mono"
          />
          {ctxLabel && (
            <span className="text-[10px] font-mono text-muted-foreground w-8">{ctxLabel}</span>
          )}
        </label>
        <button
          onClick={() => {
            void providersApi
              .updateModel(providerId, model.id, { pinned: !model.pinned })
              .then(onChanged);
          }}
          aria-label={model.pinned ? `Unpin ${model.id}` : `Pin ${model.id} to top`}
          title={
            model.pinned
              ? 'Unpin — remove from top'
              : 'Pin — always on top here and in the model dropdown'
          }
          className={cn(
            'grid size-7 place-items-center rounded transition',
            model.pinned
              ? 'text-primary hover:bg-white/[0.06]'
              : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground',
          )}
        >
          <Pin className="size-3.5" />
        </button>
        <button
          onClick={() => connect.mutate()}
          disabled={connect.isPending}
          aria-label="Test model connection"
          title="Test connection to this model"
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground transition disabled:opacity-50"
        >
          {connect.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plug className="size-3.5" />
          )}
        </button>
        <button
          onClick={() => setEditing(true)}
          aria-label="Edit model"
          title="Edit display name and metadata"
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground transition"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          onClick={() => {
            if (confirm(`Remove model "${model.id}"?`)) remove.mutate();
          }}
          aria-label="Delete model"
          title="Remove this model"
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {testResult && (
        <div
          className={cn(
            'flex items-start gap-1.5 text-[11px] mt-1.5 pl-0.5',
            testResult.ok ? 'text-success' : 'text-danger',
          )}
          role={testResult.ok ? 'status' : 'alert'}
          aria-live="polite"
          data-testid={testResult.ok ? 'model-test-ok' : 'model-test-error'}
        >
          {testResult.ok ? (
            <>
              <CheckCircle2 className="size-3 mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="font-medium">Connected</span>
                <span className="text-muted-foreground"> · {testResult.latencyMs}ms</span>
              </span>
            </>
          ) : (
            <>
              <AlertCircle className="size-3 mt-0.5 shrink-0" />
              <span className="min-w-0 break-words" title={testResult.error}>
                <span className="font-medium">Failed</span>
                {testResult.latencyMs > 0 && (
                  <span className="text-muted-foreground"> · {testResult.latencyMs}ms</span>
                )}
                <span className="block opacity-90">{testResult.error || 'Connection failed'}</span>
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
