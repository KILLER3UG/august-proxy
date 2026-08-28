/* ── WorkspaceShell — settings-panel shell (chat-side) ───────────────── */
/* Mounted by SettingsPage inside ChatLayout. Renders the dark left rail */
/* + scrollable content area. Section nav clicks use `/settings/:id` — */
/* the Settings overlay route. The previous `/workspace/*` routes were     */
/* retired when Settings absorbed the panel.                                   */

import { type ReactNode, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpCircle,
  BrainCircuit,
  Globe,
  LineChart,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { WorkspaceNavLink } from './WorkspaceNavLink';
import { SettingsSearch } from '@/components/settings/SettingsSearch';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { useAccountStore } from '@/store/account';
import { cn } from '@/lib/utils';
import {
  SETTINGS_SECTIONS,
  SETTINGS_CATEGORIES,
  RAIL_CHILDREN,
  railCanonicalId,
  getSection,
  sectionsForCategory,
  type SettingsSection,
} from '@/settings/settings-registry';

export interface WorkspaceSectionMeta {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Optional category label shown above the item. */
  category?: string;
}

/** Map of category id → lucide icon for the rail group header.
 *  3 header groups (2026-08-28 restructure): Settings / Agent
 *  Capabilities / Data & Statistics. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  settings: Settings2,
  capabilities: BrainCircuit,
  data: LineChart,
};

interface WorkspaceShellProps {
  sections: WorkspaceSectionMeta[];
  active: string;
  children: ReactNode;
  className?: string;
}

export function WorkspaceShell({
  sections,
  active,
  children,
  className,
}: WorkspaceShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const { available: updateAvailable } = useAppUpdate();

  const railActive = railCanonicalId(active);
  // Header IA: active can be a section id OR a category id (e.g. /settings/capabilities). Resolve category for highlight.
  const activeSection = getSection(active);
  const activeCategoryId = activeSection?.category ?? (SETTINGS_CATEGORIES.find((c) => c.id === active)?.id ?? null);

  // Resolve each section's category label, icon, tier, description, and
  // keywords. Falls back to the raw `category` string if a section isn't
  // in the settings registry (e.g., legacy workspace-registry panels
  // still calling this).
  const decorated = useMemo(() => {
    return sections.map((s) => {
      const fromRegistry: SettingsSection | undefined =
        SETTINGS_SECTIONS.find((r) => r.id === s.id);
      const categoryLabel =
        SETTINGS_CATEGORIES.find((c) => c.id === s.category)?.label ??
        s.category ??
        '';
      const categoryIcon = CATEGORY_ICONS[s.category ?? ''] ?? Globe;
      return {
        ...s,
        categoryLabel,
        categoryIcon,
        tier: fromRegistry?.tier ?? 'basic',
        // Pull description/keywords from the registry when available —
        // gives the search something useful to match.
        description: fromRegistry?.description ?? '',
        keywords: fromRegistry?.keywords ?? [],
      };
    });
  }, [sections]);

  // Header IA: no tier filter — all sections stay reachable, but the rail
  // only shows the 3 header groups when not searching. Search bypasses
  // headers and surfaces matching sections directly (grouped by category)
  // so deep discovery still works. Hidden sections never appear as rail
  // rows; they live inside their parent's stacked cards or as tree
  // grandchildren (RAIL_CHILDREN).
  const visibleForSearch = useMemo(() => decorated.filter((s) => s.tier !== 'hidden'), [decorated]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Map<string, typeof decorated>();
    const match = (s: (typeof decorated)[number]) => {
      if (s.label.toLowerCase().includes(q)) return true;
      if (s.description.toLowerCase().includes(q)) return true;
      return s.keywords.some((k) => k.toLowerCase().includes(q));
    };
    const ids = new Set<string>();
    for (const s of visibleForSearch) {
      if (!match(s)) continue;
      ids.add(s.id);
    }
    const chosen = decorated.filter((s) => ids.has(s.id) && s.tier !== 'hidden');
    return groupAllByCategory(chosen);
  }, [decorated, visibleForSearch, query]);

  const isFiltering = query.trim().length > 0;
  const totalShown = useMemo(() => {
    if (isFiltering) return Array.from(filtered.values()).reduce((n, items) => n + items.length, 0);
    return SETTINGS_CATEGORIES.length;
  }, [filtered, isFiltering]);

  return (
    <div className={cn('flex h-full min-h-0', className)}>
      {/* Left rail */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <button
          onClick={() => {
            // Return to the exact chat the user came from (saved when
            // navigating into /settings), not always "/".
            const back = sessionStorage.getItem('pre-settings-path');
            void navigate(back && back !== location.pathname ? back : '/');
            sessionStorage.removeItem('pre-settings-path');
          }}
          className="flex items-center gap-2 px-4 py-3 text-left text-sm text-sidebar-foreground/60 transition hover:text-sidebar-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to workspace
        </button>
        <div className="px-3 pb-2">
          <SettingsSearch value={query} onChange={setQuery} />
          {isFiltering && (
            <p className="mt-1.5 px-1 text-[10px] text-muted-foreground/70">
              {totalShown} of {decorated.length} sections
            </p>
          )}
        </div>
        <nav className="flex-1 overflow-y-auto py-1">
          {isFiltering ? (
            totalShown === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                No sections match{' '}
                <span className="font-mono">&ldquo;{query}&rdquo;</span>.
              </div>
            ) : (
              Array.from(filtered.entries()).map(([category, items]) => {
                const Icon = items[0]?.categoryIcon ?? Globe;
                const categoryLabel = items[0]?.categoryLabel ?? category;
                return (
                  <div key={category || 'default'} className="mb-2 px-2">
                    <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/40">
                      <Icon className="size-3" aria-hidden="true" />
                      <span>{categoryLabel}</span>
                    </div>
                    <div className="flex flex-col gap-0.5 rounded-xl bg-sidebar-accent/40 py-1">
                    {items.map((s) => (
                      <WorkspaceNavLink
                        key={s.id}
                        icon={s.icon}
                        label={s.label}
                        active={railActive === s.id}
                        badge={
                          s.id === 'app-updates' && updateAvailable
                            ? 'New'
                            : null
                        }
                        onSelect={() => {
                          if (s.id === railActive && s.id === active) return;
                          setQuery('');
                          void navigate(`/settings/${s.id}`);
                        }}
                      />
                    ))}
                    </div>
                  </div>
                );
              })
            )
          ) : (
            <div className="px-2 py-1 flex flex-col gap-0.5">
              {SETTINGS_CATEGORIES.map((cat) => {
                const Icon = CATEGORY_ICONS[cat.id] ?? Globe;
                const isActive = activeCategoryId === cat.id;
                // Tree sub-nav: the active category expands its sections
                // INLINE under the rail row (folder ▸ files pattern) — no
                // separate pill tab strip inside the content pane.
                const children = sectionsForCategory(cat.id).filter((s) => s.tier !== 'hidden');
                return (
                  <div key={cat.id}>
                    <WorkspaceNavLink
                      icon={Icon}
                      label={cat.label}
                      active={!!isActive}
                      onSelect={() => {
                        setQuery('');
                        void navigate(`/settings/${cat.id}`);
                      }}
                    />
                    {isActive && children.length > 0 && (
                      <div className="ml-4 flex flex-col gap-px border-l border-sidebar-border/60 py-0.5 pl-1.5">
                        {children.map((s) => {
                          const childActive = active === s.id || railActive === s.id;
                          // Second-level tree items (e.g. UI Designer under
                          // Appearance) — visible while the parent row is
                          // active so the nested page stays reachable.
                          const grandchildren = (RAIL_CHILDREN[s.id] ?? [])
                            .map((gid) => getSection(gid))
                            .filter((g): g is SettingsSection => !!g);
                          return (
                            <div key={s.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  if (childActive && active === s.id) return;
                                  void navigate(`/settings/${s.id}`);
                                }}
                                data-testid={`settings-subnav-${s.id}`}
                                aria-current={active === s.id ? 'page' : undefined}
                                className={cn(
                                  'w-full truncate rounded-md px-2 py-1 text-left text-[12px] transition-colors',
                                  active === s.id
                                    ? 'bg-white/[0.07] font-medium text-foreground'
                                    : 'text-muted-foreground/80 hover:bg-white/[0.04] hover:text-foreground',
                                )}
                              >
                                {s.label}
                              </button>
                              {childActive && grandchildren.length > 0 && (
                                <div className="ml-3 flex flex-col gap-px border-l border-sidebar-border/40 py-0.5 pl-1.5">
                                  {grandchildren.map((g) => {
                                    const gActive = active === g.id;
                                    return (
                                      <button
                                        key={g.id}
                                        type="button"
                                        onClick={() => {
                                          if (gActive) return;
                                          void navigate(`/settings/${g.id}`);
                                        }}
                                        data-testid={`settings-subnav-${g.id}`}
                                        aria-current={gActive ? 'page' : undefined}
                                        className={cn(
                                          'w-full truncate rounded-md px-2 py-1 text-left text-[11.5px] transition-colors',
                                          gActive
                                            ? 'bg-white/[0.07] font-medium text-foreground'
                                            : 'text-muted-foreground/70 hover:bg-white/[0.04] hover:text-foreground',
                                        )}
                                      >
                                        {g.label}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </nav>

        {/* Bottom profile row — mirrors the reference design's pinned identity
            footer. Routes to the local Accounts manager. */}
        <ProfileRailRow />
      </aside>

      {/* Main content — each section renders its own h1 inside.
          overflow-x-hidden: wide children (tables, pre) must not give the
          whole settings pane a horizontal scrollbar. */}
      <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">{children}</div>
    </div>
  );
}

/** Re-group a flat section list by category (used by search to bypass
 *  the tier filter). Generic so callers can pass either the full
 *  decorated list or the tier-filtered one. */
function groupAllByCategory<T extends { category?: string }>(items: ReadonlyArray<T>) {
  const m = new Map<string, T[]>();
  for (const cat of SETTINGS_CATEGORIES) {
    m.set(cat.id, []);
  }
  for (const s of items) {
    const k = s.category ?? '';
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(s);
  }
  for (const [k, v] of [...m.entries()]) {
    if (v.length === 0) m.delete(k);
  }
  return m;
}

/** Pinned identity footer at the bottom of the settings rail. Shows the
 *  active local account (initials avatar + name) and an Updates status row
 *  (mirrors the chat-side user dropdown: version state visible at a glance,
 *  click opens the Updates section). */
function ProfileRailRow() {
  const navigate = useNavigate();
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const { available: updateAvailable } = useAppUpdate();
  const account = accounts.find((a) => a.id === activeAccountId) ?? null;
  if (!account) return null;
  return (
    <div className="shrink-0 border-t border-sidebar-border p-2">
      <button
        onClick={() => {
          void navigate('/settings/account');
        }}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-sidebar-accent/50"
        aria-label={`Account: ${account.displayName}. Open accounts settings.`}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
          {account.initials || account.displayName.slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-sidebar-foreground">
            {account.displayName}
          </span>
          <span className="block truncate text-[11px] text-sidebar-foreground/55">
            {account.email || `@${account.username}` || 'Local account'}
          </span>
        </span>
        <Settings2 className="size-3.5 shrink-0 text-sidebar-foreground/40" aria-hidden="true" />
      </button>
      {/* Updates status row — same affordance as the model dropdown: current
          state ("Up to date" / "Update available") rendered under the item. */}
      <button
        onClick={() => {
          void navigate('/settings/app-updates');
        }}
        data-testid="rail-updates-row"
        className="mt-0.5 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-sidebar-accent/50"
        aria-label="Open updates"
      >
        <ArrowUpCircle
          className={cn(
            'size-3.5 shrink-0',
            updateAvailable ? 'text-amber-400' : 'text-sidebar-foreground/40',
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[11px] text-sidebar-foreground/60">
          {updateAvailable ? `Update available · v${updateAvailable.version}` : 'Up to date'}
        </span>
      </button>
    </div>
  );
}
