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
  Cpu,
  Globe,
  LineChart,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { WorkspaceNavLink } from './WorkspaceNavLink';
import { SettingsSearch } from '@/components/settings/SettingsSearch';
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

  // Resolve each section's category label and icon. Falls back to the
  // raw `category` string if a section isn't in the settings registry
  // (e.g., legacy workspace-registry panels still calling this).
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
        // Pull description/keywords from the registry when available —
        // gives the search something useful to match.
        description: fromRegistry?.description ?? '',
        keywords: fromRegistry?.keywords ?? [],
      };
    });
  }, [sections]);

  // Group sections by category while preserving registry order.
  const grouped = useMemo(() => {
    const m = new Map<string, typeof decorated>();
    for (const s of decorated) {
      const k = s.category ?? '';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return m;
  }, [decorated]);

  // Filter by free-text query (matches label, description, keywords).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return grouped;
    const m = new Map<string, typeof decorated>();
    for (const [cat, items] of grouped.entries()) {
      const kept = items.filter((s) => {
        if (s.label.toLowerCase().includes(q)) return true;
        if (s.description.toLowerCase().includes(q)) return true;
        if (s.keywords.some((k) => k.toLowerCase().includes(q))) return true;
        return false;
      });
      if (kept.length > 0) m.set(cat, kept);
    }
    return m;
  }, [grouped, query]);

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
      </aside>

      {/* Main content — each section renders its own h1 inside */}
      <div className="flex-1 min-w-0 overflow-auto">{children}</div>
    </div>
  );
}
