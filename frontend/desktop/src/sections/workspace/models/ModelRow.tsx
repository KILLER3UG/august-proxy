/* Single model row inside a provider's model list.
 * Supports inline context-window edit (next to the connection probe), display
 * name / reasoning via pencil edit, and remove — results surface as badges.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation } from '@tanstack/react-query';
import {
  Pencil,
  Pin,
  Trash2,
  Plug,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ScanSearch,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { providersApi, type ApiFormat, type Provider } from '@/api/providers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { API_FORMATS, apiFormatShortLabel, fmtContextWindow } from './modelSettingsShared';
import { ModalityPills } from './AddModelForm';

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
  const { state: confirmState, confirm: confirmStyled, handleConfirm, handleCancel } =
    useConfirmDialog();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(model.name ?? model.id);
  const [contextWindow, setContextWindow] = useState(
    (model.contextWindow ?? 128000).toString(),
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    (model.maxOutputTokens ?? 128000).toString(),
  );
  const [inputTypes, setInputTypes] = useState<string[]>(
    (model.inputTypes ?? ['text']).map((t) => t.charAt(0).toUpperCase() + t.slice(1)),
  );
  const [outputTypes, setOutputTypes] = useState<string[]>(
    (model.outputTypes ?? ['text']).map((t) => t.charAt(0).toUpperCase() + t.slice(1)),
  );
  const [reasoning, setReasoning] = useState(!!model.reasoning);
  const [format, setFormat] = useState<ApiFormat | ''>(model.apiFormat ?? '');
  const [toolSurface, setToolSurface] = useState<'full' | 'reduced' | 'bare' | ''>(
    model.toolSurface ?? '',
  );
  const [reasoningEffortSupport, setReasoningEffortSupport] = useState<'' | 'yes' | 'no'>(
    model.supportsReasoningEffort === true ? 'yes' : model.supportsReasoningEffort === false ? 'no' : '',
  );
  const [maxReasoningEffort, setMaxReasoningEffort] = useState<string>(model.maxReasoningEffort ?? '');
  const [maxTools, setMaxTools] = useState<string>((model.maxTools ?? 0).toString());
  const [maxToolResultChars, setMaxToolResultChars] = useState<string>(
    (model.maxToolResultChars ?? 0).toString(),
  );
  const [testResult, setTestResult] = useState<null | {
    ok: boolean;
    error?: string;
    latencyMs: number;
    content?: string;
  }>(null);
  const [probeResult, setProbeResult] = useState<null | {
    toolOk: boolean;
    toolDetail: string;
    latencyMs: number;
    suggestedSurface: 'full' | 'text';
  }>(null);

  useEffect(() => {
    setName(model.name ?? model.id);
    setContextWindow((model.contextWindow ?? 128000).toString());
    setMaxOutputTokens((model.maxOutputTokens ?? 128000).toString());
    setInputTypes(
      (model.inputTypes ?? ['text']).map((t) => t.charAt(0).toUpperCase() + t.slice(1)),
    );
    setOutputTypes(
      (model.outputTypes ?? ['text']).map((t) => t.charAt(0).toUpperCase() + t.slice(1)),
    );
    setReasoning(!!model.reasoning);
    setFormat(model.apiFormat ?? '');
    setReasoningEffortSupport(
      model.supportsReasoningEffort === true ? 'yes' : model.supportsReasoningEffort === false ? 'no' : '',
    );
    setMaxReasoningEffort(model.maxReasoningEffort ?? '');
    setMaxTools((model.maxTools ?? 0).toString());
    setMaxToolResultChars((model.maxToolResultChars ?? 0).toString());
  }, [model.id, model.name, model.contextWindow, model.reasoning, model.apiFormat, model.supportsReasoningEffort, model.maxReasoningEffort, model.toolSurface, model.maxTools, model.maxToolResultChars]);

  useModalDismiss(editing, () => setEditing(false));

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
      maxOutputTokens?: number | null;
      inputTypes?: string[] | null;
      outputTypes?: string[] | null;
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

  const probe = useMutation({
    mutationFn: () => providersApi.probeModel(providerId, model.id),
    onSuccess: (res) => {
      const toolOk = Boolean(res.toolSupport?.success);
      setProbeResult({
        toolOk,
        toolDetail: res.toolSupport?.detail || (toolOk ? 'Tool calling confirmed' : 'Tool calling not confirmed'),
        latencyMs: res.connectivity?.latencyMs ?? res.toolSupport?.latencyMs ?? 0,
        suggestedSurface: res.suggestedToolSurface ?? 'full',
      });
      toast.success(toolOk ? `${model.id}: tool calling works` : `${model.id}: tool calling NOT confirmed`);
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Probe failed');
    },
  });

  const applyProbeSuggestion = () => {
    if (!probeResult) return;
    update.mutate({ toolSurface: probeResult.suggestedSurface });
  };

  /** Escape closes the modal; backdrop click too. */
function useModalDismiss(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

if (editing) {
    return createPortal(
      <div
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit model ${model.id}`}
        onClick={() => setEditing(false)}
        data-testid="model-edit-modal"
      >
        <div
          className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl animate-in fade-in zoom-in-95 duration-150"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4">
            <h2 className="text-base font-semibold text-foreground">
              Edit model
            </h2>
            <button
              type="button"
              onClick={() => setEditing(false)}
              aria-label="Close"
              className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Fields — reference layout */}
          <div className="space-y-3.5 px-5 py-4">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-foreground">Display name</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Display name"
                aria-label="Display name"
                className="h-9"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-foreground">Context window</span>
              <Input
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder="1000000"
                type="number"
                min={1}
                aria-label="Context window"
                className="h-9"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-foreground">Max output tokens</span>
              <Input
                value={maxOutputTokens}
                onChange={(e) => setMaxOutputTokens(e.target.value)}
                placeholder="128000"
                type="number"
                min={1}
                aria-label="Max output tokens"
                className="h-9"
              />
            </label>
            <ModalityPills label="Input types" value={inputTypes} onChange={setInputTypes} />
            <ModalityPills label="Output types" value={outputTypes} onChange={setOutputTypes} />

            {/* Advanced wire/harness controls — collapsed so the modal matches
                the reference's simple field stack. */}
            <details className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
              <summary className="cursor-pointer select-none text-[13px] font-medium text-foreground/90">
                Advanced settings
              </summary>
              <div className="mt-3 space-y-3">
                <div className="flex items-center gap-2 text-xs">
                  <Button size="sm" variant="ghost" onClick={() => probe.mutate()} disabled={probe.isPending}>
                    {probe.isPending ? (
                      <>
                        <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                        Probing…
                      </>
                    ) : (
                      <>
                        <ScanSearch className="size-3.5 mr-1.5" />
                        Probe capabilities
                      </>
                    )}
                  </Button>
                  <span className="text-muted-foreground">Tool-call support, instruction-following, suggested surface</span>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
                  Supports reasoning
                </label>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-2 text-xs">
                    <span className="w-36 shrink-0">Request format</span>
                    <select
                      value={format}
                      onChange={(e) => setFormat(e.target.value as ApiFormat | '')}
                      aria-label="Request format override"
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
                    <span className="w-36 shrink-0">reasoning_effort</span>
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
                    <span className="w-36 shrink-0">Tool surface</span>
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
                    <span className="w-36 shrink-0">Max tools</span>
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
                    <span className="w-36 shrink-0">Result cap (KB)</span>
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
                    <span className="w-36 shrink-0">Max effort</span>
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
              </div>
            </details>
          </div>

          {/* Footer — right-aligned Cancel / Save like the reference. */}
          <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3.5">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() =>
                update.mutate({
                  name,
                  contextWindow: contextWindow.trim()
                    ? Number(contextWindow)
                    : 128000,
                  maxOutputTokens: maxOutputTokens.trim()
                    ? Number(maxOutputTokens)
                    : null,
                  inputTypes: inputTypes.map((t) => t.toLowerCase()),
                  outputTypes: outputTypes.map((t) => t.toLowerCase()),
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
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  const ctxLabel = fmtContextWindow(model.contextWindow);

  return (
    <div className="px-3 py-2.5 text-sm transition-colors hover:bg-muted/20">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <span className="font-medium truncate">
            {model.pinned && (
              <Pin className="size-3 inline mr-1 -mt-0.5 text-primary" aria-label="Pinned" />
            )}
            <span className="font-mono text-[13px]">{model.name || model.id}</span>
          </span>
        </div>
        {ctxLabel && (
          <span
            className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
            title={`Context window: ${(model.contextWindow ?? 128000).toLocaleString()} tokens`}
          >
            {ctxLabel}
          </span>
        )}
        <span
          className={cn(
            'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono',
            model.source === 'fetched'
              ? 'bg-blue-500/15 text-blue-400'
              : 'bg-muted text-muted-foreground',
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
            {apiFormatShortLabel(model.apiFormat)}
          </span>
        )}
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
              ? 'text-primary hover:bg-muted/60'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          <Pin className="size-3.5" />
        </button>
        <button
          onClick={() => connect.mutate()}
          disabled={connect.isPending}
          aria-label="Test model connection"
          title="Test connection to this model"
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground transition disabled:opacity-50"
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
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground transition"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          onClick={async () => {
            if (
              await confirmStyled({
                title: 'Remove model?',
                message: `Remove model "${model.id}"?`,
                confirmLabel: 'Remove',
                variant: 'destructive',
              })
            )
              remove.mutate();
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
      {probeResult && (
        <div
          className={cn(
            'flex items-start gap-1.5 text-[11px] mt-1.5 pl-0.5',
            probeResult.toolOk ? 'text-success' : 'text-amber-500',
          )}
          data-testid="model-probe-result"
        >
          {probeResult.toolOk ? (
            <CheckCircle2 className="size-3 mt-0.5 shrink-0" />
          ) : (
            <AlertCircle className="size-3 mt-0.5 shrink-0" />
          )}
          <span className="min-w-0">
            <span className="font-medium">
              {probeResult.toolOk ? 'Tools OK' : 'No tool support'}
            </span>
            <span className="text-muted-foreground">
              {' '}
              · {probeResult.latencyMs}ms · {probeResult.toolDetail}
            </span>
            {!probeResult.toolOk && (
              <button
                type="button"
                onClick={applyProbeSuggestion}
                className="ml-1.5 inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 font-medium text-primary hover:bg-primary/25"
                data-testid="apply-probe-suggestion"
              >
                Apply {probeResult.suggestedSurface} surface
              </button>
            )}
          </span>
        </div>
      )}
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        cancelLabel={confirmState.cancelLabel}
        variant={confirmState.variant}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  );
}
