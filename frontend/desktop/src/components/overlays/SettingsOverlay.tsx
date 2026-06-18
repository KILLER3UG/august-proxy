/* ── Settings overlay — redesigned 10-section control panel ────────── */
/* Replaces the old 18-tab sidebar. Sections are grouped by category,
 * searchable globally, and the active section resolves legacy deep links
 * (e.g. ?tab=traffic → Traffic & Activity) via the settings registry.
 * Pressed via Cmd+, or the Settings button in the titlebar. */

import { useEffect, lazy, Suspense, useMemo, useState, type ComponentType } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { X, SearchX } from 'lucide-react';
import { Backdrop } from '@/components/overlays/Backdrop';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useStore } from '@nanostores/react';
import { $gateway } from '@/store/gateway';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_SECTIONS,
  resolveLegacyTab,
  sectionsForCategory,
  type SettingsSection,
} from '@/settings/settings-registry';
import { SettingsSearch } from '@/components/settings/SettingsSearch';
import { SettingsTooltip } from '@/components/settings/SettingsTooltip';
import { SystemHealthSection } from '@/sections/settings/SystemHealthSection';
import { ProfilePreferencesSection } from '@/sections/settings/ProfilePreferencesSection';

/* Merged sections are code-split so they only load when opened. */
const ModelProvidersSection = lazy(() =>
  import('@/sections/settings/ModelProvidersSection').then((m) => ({ default: m.ModelProvidersSection })),
);
const ConversationsHistorySection = lazy(() =>
  import('@/sections/settings/ConversationsHistorySection').then((m) => ({ default: m.ConversationsHistorySection })),
);
const MemoryKnowledgeSection = lazy(() =>
  import('@/sections/settings/MemoryKnowledgeSection').then((m) => ({ default: m.MemoryKnowledgeSection })),
);
const ToolsConnectionsSection = lazy(() =>
  import('@/sections/settings/ToolsConnectionsSection').then((m) => ({ default: m.ToolsConnectionsSection })),
);
const TrafficActivitySection = lazy(() =>
  import('@/sections/settings/TrafficActivitySection').then((m) => ({ default: m.TrafficActivitySection })),
);
const ConversationInspectorSection = lazy(() =>
  import('@/sections/settings/ConversationInspectorSection').then((m) => ({ default: m.ConversationInspectorSection })),
);
const AgentsAutomationSection = lazy(() =>
  import('@/sections/settings/AgentsAutomationSection').then((m) => ({ default: m.AgentsAutomationSection })),
);
const DeveloperConsoleSection = lazy(() =>
  import('@/sections/settings/DeveloperConsoleSection').then((m) => ({ default: m.DeveloperConsoleSection })),
);

/** Map section id → component to render. Static + lazy where appropriate. */
const SECTION_COMPONENTS: Record<string, ComponentType> = {
  'system-health': SystemHealthSection,
  'profile-preferences': ProfilePreferencesSection,
  'model-providers': ModelProvidersSection,
  'conversations-history': ConversationsHistorySection,
  'memory-knowledge': MemoryKnowledgeSection,
  'tools-connections': ToolsConnectionsSection,
  'traffic-activity': TrafficActivitySection,
  'conversation-inspector': ConversationInspectorSection,
  'agents-automation': AgentsAutomationSection,
  'developer-console': DeveloperConsoleSection,
};

function SectionFallback() {
  return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
}

export function SettingsOverlay() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const g = useStore($gateway);

  const close = () => {
    const preSettingsPath = sessionStorage.getItem('pre-settings-path') || '/';
    navigate(preSettingsPath);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Resolve the active section, honoring legacy tab keys via the registry. */
  const rawTab = params.get('tab');
  const activeId = resolveLegacyTab(rawTab);
  const active: SettingsSection =
    SETTINGS_SECTIONS.find((s) => s.id === activeId) ?? SETTINGS_SECTIONS[0];

  /* Keep the URL canonical: if the raw tab is a legacy alias, normalize it
   * in place without triggering a navigation flicker. */
  useEffect(() => {
    if (rawTab && rawTab !== active.id) {
      setParams({ tab: active.id }, { replace: true });
    }
  }, [rawTab, active.id, setParams]);

  const select = (id: string) => setParams({ tab: id });

  /* Global search across label/category/description/keywords. */
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return SETTINGS_SECTIONS;
    return SETTINGS_SECTIONS.filter((s) => {
      const haystack = [s.label, s.description, s.category, ...s.keywords]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [q]);
  const matchIds = useMemo(() => new Set(matches.map((m) => m.id)), [matches]);

  const ActiveComponent = SECTION_COMPONENTS[active.id] ?? SystemHealthSection;

  return (
    <Backdrop onClose={close}>
      <div className="flex h-[min(90vh,720px)] w-[min(95vw,1100px)] overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        {/* ── Sidebar ─────────────────────────────────────────────── */}
        <aside className="flex w-60 flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground">
          <div className="shrink-0 px-3 pb-2 pt-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <span className="grid size-6 place-items-center rounded-md bg-primary text-[10px] text-primary-foreground">
                A
              </span>
              Settings
            </h2>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              {g.status === 'open' ? `running :${g.port || '?'}` : g.status}
            </p>
          </div>

          <div className="shrink-0 px-3 pb-2">
            <SettingsSearch value={query} onChange={setQuery} />
          </div>

          <nav className="flex-1 overflow-y-auto px-2 pb-2">
            {matches.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
                <SearchX className="size-5 text-muted-foreground/60" />
                <p className="text-xs text-muted-foreground">
                  No settings match &ldquo;{query}&rdquo;
                </p>
                <button
                  onClick={() => setQuery('')}
                  className="text-[11px] text-primary hover:underline"
                >
                  Clear search
                </button>
              </div>
            ) : (
              SETTINGS_CATEGORIES.map((cat) => {
                const catSections = sectionsForCategory(cat.id).filter((s) => matchIds.has(s.id));
                if (catSections.length === 0) return null;
                return (
                  <div key={cat.id} className="mb-2">
                    <div className="flex items-center gap-1 px-2 pb-1 pt-2">
                      <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                        {cat.label}
                      </p>
                      <SettingsTooltip content={cat.description} label={`${cat.label} category info`} />
                    </div>
                    {catSections.map((s) => (
                      <NavButton
                        key={s.id}
                        section={s}
                        active={active.id === s.id}
                        onSelect={() => select(s.id)}
                      />
                    ))}
                  </div>
                );
              })
            )}
          </nav>

          <div className="shrink-0 border-t border-sidebar-border px-3 py-2 font-mono text-[10px] text-muted-foreground">
            <kbd className="rounded border border-sidebar-border bg-muted px-1">esc</kbd> to close
          </div>
        </aside>

        {/* ── Content ─────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex min-w-0 items-center gap-2">
              <active.icon className="size-4 shrink-0 text-muted-foreground" />
              <h3 className="truncate text-sm font-semibold">{active.label}</h3>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close settings">
              <X />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <Suspense fallback={<SectionFallback />}>
              <ActiveComponent />
            </Suspense>
          </div>
        </div>
      </div>
    </Backdrop>
  );
}

function NavButton({
  section,
  active,
  onSelect,
}: {
  section: SettingsSection;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = section.icon;
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{section.label}</span>
    </button>
  );
}
