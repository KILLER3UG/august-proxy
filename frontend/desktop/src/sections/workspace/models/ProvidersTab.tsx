/* Providers view — two-pane CRUD for model providers.
 * Left rail lists every provider from /api/providers; the right pane creates
 * or edits credentials, API format, discovery, and per-provider model rows.
 * Catalog updates flow through providersApi and refreshProviderCatalog so chat
 * model dropdowns stay in sync without a restart.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { providersApi } from '@/api/providers';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import { ProviderListRail } from './ProviderListRail';
import { AddProviderForm } from './AddProviderForm';
import { ProviderDetailForm } from './ProviderDetailForm';

export function ProvidersTab() {
  const qc = useQueryClient();
  const listQ = useQuery({
    queryKey: ['ws-providers'],
    queryFn: () => providersApi.list(),
  });
  const providers = listQ.data ?? [];

  const [mode, setMode] = useState<'add' | 'edit' | 'empty'>('empty');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddModel, setShowAddModel] = useState(false);
  // Track whether the initial auto-select has happened so the effect
  // doesn't run again when the user clicks "Add provider" (which sets
  // selectedId to null) and immediately re-selects the first provider.
  const didInitRef = useRef(false);

  // Auto-select the first provider on the initial load only.
  useEffect(() => {
    if (didInitRef.current) return;
    if (listQ.isLoading) return;
    didInitRef.current = true;
    if (providers.length > 0) {
      setSelectedId(providers[0].id);
      setMode('edit');
    } else {
      setMode('add');
    }
    // Only re-run when the providers query transitions out of loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listQ.isLoading]);

  const selected = providers.find((p) => p.id === selectedId) ?? null;

  /** Providers catalog is SoT — push updates to every model dropdown. */
  const invalidate = () => {
    void refreshProviderCatalog(qc);
  };

  function selectProvider(id: string) {
    setSelectedId(id);
    setMode('edit');
    setShowAddModel(false);
  }

  function openAddProvider() {
    setMode('add');
    setSelectedId(null);
    setShowAddModel(false);
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="providers-split">
      {/*
        Two independent panes: list grows with items (capped), details always
        scroll in their own column — neither is forced to stretch empty space.
      */}
      <div className="grid grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)] gap-4 flex-1 min-h-0 items-stretch">
        <ProviderListRail
          providers={providers}
          selectedId={selectedId}
          isFetching={listQ.isFetching}
          onRefresh={() => void listQ.refetch()}
          onSelect={selectProvider}
          onAdd={openAddProvider}
        />

        <div className="rounded-xl border border-white/[0.06] bg-card/60 flex flex-col overflow-hidden min-h-0 h-full max-h-full">
          {mode === 'add' ? (
            <AddProviderForm
              onCancel={() => {
                if (selected) {
                  setMode('edit');
                } else {
                  setMode('empty');
                }
              }}
              onCreated={(p) => {
                invalidate();
                selectProvider(p.id);
              }}
            />
          ) : mode === 'edit' && selected ? (
            <ProviderDetailForm
              key={selected.id}
              provider={selected}
              onChanged={invalidate}
              showAddModel={showAddModel}
              setShowAddModel={setShowAddModel}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
              Select a provider or add a new one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
