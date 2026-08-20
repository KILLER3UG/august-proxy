/* ── WorkspaceShell — settings-panel shell (chat-side) ───────────────── */
/* Mounted by SettingsPage inside ChatLayout. Renders the dark left rail */
/* + scrollable content area. Section nav clicks use `/settings/:id` — */
/* the Settings overlay route. The previous `/workspace/*` routes were     */
/* retired when Settings absorbed the panel.                                   */

import { type ReactNode, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Activity,
  Boxes,
  Bot,
  BrainCircuit,
  Globe,
  LineChart,
  Palette,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { WorkspaceNavLink } from './WorkspaceNavLink';
import { SettingsSearch } from '@/components/settings/SettingsSearch';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { cn } from '@/lib/utils';
import {
  SETTINGS_SECTIONS,
  SETTINGS_CATEGORIES,
  railCanonicalId,
  getSection,
  type SettingsSection,
} from '@/settings/settings-registry';

export interface WorkspaceSectionMeta {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Optional category label shown above the item. */
  category?: string;
}

/** Map of category id → lucide icon for the rail group header. 8 hubs. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  system: Activity,
  appearance: Palette,
  models: Boxes,
  memory: BrainCircuit,
  automations: Bot,
  tools: Wrench,
  access: ShieldCheck,
  insights: LineChart,
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
  // Hub IA: active can be a section id OR a category id (e.g. /settings/general). Resolve category for highlight.
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

  // Hub IA: no tier filter — all sections stay reachable, but the rail only
  // shows the 5 category hubs when not searching. Search bypasses hubs and
  // surfaces matching sections directly (grouped by category) so deep
  // discovery still works. Hidden sections never appear as rail rows;
  // they live inside their parent hub's stacked cards.
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
                    <div className="flex flex-col gap-0.5 rounded-xl bg-white/[0.025] py-1">
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
                return (
                  <WorkspaceNavLink
                    key={cat.id}
                    icon={Icon}
                    label={cat.label}
                    active={!!isActive}
                    onSelect={() => {
                      if (isActive && active === cat.id) return;
                      setQuery('');
                      void navigate(`/settings/${cat.id}`);
                    }}
                  />
                );
              })}
            </div>
          )}
        </nav>
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
