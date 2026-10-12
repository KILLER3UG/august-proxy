/* ── WorkspaceShell — settings-panel shell (chat-side) ───────────────── */
/* Mounted by SettingsPage inside ChatLayout. Renders the dark left rail */
/* + scrollable content area. Section nav clicks use `/settings/:id` — */
/* the Settings overlay route. The previous `/workspace/*` routes were     */
/* retired when Settings absorbed the panel.                                   */

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useSettingsFieldLink } from '@/hooks/useSettingsFieldLink';
import {
  ArrowUpCircle,
  BrainCircuit,
  Globe,
  LineChart,
  Settings2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { WorkspaceNavLink } from './WorkspaceNavLink';
import { SettingsSearch } from '@/components/settings/SettingsSearch';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { useAccountStore } from '@/store/account';
import { useReviewInboxCount } from '@/lib/useReviewInboxCount';
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

/** Map of category id → lucide icon for the rail group header.
 *  3 header groups (2026-08-28 restructure): Basics / Agent
 *  Capabilities / Data & Statistics. */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  basics: Settings2,
  capabilities: BrainCircuit,
  data: LineChart,
};

interface WorkspaceShellProps {
  sections: WorkspaceSectionMeta[];
  active: string;
  children: ReactNode;
}

export function WorkspaceShell({
  sections,
  active,
  children,
}: WorkspaceShellProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true);
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

  // Header IA: no tier filter — all sections stay reachable, but the rail
  // only shows the 3 header groups when not searching. Search bypasses
  // headers and surfaces matching sections directly (grouped by category)
  // so deep discovery still works. Hidden sections never appear as rail
  // rows; they live inside their parent's stacked cards or as tree
  // (no tree grandchildren — the rail is flat; hidden-tier sections are search-only).
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
  // Rows the rail actually draws, on its resting (unfiltered) shape: every
  // basic-tier section except the Onboard entry, which renders as a separate
  // standalone row rather than inside the list.
  const railRowCount = useMemo(
    () => decorated.filter((s) => s.tier !== 'hidden' && s.id !== 'ai-setup').length,
    [decorated],
  );
  const totalShown = useMemo(() => {
    if (isFiltering) return Array.from(filtered.values()).reduce((n, items) => n + items.length, 0);
    return railRowCount;
  }, [railRowCount, filtered, isFiltering]);

  const closeToWorkspace = useCallback(() => {
    // Return to the exact chat the user came from (saved when navigating into
    // /settings), not always "/".
    const back = sessionStorage.getItem('pre-settings-path');
    void navigate(back && back !== location.pathname ? back : '/');
    sessionStorage.removeItem('pre-settings-path');
  }, [navigate, location.pathname]);

  // Escape closes the panel the way it does in Claude — the surface is
  // transient, so it should leave the way a dialog does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const nestedDialogOpen = Array.from(document.querySelectorAll('[role="dialog"]'))
        .some((dialog) => dialog !== trapRef.current);
      if (!nestedDialogOpen) closeToWorkspace();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [location.pathname, location.search, closeToWorkspace, trapRef]);

  return (
    /* Settings is a panel floating over the workspace rather than a page that
     * replaces it: the chat stays behind, and the panel owns its own scroll so
     * no section can stretch the frame.
     *
     * The backdrop carries NO tint. The reference settings modal floats over a
     * completely unchanged app — sidebar, transcript and composer all stay at
     * full brightness — and `bg-scrim` here was `rgb(0 0 0 / 0.55)`, which
     * visibly darkened every one of them. Modality is still enforced by what
     * actually enforces it: `aria-modal` and the focus trap. The dialog's own
     * hairline border and shadow are what separate it visually, which is the
     * affordance the reference uses. Click-outside-to-close still works — this
     * element is the hit target either way.
     *
     * Click handling is unchanged and still safe with a transparent fill: the
     * dialog stops propagation, so only a click on the exposed app dismisses. */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-8"
      onClick={closeToWorkspace}
      data-testid="settings-backdrop"
    >
      {/* 920x680 — the reference panel's exact measured size. It used to be
       * `h-full max-h-full` inside a `fixed inset-0` flex box, which pinned it
       * to the full viewport height minus padding: 92% of the window at ANY
       * window size, so opening settings covered essentially the whole app.
       * `min()` keeps the cap honest on a short window, where the panel
       * scrolls internally instead of overflowing. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={trapRef}
        className="relative flex max-h-[min(680px,calc(100vh-4rem))] w-full max-w-[920px] overflow-hidden rounded-2xl border border-hairline-strong bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left rail.
            No `h-full`: the panel's height is content-driven and capped by
            `max-h`, so a percentage height resolves against an indefinite
            parent and falls back to the rail's own content height — 670px
            inside a 636px panel, with the profile footer clipped by the
            panel's `overflow-hidden`. `align-items: stretch` plus `min-h-0`
            makes the rail exactly the panel height and lets the inner nav
            scroll, which is what the row of 17 sections needs.

            The rail is RESPONSIVE, and that was measured rather than assumed.
            At a fixed `w-60` (240px) it never yielded, so forcing the panel
            narrow produced: 560px panel -> 313px column with the "Dark" button
            of the Mode control pushed outside it; 420px -> 173px column with
            System/Light/Dark AND all four font pills overflowing; 340px -> 93px
            column and a horizontal scrollbar on the content region. `w-44`
            below `sm` gives the column 360px at a 560px panel and 220px at
            420px, which holds. The reference rail is narrow too (~180px in an
            880px panel) — this is that proportion, applied responsively. */}
        <aside
          className="flex min-h-0 w-44 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar sm:w-60"
          aria-label="Settings sections"
        >
          <div className="px-3 pb-2 pt-3">
          <SettingsSearch value={query} onChange={setQuery} />
          {isFiltering && (
            /* Search reaches EVERY section, the 26 hidden ones included — that
             * is deliberate, since they are deep-linkable and otherwise
             * unreachable. So the honest denominator is the whole registry,
             * not the 17 rows the rail draws: naming the rail count too is
             * what stops "2 of 43" reading as a contradiction of a 17-row
             * list. Announced because filtering a rail is otherwise silent. */
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
                    <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/40">
                      <Icon className="size-3" aria-hidden="true" />
                      <span>{categoryLabel}</span>
                    </div>
                    <div className="flex flex-col gap-0.5 rounded-xl bg-sidebar-accent/40 py-1">
                    {items.map((s) => {
                      // Show the matching CONTROL under a setting-level hit —
                      // "auto inject" → Memory → "Auto-recall memories…".
                      const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
                      const hitHint = (s.settingHints ?? []).find((h) => {
                        const hl = h.toLowerCase();
                        return tokens.every((t) => hl.includes(t));
                      });
                      return (
                        <div key={s.id}>
                          <WorkspaceNavLink
                            icon={s.icon}
                            label={s.label}
                            active={railActive === s.id}
                            badge={
                              s.id === 'app-updates' && updateAvailable
                                ? 'New'
                                : s.id === 'harness-improve' && inbox.total > 0
                                  ? String(inbox.total)
                                  : null
                            }
                            onSelect={() => {
                              // Already-open tab with no control to name is a
                              // no-op; a control hit still has work to do even
                              // when its tab is the one on screen.
                              if (s.id === railActive && s.id === active && !hitHint) return;
                              setQuery('');
                              // Carry the control the search matched as ?field=
                              // so the two halves of the deep link connect: the
                              // tab opens AND its control is scrolled to and
                              // flashed. A keyword-only hit has no control to
                              // name, so it navigates bare.
                              void navigate(
                                `/settings/${s.id}${
                                  hitHint ? `?field=${encodeURIComponent(hitHint)}` : ''
                                }`,
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
                    })}
                    </div>
                  </div>
                );
              })
            )
          ) : (
            <div className="px-2 py-1 flex flex-col gap-0.5">
              {decorated
                .filter((s) => s.tier !== 'hidden' && s.id !== 'ai-setup')
                .map((s) => (
                  <WorkspaceNavLink
                    key={s.id}
                    icon={s.icon}
                    label={s.label}
                    active={active === s.id || railActive === s.id}
                    badge={
                      s.id === 'app-updates' && updateAvailable
                        ? 'New'
                        : s.id === 'harness-improve' && inbox.total > 0
                          ? String(inbox.total)
                          : null
                    }
                    onSelect={() => {
                      if (s.id === active) return;
                      setQuery('');
                      void navigate(`/settings/${s.id}`);
                    }}
                  />
                ))}
              {/* Standalone Onboard entry */}
              {(() => {
                const onboard = getSection('ai-setup');
                if (!onboard || !decorated.some((s) => s.id === onboard.id)) return null;
                return (
                  <div className="pt-1">
                    <WorkspaceNavLink
                      key={onboard.id}
                      icon={onboard.icon}
                      label={onboard.label}
                      active={active === onboard.id || railActive === onboard.id}
                      onSelect={() => {
                        if (onboard.id === active) return;
                        setQuery('');
                        void navigate(`/settings/${onboard.id}`);
                      }}
                    />
                  </div>
                );
              })()}
            </div>
          )}
        </nav>

        {/* Bottom profile row — mirrors the reference design's pinned identity
            footer. Routes to the local Accounts manager. */}
        <ProfileRailRow />
      </aside>

      {/* The reading column is centred in the space LEFT BY THE RAIL, and is
         * deliberately NOT re-centred on the window. It used to carry `pr-60`
         * — mirroring the rail's width on the right — to put the column's
         * centre on screen centre. That cost 240px of content width: measured
         * 361px of usable column inside an 848px panel, against ~640px in the
         * reference. And the thing it bought does not exist in the reference.
         * Haze's dialog spans 520..1400 (centre 960, the window centre) while
         * its content pane spans 731..1372 — centre 1051, i.e. 91px RIGHT of
         * window centre, because the rail sits inside the modal on the left. A
         * left rail in a centred dialog pushes its content pane right by
         * construction; every reference works that way.
         *
         * So the lost width was the bug and the off-centre column was never
         * the fix. `workspace-shell-tier-filter.test.tsx` asserted `pr-60` was
         * load-bearing; that pinned the wrong claim as a test, so it is
         * rewritten below rather than deleted.
         *
         * contentRef scopes the ?field= deep link to the section body, so a
         * control search never resolves against the rail that listed it.
         * overflow-x-hidden: wide children (tables, pre) must not give the
         * whole settings pane a horizontal scrollbar. */}
        <div
          ref={contentRef}
          className="flex min-h-0 flex-1 justify-center overflow-y-auto overflow-x-hidden"
          data-testid="settings-content-region"
        >
          <div
            className="flex min-h-full w-full max-w-[680px] flex-col"
            data-testid="settings-content-column"
          >
            {children}
          </div>
        </div>

        {/* Claude puts the dismiss control at the top-right of the content pane,
            not in the nav rail — the rail is for moving around inside. */}
        <button
          type="button"
          onClick={closeToWorkspace}
          aria-label="Close settings"
          title="Close settings (Esc)"
          data-testid="settings-close"
          className="absolute right-3 top-3 z-10 rounded-lg p-1.5 text-muted-foreground/70 transition hover:bg-muted/60 hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
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
