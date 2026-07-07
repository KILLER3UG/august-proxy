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
  ChevronDown,
  ChevronRight,
  Globe,
  LineChart,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { WorkspaceNavLink } from './WorkspaceNavLink';
import { SettingsSearch } from '@/components/settings/SettingsSearch';
import { useSettingsAdvancedPreference } from '@/hooks/useSettingsAdvancedPreference';
import { cn } from '@/lib/utils';
import {
  SETTINGS_SECTIONS,
  SETTINGS_CATEGORIES,
  type SettingsSection,
} from '@/settings/settings-registry';

export interface WorkspaceSectionMeta {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Optional category label shown above the item. */
  category?: string;
}

/** Map of category id → lucide icon for the rail group header. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  general: Activity,
  intelligence: Boxes,
  tools: Wrench,
  activity: LineChart,
  security: ShieldCheck,
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
  const [query, setQuery] = useState('');
  const { showAdvanced, toggle: toggleAdvanced } = useSettingsAdvancedPreference();

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

  // Apply tier filter: when "Show advanced" is off, hide advanced items
  // UNLESS the user has deep-linked to one (we keep the active section
  // visible so legacy URLs continue to work).
  const tiered = useMemo(() => {
    if (showAdvanced) return decorated;
    return decorated.filter((s) => s.tier === 'basic' || s.id === active);
  }, [decorated, showAdvanced, active]);

  // Filter by free-text query (matches label, description, keywords).
  // Search bypasses the tier filter so users can still find advanced
  // sections by keyword even when advanced is hidden.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = q ? decorated : tiered;
    const m = new Map<string, typeof decorated>();
    for (const [cat, items] of groupAllByCategory(source).entries()) {
      const kept = items.filter((s) => {
        if (s.label.toLowerCase().includes(q)) return true;
        if (s.description.toLowerCase().includes(q)) return true;
        if (s.keywords.some((k) => k.toLowerCase().includes(q)) ) return true;
        return false;
      });
      if (kept.length > 0) m.set(cat, kept);
    }
    return m;
  }, [decorated, tiered, query]);

  const isFiltering = query.trim().length > 0;
  const totalShown = useMemo(
    () => Array.from(filtered.values()).reduce((n, items) => n + items.length, 0),
    [filtered],
  );

  return (
    <div className={cn('flex h-full min-h-0', className)}>
      {/* Left rail */}
      <aside className="w-64 shrink-0 border-r border-white/[0.06] bg-[#0f0f12] flex flex-col">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground hover:text-foreground transition text-left"
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
          {totalShown === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No sections match{' '}
              <span className="font-mono">&ldquo;{query}&rdquo;</span>.
            </div>
          ) : (
            Array.from(filtered.entries()).map(([category, items]) => {
              const Icon = items[0]?.categoryIcon ?? Globe;
              const categoryLabel = items[0]?.categoryLabel ?? category;
              return (
                <div key={category || 'default'} className="mb-1">
                  <div className="flex items-center gap-1.5 px-4 pt-2 pb-1 text-[10px] uppercase tracking-widest text-muted-foreground/50 font-semibold">
                    <Icon className="size-3" aria-hidden="true" />
                    <span>{categoryLabel}</span>
                  </div>
                  {items.map((s) => (
                    <WorkspaceNavLink
                      key={s.id}
                      icon={s.icon}
                      label={s.label}
                      active={active === s.id}
                      onSelect={() => {
                        setQuery('');
                        navigate(`/settings/${s.id}`);
                      }}
                    />
                  ))}
                </div>
              );
            })
          )}
        </nav>

        {/* Bottom: Show advanced toggle. Quiet and always visible so
         * power users can reveal advanced sections without using search. */}
        <div className="shrink-0 border-t border-white/[0.06] px-3 py-2">
          <button
            type="button"
            onClick={toggleAdvanced}
            aria-pressed={showAdvanced}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-white/[0.04] hover:text-foreground transition"
          >
            <span>{showAdvanced ? 'Hide advanced' : 'Show advanced'}</span>
            {showAdvanced
              ? <ChevronDown className="size-3.5" aria-hidden="true" />
              : <ChevronRight className="size-3.5" aria-hidden="true" />}
          </button>
        </div>
      </aside>

      {/* Main content — each section renders its own h1 inside */}
      <div className="flex-1 min-w-0 overflow-auto">{children}</div>
    </div>
  );
}

/** Re-group a flat section list by category (used by search to bypass
 *  the tier filter). Generic so callers can pass either the full
 *  decorated list or the tier-filtered one. */
function groupAllByCategory<T extends { category?: string }>(items: ReadonlyArray<T>) {
  const m = new Map<string, T[]>();
  for (const s of items) {
    const k = s.category ?? '';
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(s);
  }
  return m;
}
