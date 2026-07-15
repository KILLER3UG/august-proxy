/* Aliases view — user-defined model aliases that route to a real model
 * and provider. Stored in config.json via /api/config/model-aliases; aliases
 * appear in the chat model dropdown after save (restart may be required).
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw,
  Plus,
  Trash2,
  Pencil,
  Check,
  Loader2,
  ArrowRightLeft,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getUserModelAliases,
  updateUserModelAliases,
  getAggregatedModels,
  restartBackend,
  type UserModelAlias,
} from '@/api/api-client';
import { WorkspaceEmptyState } from '@/components/workspace/WorkspaceEmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import { ModelPickerDropdown } from '@/components/overlays/ModelPickerDropdown';
import { uniqueAggregatedModels } from './modelSettingsShared';

export function AliasesTab() {
  const qc = useQueryClient();
  const aliasQ = useQuery({
    queryKey: ['user-model-aliases'],
    queryFn: () => getUserModelAliases(),
  });
  const modelsQ = useQuery({
    queryKey: ['aggregated-models'],
    queryFn: () => getAggregatedModels(),
  });

  // Local edits buffer — only persisted on Save.
  const [edits, setEdits] = useState<UserModelAlias[] | null>(null);
  const [aliases, setAliases] = useState<UserModelAlias[]>([]);
  useEffect(() => {
    if (aliasQ.data && edits === null) {
      setAliases(aliasQ.data.aliases ?? []);
    }
  }, [aliasQ.data, edits]);
  const visible = edits ?? aliases;
  const dirty = edits !== null && JSON.stringify(edits) !== JSON.stringify(aliases);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const restartMut = useMutation({
    mutationFn: () => restartBackend(),
    onSuccess: () => toast.success('Backend restart requested'),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Restart failed'),
  });

  function startEdit() {
    setEdits(aliases.map((a) => ({ ...a })));
  }
  function cancelEdit() {
    setEdits(null);
  }
  function commitAliasChange(idx: number, patch: Partial<UserModelAlias>) {
    const base = edits ?? aliases;
    const next = base.map((a, i) => (i === idx ? { ...a, ...patch } : a));
    if (edits === null) setEdits(next);
    else setEdits(next);
  }
  function addAlias() {
    const next = [...(edits ?? aliases), { alias: '', targetModel: '', targetProvider: '' }];
    if (edits === null) setEdits(next);
    else setEdits(next);
  }
  function removeAlias(idx: number) {
    const base = edits ?? aliases;
    const next = base.filter((_, i) => i !== idx);
    if (edits === null) setEdits(next);
    else setEdits(next);
  }

  async function save() {
    const payload = (edits ?? aliases).filter((a) => a.alias.trim() && a.targetModel.trim());
    setSaving(true);
    try {
      await updateUserModelAliases(payload);
      setAliases(payload);
      setEdits(null);
      void refreshProviderCatalog(qc);
      toast.success(`Saved ${payload.length} alias${payload.length === 1 ? '' : 'es'}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleRestart() {
    if (!window.confirm('Restart the backend? This will briefly interrupt active requests.')) return;
    setRestarting(true);
    try {
      await restartMut.mutateAsync();
    } finally {
      setRestarting(false);
    }
  }

  const availableModels = uniqueAggregatedModels(modelsQ.data?.models);

  return (
    <div className="space-y-3 h-full flex flex-col">
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3 flex-1 overflow-auto">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold">User-defined model aliases</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Map a custom alias (e.g. <code className="text-[10px] font-mono">my-claude-opus</code>) to
              any real model. The alias shows up in the chat dropdown and proxies to the target provider.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={() => void aliasQ.refetch()} title="Refresh model list">
              <RefreshCw className="size-3" /> Refresh
            </Button>
            {!dirty && (
              <Button size="sm" variant="outline" onClick={startEdit}>
                <Pencil className="size-3" /> Edit
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={addAlias} disabled={!edits && false}>
              <Plus className="size-3" /> Add alias
            </Button>
            {dirty && (
              <>
                <Button size="sm" variant="outline" onClick={cancelEdit}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={saving}>
                  {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </>
            )}
            <Button size="sm" variant="destructive" onClick={() => void handleRestart()} disabled={restarting} title="Restart backend to pick up alias changes">
              <RefreshCw className="size-3" /> {restarting ? 'Restarting…' : 'Restart'}
            </Button>
          </div>
        </div>

        {visible.length === 0 ? (
          <WorkspaceEmptyState
            icon={ArrowRightLeft}
            title="No aliases yet"
            description="Click 'Add alias' to create one. Useful for naming a specific model+provider combo behind a memorable id."
            className="py-6"
          />
        ) : (
          <div className="rounded-lg border border-white/[0.06] overflow-hidden">
            <div className="grid grid-cols-[1fr_2fr_120px_36px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-white/[0.06] font-mono">
              <span>Alias name</span>
              <span>Target model</span>
              <span>Provider</span>
              <span />
            </div>
            <div className="divide-y divide-white/[0.06]">
              {visible.map((a, i) => {
                const editing = edits !== null;
                return (
                  <div key={i} className="grid grid-cols-[1fr_2fr_120px_36px] gap-2 px-3 py-2 text-xs items-center font-mono">
                    <Input
                      value={a.alias}
                      onChange={(e) => commitAliasChange(i, { alias: e.target.value })}
                      placeholder="my-fake-model"
                      className="h-7 text-xs font-mono"
                      disabled={!editing}
                    />
                    <ModelPickerDropdown
                      models={availableModels}
                      value={a.targetModel}
                      onChange={(modelId, provider) => commitAliasChange(i, { targetModel: modelId, targetProvider: provider })}
                      disabled={!editing}
                    />
                    <span className="text-muted-foreground truncate text-[10px]">
                      {a.targetProvider || '—'}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeAlias(i)}
                      disabled={!editing}
                      className="text-destructive/60 hover:text-destructive"
                      aria-label="Remove alias"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!dirty && aliases.length > 0 && (
          <p className="text-[10px] text-muted-foreground font-mono">
            Aliases persist to <code className="text-[10px]">config.json → modelAliases</code>.
            Restart the backend for changes to take effect.
          </p>
        )}
        {dirty && (
          <Badge variant="warning" className="text-[10px]">unsaved changes</Badge>
        )}
      </div>
    </div>
  );
}
