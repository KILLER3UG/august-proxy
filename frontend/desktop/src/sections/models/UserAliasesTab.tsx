import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Plus, Trash2, Save, RefreshCw, Power } from 'lucide-react';
import {
  getAggregatedModels,
  getUserModelAliases,
  updateUserModelAliases,
  restartBackend,
  type UserModelAlias,
} from '@/api/api-client';
import { EmptyState } from './modelsShared';

/** Editable user-defined model aliases with save and backend restart. */
export function UserAliasesTab() {
  const { data: aliasData, isLoading: aliasesLoading } = useQuery({
    queryKey: ['user-model-aliases'],
    queryFn: () => getUserModelAliases(),
  });
  const { data: modelsData, refetch: refetchModels } = useQuery({
    queryKey: ['aggregated-models'],
    queryFn: () => getAggregatedModels(),
  });

  const [aliases, setAliases] = useState<UserModelAlias[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Initialise from server data once loaded.
  if (!dirty && aliasData && aliases.length === 0 && aliasData.aliases.length > 0) {
    setAliases(aliasData.aliases);
  }

  const availableModels = useMemo(() => {
    const all = modelsData?.models ?? [];
    // Deduplicate by id so the dropdown is clean.
    const seen = new Set<string>();
    return all.filter((m) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
  }, [modelsData]);

  function addAlias() {
    setAliases((prev) => [...prev, { alias: '', targetModel: '', targetProvider: '' }]);
    setDirty(true);
  }

  function updateAlias(index: number, field: keyof UserModelAlias, value: string) {
    setAliases((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      // Auto-fill provider when target model changes.
      if (field === 'targetModel') {
        const model = availableModels.find((m) => m.id === value);
        if (model) next[index].targetProvider = model.provider;
      }
      return next;
    });
    setDirty(true);
  }

  function removeAlias(index: number) {
    setAliases((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const valid = aliases.filter((a) => a.alias.trim() && a.targetModel.trim());
      await updateUserModelAliases(valid);
      setDirty(false);
    } catch (e) {
      console.error('Failed to save aliases:', e);
    } finally {
      setSaving(false);
    }
  }

  async function handleRestart() {
    if (!window.confirm('Restart the backend? This will briefly interrupt active requests.')) return;
    setRestarting(true);
    try {
      await restartBackend();
    } catch {
      // Backend will disconnect — that's expected.
    } finally {
      setRestarting(false);
    }
  }

  if (aliasesLoading) return <div className="text-sm text-muted-foreground p-6">Loading…</div>;

  return (
    <div className="space-y-3 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Define custom model IDs that route to your chosen backend models. These will appear in the model list and can be selected in the chat dropdown.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={() => { void refetchModels(); }} title="Refresh model list">
            <RefreshCw className="size-3" /> Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={addAlias}>
            <Plus className="size-3" /> Add alias
          </Button>
          <Button size="sm" onClick={() => { void save(); }} disabled={!dirty || saving}>
            <Save className="size-3" /> {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => { void handleRestart(); }} disabled={restarting} title="Restart backend to pick up all changes">
            <Power className="size-3" /> {restarting ? 'Restarting…' : 'Restart'}
          </Button>
        </div>
      </div>

      {aliases.length === 0 ? (
        <EmptyState label="No user-defined aliases yet — click 'Add alias' to create one." />
      ) : (
        <Card className="overflow-auto flex-1">
          <div className="grid grid-cols-[1fr_2fr_100px_36px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border font-mono">
            <span>Alias name</span>
            <span>Target model</span>
            <span>Provider</span>
            <span />
          </div>
          <div className="divide-y divide-border/40">
            {aliases.map((a, i) => (
              <div key={i} className="grid grid-cols-[1fr_2fr_100px_36px] gap-2 px-3 py-2 text-xs items-center font-mono">
                <Input
                  value={a.alias}
                  onChange={(e) => updateAlias(i, 'alias', e.target.value)}
                  placeholder="my-fake-model"
                  className="h-7 text-xs font-mono"
                />
                <select
                  value={a.targetModel}
                  onChange={(e) => updateAlias(i, 'targetModel', e.target.value)}
                  className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="" disabled>Select a model…</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}{m.isFree ? ' (free)' : ''}
                    </option>
                  ))}
                </select>
                <span className="text-muted-foreground truncate text-[10px]">{a.targetProvider || '—'}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeAlias(i)}
                  className="text-destructive/60 hover:text-destructive"
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
