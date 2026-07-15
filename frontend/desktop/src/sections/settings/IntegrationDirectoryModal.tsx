/* ── Add Integrations modal — 3-column card directory ──────────────── */

import { useMemo, useState } from 'react';
import {
  X,
  Search,
  Plus,
  Check,
  Loader2,
  BadgeCheck,
  Package,
  Wrench,
  AlertTriangle,
  ArrowLeft,
  FolderOpen,
  Brain,
  Globe,
} from 'lucide-react';
import { SiGithub, SiGoogle, SiSlack } from 'react-icons/si';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  INTEGRATION_DIRECTORY,
  type IntegrationCatalogEntry,
} from './integrationDirectory';
import {
  CustomIntegrationForm,
  type CustomMcpPayload,
} from './CustomIntegrationForm';

/** Theme-blended field (no pure white) for dark settings chrome. */
const FIELD =
  'rounded-lg border border-white/[0.08] bg-white/[0.06] text-foreground ' +
  'placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none ' +
  'focus:ring-1 focus:ring-primary/30 shadow-none';

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

const BRAND_ICON: Record<
  string,
  React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  google: SiGoogle,
  github: SiGithub,
  slack: SiSlack,
  filesystem: FolderOpen,
  memory: Brain,
  browser: Globe,
};

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
  const [filter, setFilter] = useState<'all' | 'account' | 'mcp'>('all');
  const [mode, setMode] = useState<'directory' | 'custom'>('directory');
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
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
          <div>
            {selected ? (
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-3" /> Back to directory
              </button>
            ) : null}
            <h2 className="text-lg font-semibold text-foreground">
              {selected
                ? selected.name
                : mode === 'custom'
                  ? 'Create custom'
                  : 'Add integrations'}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {selected
                ? selected.tagline
                : mode === 'custom'
                  ? 'Register your own MCP server by command or URL.'
                  : 'Browse extensions for August. Add only what you need — Gmail and Calendar are separate.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {!selected && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-5 py-3">
            <div className="flex rounded-lg border border-white/[0.08] p-0.5 bg-white/[0.03]">
              {([
                ['directory', 'Directory'],
                ['custom', 'Create custom'],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setMode(id);
                    setError(null);
                  }}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-xs font-medium transition',
                    mode === id
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  data-testid={`integrations-mode-${id}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === 'directory' && (
              <>
                <div className="relative min-w-[180px] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search directory…"
                    className={cn('w-full py-2 pl-9 pr-3 text-sm', FIELD)}
                  />
                </div>
                {(['all', 'account', 'mcp'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={cn(
                      'rounded-lg px-3 py-1.5 text-xs font-medium transition',
                      filter === f
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-white/[0.06] text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {f === 'all' ? 'All' : f === 'account' ? 'Accounts' : 'MCP extensions'}
                  </button>
                ))}
              </>
            )}
          </div>
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
              {list.map((entry) => {
                const installed = installedIds.has(entry.id);
                const busy = busyId === entry.id;
                const Icon = BRAND_ICON[entry.brand] ?? Package;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setSelected(entry)}
                    className={cn(
                      'group flex w-full flex-col rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-left transition',
                      'hover:border-white/[0.12] hover:bg-white/[0.05]',
                      'focus:outline-none focus:ring-1 focus:ring-primary/40',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.06]">
                        <Icon
                          className="size-5"
                          style={
                            entry.brand === 'google'
                              ? { color: '#4285F4' }
                              : entry.brand === 'github'
                                ? { color: '#E6EDF3' }
                                : entry.brand === 'slack'
                                  ? { color: '#E01E5A' }
                                  : undefined
                          }
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-foreground">
                            {entry.name}
                          </span>
                          {entry.verified && (
                            <BadgeCheck className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                          {installed && (
                            <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-emerald-400">
                              Added
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {entry.tagline}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="text-[10px] text-muted-foreground">
                        {entry.kind === 'mcp-extension' ? 'MCP' : 'Account'} · {entry.developer}
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium',
                          installed
                            ? 'bg-white/[0.06] text-muted-foreground'
                            : 'bg-primary/15 text-primary',
                        )}
                      >
                        {busy ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : installed ? (
                          <Check className="size-3" />
                        ) : (
                          <Plus className="size-3" />
                        )}
                        {installed ? 'Added' : 'View'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CatalogDetail({
  entry,
  installed,
  busy,
  onAdd,
}: {
  entry: IntegrationCatalogEntry;
  installed: boolean;
  busy: boolean;
  onAdd: (env?: Record<string, string>) => void;
}) {
  const tools = entry.tools ?? [];
  const shown = tools.slice(0, 10);
  const more = Math.max(0, tools.length - shown.length);
  const Icon = BRAND_ICON[entry.brand] ?? Package;
  const envFields = entry.requiredEnv ?? [];

  const [envValues, setEnvValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of envFields) {
      init[f.key] = f.defaultValue ?? '';
    }
    return init;
  });
  const [formError, setFormError] = useState<string | null>(null);

  const missingRequired = envFields.filter(
    (f) => f.required !== false && !(envValues[f.key] ?? '').trim(),
  );

  const handleInstall = () => {
    setFormError(null);
    if (missingRequired.length > 0) {
      setFormError(
        `Fill in: ${missingRequired.map((f) => f.label).join(', ')}`,
      );
      return;
    }
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(envValues)) {
      if (v.trim()) cleaned[k] = v.trim();
    }
    onAdd(Object.keys(cleaned).length ? cleaned : undefined);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-start gap-4">
        <div className="grid size-14 shrink-0 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.06]">
          <Icon
            className="size-7"
            style={
              entry.brand === 'google'
                ? { color: '#4285F4' }
                : entry.brand === 'github'
                  ? { color: '#E6EDF3' }
                  : entry.brand === 'slack'
                    ? { color: '#E01E5A' }
                    : undefined
            }
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xl font-semibold text-foreground">{entry.name}</h3>
            {entry.verified && <BadgeCheck className="size-4 text-muted-foreground" />}
            {entry.isNew && (
              <span className="text-[11px] font-medium text-rose-400/90">New</span>
            )}
            {entry.isCommunity && (
              <Badge variant="outline" className="text-[10px]">
                Community
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{entry.tagline}</p>
        </div>
      </div>

      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
        {entry.description}
      </p>

      {entry.packageName && (
        <p className="text-xs text-muted-foreground">
          Under the hood it uses{' '}
          <span className="font-mono text-foreground/80">
            {entry.packageName}
            {entry.packageVersion ? ` v${entry.packageVersion}` : ''}
          </span>
          .
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Developed by <span className="text-foreground/80">{entry.developer}</span>
      </p>

      <div className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <AlertTriangle className="mb-1 inline size-3.5 text-amber-400/90" /> Only use extensions
        from developers you trust. August does not control third-party MCP tools.
      </div>

      {tools.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Wrench className="size-3.5" /> Tools
            <span className="font-mono font-normal text-muted-foreground">{tools.length}</span>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {shown.map((t) => (
              <li
                key={t}
                className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-foreground/90"
              >
                {t}
              </li>
            ))}
            {more > 0 && (
              <li className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground">
                +{more} more
              </li>
            )}
          </ul>
        </div>
      )}

      {entry.requirements && (
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground">Requirements</p>
          <p className="text-xs text-muted-foreground">{entry.requirements}</p>
        </div>
      )}

      {envFields.length > 0 && !installed && (
        <div className="space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
          <p className="text-xs font-semibold text-foreground">Configuration</p>
          <p className="text-[11px] text-muted-foreground">
            These are saved to the MCP server env and shared MCP env so Sign in with Google
            can open a browser immediately after install.
          </p>
          {envFields.map((field) => (
            <div key={field.key} className="space-y-1">
              <label className="block text-[11px] font-medium text-muted-foreground">
                {field.label}
                {field.required !== false ? (
                  <span className="text-destructive"> *</span>
                ) : null}
              </label>
              <input
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                value={envValues[field.key] ?? ''}
                onChange={(e) =>
                  setEnvValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                }
                placeholder={field.placeholder}
                className={cn('w-full px-3 py-2 font-mono text-xs', FIELD)}
              />
              {field.help && (
                <p className="text-[10px] text-muted-foreground">{field.help}</p>
              )}
            </div>
          ))}
          {entry.helpUrl && (
            <a
              href={entry.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex text-[11px] text-primary hover:underline"
            >
              Setup guide →
            </a>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {entry.categories.map((c) => (
          <Badge key={c} variant="outline" className="text-[10px]">
            {c}
          </Badge>
        ))}
      </div>

      {formError && (
        <p className="text-xs text-destructive">{formError}</p>
      )}

      <div className="pt-1">
        <Button
          onClick={handleInstall}
          disabled={installed || busy}
          className="min-w-[140px]"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : installed ? (
            <Check className="size-3.5" />
          ) : (
            <Plus className="size-3.5" />
          )}
          {installed ? 'Already added' : entry.kind === 'mcp-extension' ? 'Install' : 'Add'}
        </Button>
      </div>
    </div>
  );
}
