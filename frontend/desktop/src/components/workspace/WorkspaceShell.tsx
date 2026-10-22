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
import { MODAL_LAYER, modalLayerClass } from '@/components/overlays/modal-layers';
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
                (s.id === 'skills' || s.id === 'memory-knowledge') && inbox.total > 0
                ? String(inbox.total)
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


  return (
    /* Settings is a panel floating over the workspace rather than a page that
     * replaces it: the chat stays behind, and the panel owns its own scroll so
     * no section can stretch the frame.
     *
     * The backdrop DIMS what is behind it, because the reference does. The
     * captured Claude settings modal is "a centred modal on a DIMMED chat
     * behind it" (docs/plans/2026-10-11-ui-reference-capture.md:20) and the
     * captured Haze settings panel says the same — "The chat is dimmed behind
     * it" (the same file, :252). `bg-scrim` is the app's own scrim token
     * (--dt-overlay-scrim: 32% over the light ground, 55% over the dark one),
     * the same veil the responsive sidebar and drawer overlays already use.
     *
     * This backdrop used to carry NO tint, and the comment that sat here
     * claimed the reference agreed — it did not, and the claim is what kept
     * the behaviour in place. The panel is 920×680 and centred, so the dimmed
     * app reads around it exactly as the captured reference shows.
     *
     * The panel sits on the USER-OWNED rung of the modal ladder
     * (`components/overlays/modal-layers.ts`): above the app-owned first-run
     * surfaces, which step aside while it is open. Those surfaces used to
     * share this z-index with the panel, so the winner was decided by mount
     * order — the first-run setup checklist painted over this whole panel and
     * swallowed every click in it.
     *
     * Click-outside-to-close still works: the dialog stops propagation, so
     * only a click on the exposed app dismisses. */
    <div
      className={cn(
        'fixed inset-0 flex items-center justify-center bg-scrim p-3 sm:p-8',
        modalLayerClass(MODAL_LAYER.userOwned),
      )}
      onClick={closeToWorkspace}
      data-testid="settings-backdrop"
    >
      {/* The panel is sized by the ROWS it has to hold, and the rows are
       * three-column: a name, a value, and a date. At 920px the content
       * column was 616px, so the name took 210px and the value - the
       * informative column, the one the row exists for - was squeezed into
       * ~300px and truncated after ~48 characters, while the name sat in a
       * gap. The reference's settings is a WIDE panel (the owner's capture
       * measures ~1600px across) whose content column gives the value
       * ~690px.
       *
       * So the panel is wide now: 1440px, which is inside the reference's
       * own 860-1600px range, and the content column goes from 616px to
       * ~1080px. It is still a CENTRED modal over a live chat - that is
       * August's identity and the reference's shape too - and `w-full` plus
       * the padding keeps it honest on a narrow window.
       *
       * It used to be `h-full max-h-full` inside a `fixed inset-0` flex box,
       * which pinned it to the full viewport height minus padding: 92% of the
       * window at ANY window size, so opening settings covered essentially
       * the whole app. `min()` keeps the cap honest on a short window,
       * where the panel scrolls internally instead of overflowing. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={trapRef}
        className="relative flex max-h-[min(880px,calc(100vh-3rem))] w-full max-w-[1440px] overflow-hidden rounded-2xl border border-hairline-strong bg-background shadow-2xl"
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
          {isFiltering && totalShown === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No sections match{' '}
              <span className="font-mono">&ldquo;{query}&rdquo;</span>.
            </div>
          ) : (
            /* One shape for both modes — a labelled group over its rows. The
             * searching rail used to wrap each group in a tinted
             * `bg-sidebar-accent/40` panel that the resting rail did not have,
             * so the same list changed its grouping metaphor the moment you
             * typed. The reference has borderless rows with a label above them
             * in both states; this is that. */
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
          {/* The 680px cap was calibrated, but to the reference dialog as
              it was MEASURED THEN: a ~848px panel with a ~640px content
              column. The reference the owner attached is a different shape
              - a ~1600px settings panel whose content column is ~1290px,
              and whose memory rows are three columns at ONE type size with
              the VALUE column getting ~690px of them.
              At 680px the value column was 303px, so every value in the
              memory list truncated after ~48 characters while the name sat
              in a gap the width of a sentence. The cap is 1080px now,
              which is the same PROPORTION of the panel the reference has
              (81% of its width; 75% here), and the panels that carry
              their own inner measure are unaffected. */}
          <div
            className="flex min-h-full w-full max-w-[1080px] flex-col"
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
