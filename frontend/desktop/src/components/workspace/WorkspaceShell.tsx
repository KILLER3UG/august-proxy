/* ── WorkspaceShell — settings-panel shell (chat-side) ───────────────── */
/* Mounted by SettingsPage inside ChatLayout. Renders the dark left rail */
/* + scrollable content area. Section nav clicks use `/settings/:id` — */
/* the Settings overlay route. The previous `/workspace/*` routes were     */
/* retired when Settings absorbed the panel.                                   */

import { type ReactNode, useMemo, useRef, useState } from 'react';
import { useSettingsFieldLink } from '@/hooks/useSettingsFieldLink';
import {
  ArrowUpCircle,
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  Globe,
  LineChart,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { WorkspaceNavLink } from './WorkspaceNavLink';
import { Button } from '@/components/ui/button';
import { SettingsSearch } from '@/components/settings/SettingsSearch';
import {
  SETTINGS_COLUMN_CLASS,
  SETTINGS_CONTENT_CLASS,
  SETTINGS_PAGE_CLASS,
  SETTINGS_RAIL_CLASS,
} from '@/components/settings/SettingsFrame';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { useAccountStore } from '@/store/account';
import { useReviewInboxCount } from '@/lib/useReviewInboxCount';
import { cn } from '@/lib/utils';
import {
  SETTINGS_SECTIONS,
  SETTINGS_CATEGORIES,
  railCanonicalId,
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
 *  4 header groups (Setup / Agent / Data / App;
 *  the fourth was added after the 2026-08-28 restructure). */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  basics: Settings2,
  capabilities: BrainCircuit,
  data: LineChart,
};

interface WorkspaceShellProps {
  sections: WorkspaceSectionMeta[];
  active: string;
  children: ReactNode;
  /** The phone tier: the rail has nowhere to live at 390px. */
  mobile?: boolean;
  /** At `/settings` with no section on a phone: the catalog of sections IS
   *  the screen (the mockup's settings list), and a section opens over it
   *  with a back row. On desktop that URL normalises to the landing section
   *  instead, so this never renders there. */
  mobileHome?: boolean;
}

export function WorkspaceShell({
  sections,
  active,
  children,
  mobile = false,
  mobileHome = false,
}: WorkspaceShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const { available: updateAvailable } = useAppUpdate();
  const inbox = useReviewInboxCount();

  // Field deep link — /settings?tab=X&field=Y (or the path form with ?field=)
  // names a control inside the section. Defaulted because the shell reads the
  // location directly, and `?section`/`?field` are optional by contract.
  const { search = '' } = location;
  const fieldParam = new URLSearchParams(search).get('field') ?? '';
  const contentRef = useRef<HTMLDivElement>(null);
  useSettingsFieldLink(contentRef, fieldParam, active);

  const railActive = railCanonicalId(active);

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
        // Control-level labels + search-only aliases for setting-level
        // search (see the registry's `settingHints` / `settingAliases`).
        settingHints: fromRegistry?.settingHints ?? [],
        settingAliases: fromRegistry?.settingAliases ?? [],
      };
    });
  }, [sections]);

  // Rail IA: grouped under the four `SETTINGS_CATEGORIES` headers (Setup /
  // Agent / Data / App), in the SAME shape resting and searching.
  //
  // The resting rail was a flat list from `c5748da0` — the commit that also
  // shrank this panel from full height to 920x680. The headers went with the
  // height in one batch, not by a decision anyone wrote down, and what it cost
  // is visible in the rail: with no headings, `About` sat between `Computer
  // Use` and `Memory` with nothing marking the boundary between one group and
  // the next, and the tier legend ("basic vs hidden") was the only thing that
  // said why 26 sections were missing. The reference capture
  // (`docs/plans/2026-10-11-ui-reference-capture.md` §5) has the nav "grouped
  // into labelled sections" the whole time, with labels "small, muted,
  // sentence case — NOT uppercase"; the flat list did not even buy the density
  // it implied, since 18 rows already overflowed the rail by 27px.
  //
  // Hidden-tier sections still never appear as rows, and that part IS
  // deliberate: they stay deep-linkable, palette-reachable and searchable
  // (search reaches all of them, and the count caption says so).
  const railGroups = useMemo(
    () => groupAllByCategory(decorated.filter((s) => s.tier !== 'hidden')),
    [decorated],
  );
  const visibleForSearch = useMemo(() => decorated, [decorated]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Map<string, typeof decorated>();
    // Tokenized AND matching: "auto update" finds a section carrying both
    // words even when the phrase is not a substring of any single field.
    // Single-substring search needed ~300 keyword crutches for this.
    const tokens = q.split(/\s+/).filter(Boolean);
    const match = (s: (typeof decorated)[number]) => {
      const haystack = [s.label, s.description, ...s.keywords].join(' ').toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    };
    // Setting-level matching: the individual control labels each section
    // owns (registry `settingHints`), plus search-only aliases for names
    // people actually type (the brain-config key `memoryAutoInject` lives in
    // `settingAliases`), so the query finds the SETTING, not just the page it
    // lives on.
    const hintMatch = (s: (typeof decorated)[number]): boolean => {
      const terms = [...(s.settingHints ?? []), ...(s.settingAliases ?? [])].map((h) =>
        h.toLowerCase(),
      );
      if (!terms.length) return false;
      return tokens.every((t) => terms.some((h) => h.includes(t)));
    };
    const ids = new Set<string>();
    for (const s of visibleForSearch) {
      if (!match(s) && !hintMatch(s)) continue;
      ids.add(s.id);
    }
    const chosen = decorated.filter((s) => ids.has(s.id));
    return groupAllByCategory(chosen);
  }, [decorated, visibleForSearch, query]);

  const isFiltering = query.trim().length > 0;
  // Rows the resting rail draws (`railGroups` minus the Onboard entry, which
  // renders as its own row rather than inside the list). Derived from
  // `railGroups` rather than re-applying the filter, so the count and the list
  // cannot disagree about what "in the rail" means.
  const railRowCount = useMemo(
    () => Array.from(railGroups.values()).reduce((n, items) => n + items.length, 0),
    [railGroups],
  );
  const totalShown = useMemo(() => {
    if (isFiltering) return Array.from(filtered.values()).reduce((n, items) => n + items.length, 0);
    return railRowCount;
  }, [railRowCount, filtered, isFiltering]);

  // The page is a route now; the sidebar and the titlebar are the way out.
  // The old Escape/click-outside dismiss belonged to the dialog.

  /** The CONTROL a query matched inside this section, if any: "auto inject" →
   *  Memory → "Auto-recall memories…". Only meaningful while filtering. */
  const hitHintFor = (s: (typeof decorated)[number]): string | undefined => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return undefined;
    return (s.settingHints ?? []).find((h) => {
      const hl = h.toLowerCase();
      return tokens.every((t) => hl.includes(t));
    });
  };

  /** One rail row, shared by the resting and the searching rail. The two shapes
   *  used to build `WorkspaceNavLink` inline with their own copy of the badge,
   *  active and navigate logic — and the copies had already drifted (the
   *  resting one ignored a matched control, so a search that named one could
   *  not deep-link to it). One row builder is what keeps a heading's group
   *  honest about what it contains. */
  const railRow = (s: (typeof decorated)[number], hitHint?: string) => {
    const isActive = isFiltering
      ? railActive === s.id
      : active === s.id || railActive === s.id;
    return (
      <div key={s.id}>
        <WorkspaceNavLink
          icon={s.icon}
          label={s.label}
          active={isActive}
          badge={
            s.id === 'app-updates' && updateAvailable
              ? 'New'
              : // The review inbox has no door of its own any more — proposals
                // live inside Skills and Memory — so the ambient "there is
                // something to decide" badge marks those two doors instead.
                // Each door counts only its own family: one skill proposal
                // used to paint the same total on Memory too.
                s.id === 'skills' && inbox.harness > 0
                ? String(inbox.harness)
                : s.id === 'memory-knowledge' && inbox.memory > 0
                  ? String(inbox.memory)
                  : null
          }
          onSelect={() => {
            if (!isFiltering) {
              // Resting: the open section is a no-op, any other row navigates.
              if (s.id === active) return;
              setQuery('');
              void navigate(`/settings/${s.id}`);
              return;
            }
            // Searching: an already-open section with no control to name is a
            // no-op; a control hit still has work to do even when its section
            // is the one on screen.
            if (s.id === railActive && s.id === active && !hitHint) return;
            setQuery('');
            // Carry the control the search matched as ?field= so the two halves
            // of the deep link connect: the section opens AND its control is
            // scrolled to and flashed. A keyword-only hit names no control, so
            // it navigates bare.
            void navigate(
              `/settings/${s.id}${hitHint ? `?field=${encodeURIComponent(hitHint)}` : ''}`,
            );
          }}
        />
        {hitHint && (
          <p
            className="truncate px-9 pb-1 text-2xs text-muted-foreground/60"
            data-testid={`settings-hit-hint-${s.id}`}
          >
            {hitHint}
          </p>
        )}
      </div>
    );
  };


  /* ── Phone tier ────────────────────────────────────────────────────────
   * The mockup's settings screen is a LIST of doors; a door opens a section
   * with a back row. At 390px a 204px rail beside the content would leave
   * ~150px of panel, so the rail becomes the screen and the section becomes
   * the pushed view. Everything else about a section is unchanged — the same
   * components, the same deep links, the same search. */
  if (mobile) {
    const groups = isFiltering ? filtered : railGroups;
    if (mobileHome) {
      return (
        <div className={SETTINGS_PAGE_CLASS} data-testid="settings-page">
          <div className={SETTINGS_CONTENT_CLASS} data-testid="settings-content-region">
            <div className={cn(SETTINGS_COLUMN_CLASS, 'px-4 pb-8 pt-3')}>
              <div className="px-1 pb-3">
                <SettingsSearch value={query} onChange={setQuery} />
              </div>
              {isFiltering && totalShown === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No sections match <span className="font-mono">&ldquo;{query}&rdquo;</span>.
                </div>
              ) : (
                <div className="flex flex-col gap-5">
                  {Array.from(groups.entries()).map(([category, items]) => (
                    <div key={category || 'default'}>
                      <RailGroupHeading
                        icon={items[0]?.categoryIcon ?? Globe}
                        label={items[0]?.categoryLabel ?? category}
                      />
                      <div className="mt-1.5 overflow-hidden rounded-lg border border-border/60 bg-card">
                        {items.map((s) => (
                          <Button
                            key={s.id}
                            variant="ghost"
                            type="button"
                            data-testid={`settings-door-${s.id}`}
                            onClick={() => {
                              setQuery('');
                              void navigate(`/settings/${s.id}`);
                            }}
                            className="flex w-full items-center gap-3 rounded-none border-b border-border/50 px-3 py-2.5 text-left last:border-b-0"
                          >
                            <s.icon className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[0.8125rem] font-medium text-foreground">
                                {s.label}
                              </span>
                              {s.description ? (
                                <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                                  {s.description}
                                </span>
                              ) : null}
                            </span>
                            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className={SETTINGS_PAGE_CLASS} data-testid="settings-page">
        <div className={SETTINGS_CONTENT_CLASS} data-testid="settings-content-region">
          <div className={SETTINGS_COLUMN_CLASS} data-testid="settings-content-column">
            <div className="px-4 pt-2">
              <Button
                variant="ghost"
                type="button"
                className="-ml-2 h-8 gap-1 px-2 text-xs text-muted-foreground"
                onClick={() => void navigate('/settings')}
                data-testid="settings-back"
              >
                <ChevronLeft className="size-3.5" /> Settings
              </Button>
            </div>
            {children}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={SETTINGS_PAGE_CLASS} data-testid="settings-page">
      <aside className={SETTINGS_RAIL_CLASS} aria-label="Settings sections">
        <div className="px-3 pb-2 pt-3">
          <SettingsSearch value={query} onChange={setQuery} />
          {isFiltering && (
            <p
              className="mt-1.5 px-1 text-xs text-muted-foreground/70"
              role="status"
              data-testid="settings-search-count"
            >
              {totalShown} of {decorated.length} sections · {railRowCount} in the rail
            </p>
          )}
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto pb-3 pt-1" aria-label="Settings">
          {isFiltering && totalShown === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No sections match <span className="font-mono">&ldquo;{query}&rdquo;</span>.
            </div>
          ) : (
            <div className="flex flex-col gap-1 px-2 py-1">
              {Array.from((isFiltering ? filtered : railGroups).entries()).map(
                ([category, items]) => (
                  <div key={category || 'default'} className="flex flex-col gap-0.5">
                    <RailGroupHeading
                      icon={items[0]?.categoryIcon ?? Globe}
                      label={items[0]?.categoryLabel ?? category}
                    />
                    {items.map((s) => railRow(s, isFiltering ? hitHintFor(s) : undefined))}
                  </div>
                ),
              )}
            </div>
          )}
        </nav>
        <ProfileRailRow />
      </aside>

      <div
        ref={contentRef}
        className={SETTINGS_CONTENT_CLASS}
        data-testid="settings-content-region"
      >
        <div className={SETTINGS_COLUMN_CLASS} data-testid="settings-content-column">
          {children}
        </div>
      </div>
    </div>
  );
}

/** The label above a cluster of rail rows — the same element in the resting
 *  and the searching rail, which is what keeps the two shapes from drifting.
 *
 *  Sentence case, small and muted, and NOT uppercase: the reference capture
 *  measures these labels as "small, muted, sentence case — NOT uppercase"
 *  (`docs/plans/2026-10-11-ui-reference-capture.md` §5, "Left nav"), and the
 *  searching rail used to shout them in `uppercase tracking-wide` while the
 *  resting rail had none at all. */
function RailGroupHeading({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  return (
    <div
      className="flex items-center gap-1.5 px-2 pt-2 pb-0.5 text-xs font-medium text-sidebar-foreground/50"
      data-testid="settings-rail-group"
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
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
    <div className="min-h-0 shrink-0 border-t border-sidebar-border p-2">
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
          <span className="block truncate text-[0.8125rem] font-medium text-sidebar-foreground">
            {account.displayName}
          </span>
          <span className="block truncate text-xs text-sidebar-foreground/55">
            {account.email || `@${account.username}` || 'Local account'}
          </span>
        </span>
        <Settings2 className="size-3 shrink-0 text-sidebar-foreground/40" aria-hidden="true" />
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
            'size-3 shrink-0',
            updateAvailable ? 'text-warning-fg' : 'text-sidebar-foreground/40',
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground/60">
          {updateAvailable ? `Update available · v${updateAvailable.version}` : 'Up to date'}
        </span>
      </button>
    </div>
  );
}
