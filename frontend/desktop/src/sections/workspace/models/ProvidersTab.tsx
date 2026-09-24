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
import { QueryErrorState } from '@/components/QueryErrorState';
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
  // A failed catalog fetch is not an empty catalog. The old init effect fired
  // on "not loading" — which includes a failed query — and jumped straight
  // into the Add-provider form, so a 500 read as "you have no providers".
  const listFailed = listQ.isError && !listQ.data;

  const [mode, setMode] = useState<'add' | 'edit' | 'empty'>('empty');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddModel, setShowAddModel] = useState(false);
  // Track whether the initial auto-select has happened so the effect
  // doesn't run again when the user clicks "Add provider" (which sets
  // selectedId to null) and immediately re-selects the first provider.
  const didInitRef = useRef(false);

  // Auto-select the first provider on the initial load only — and only once
  // the request actually succeeded.
  useEffect(() => {
    if (didInitRef.current) return;
    if (!listQ.isSuccess) return;
    didInitRef.current = true;
    if (providers.length > 0) {
      setSelectedId(providers[0].id);
      setMode('edit');
    } else {
      setMode('add');
    }
    // Only re-run when the providers query settles successfully.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listQ.isSuccess]);

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
    <div data-testid="providers-split">
      {/*
        Natural document flow: the settings shell's own scrollbar carries the
        page (same as every other settings section). The provider rail sticks
        below the header while the taller detail form scrolls past it.
      */}
      <div className="grid grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)] gap-4">
        <div>
          <div className="md:sticky md:top-4">
            <ProviderListRail
              providers={providers}
              selectedId={selectedId}
              isFetching={listQ.isFetching}
              error={listFailed ? listQ.error : null}
              onRefresh={() => void listQ.refetch()}
              onSelect={selectProvider}
              onAdd={openAddProvider}
            />
          </div>
        </div>

        <div className="rounded-xl border border-border/60 bg-card/60 flex flex-col overflow-hidden">
          {listFailed && mode !== 'add' ? (
            <QueryErrorState
              className="m-4"
              error={listQ.error}
              onRetry={() => void listQ.refetch()}
              retrying={listQ.isRefetching}
              title="Couldn't load providers"
              note="Your providers may still be saved — the catalog request failed, so this is not an empty list. Retry before adding a new provider."
            />
          ) : mode === 'add' ? (
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
