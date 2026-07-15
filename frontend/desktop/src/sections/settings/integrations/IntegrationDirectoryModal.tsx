/* ── Add Integrations modal — 3-column card directory ──────────────── */

import { useMemo, useState } from 'react';
import {
  INTEGRATION_DIRECTORY,
  type IntegrationCatalogEntry,
} from '../integrationDirectory';
import {
  CustomIntegrationForm,
  type CustomMcpPayload,
} from '../CustomIntegrationForm';
import { CatalogDetail } from './CatalogDetail';
import { DirectoryCard } from './DirectoryCard';
import {
  DirectoryToolbar,
  type DirectoryFilter,
  type DirectoryMode,
} from './DirectoryToolbar';
import { ModalHeader } from './ModalHeader';

interface Props {
  open: boolean;
  onClose: () => void;
  installedIds: Set<string>;
  onAdd: (
    entry: IntegrationCatalogEntry,
    envOverrides?: Record<string, string>,
  ) => Promise<void>;
  onCreateCustom?: (payload: CustomMcpPayload) => Promise<void>;
  busyId?: string | null;
  customBusy?: boolean;
}

export function IntegrationDirectoryModal({
  open,
  onClose,
  installedIds,
  onAdd,
  onCreateCustom,
  busyId,
  customBusy,
}: Props) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<DirectoryFilter>('all');
  const [mode, setMode] = useState<DirectoryMode>('directory');
  const [selected, setSelected] = useState<IntegrationCatalogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return INTEGRATION_DIRECTORY.filter((e) => {
      if (filter === 'account' && e.kind !== 'account-facet') return false;
      if (filter === 'mcp' && e.kind !== 'mcp-extension') return false;
      if (!ql) return true;
      return (
        e.name.toLowerCase().includes(ql) ||
        e.tagline.toLowerCase().includes(ql) ||
        e.description.toLowerCase().includes(ql) ||
        e.categories.some((c) => c.toLowerCase().includes(ql)) ||
        e.developer.toLowerCase().includes(ql)
      );
    });
  }, [q, filter]);

  if (!open) return null;

  const add = async (
    entry: IntegrationCatalogEntry,
    envOverrides?: Record<string, string>,
  ) => {
    setError(null);
    try {
      await onAdd(entry, envOverrides);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add integration');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-[min(780px,92vh)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#121214] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add integrations"
      >
        <ModalHeader
          selected={selected}
          mode={mode}
          onBack={() => setSelected(null)}
          onClose={onClose}
        />

        {!selected && (
          <DirectoryToolbar
            mode={mode}
            filter={filter}
            query={q}
            onModeChange={setMode}
            onFilterChange={setFilter}
            onQueryChange={setQ}
            onClearError={() => setError(null)}
          />
        )}

        {error && (
          <div className="mx-5 mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {selected ? (
            <CatalogDetail
              key={selected.id}
              entry={selected}
              installed={installedIds.has(selected.id)}
              busy={busyId === selected.id}
              onAdd={(env) => void add(selected, env)}
            />
          ) : mode === 'custom' && onCreateCustom ? (
            <CustomIntegrationForm
              busy={customBusy}
              onSubmit={async (payload) => {
                setError(null);
                try {
                  await onCreateCustom(payload);
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Failed to create');
                  throw e;
                }
              }}
            />
          ) : list.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">No matches.</p>
          ) : (
            <div
              className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
              data-testid="integrations-directory-grid"
            >
              {list.map((entry) => (
                <DirectoryCard
                  key={entry.id}
                  entry={entry}
                  installed={installedIds.has(entry.id)}
                  busy={busyId === entry.id}
                  onSelect={() => setSelected(entry)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
