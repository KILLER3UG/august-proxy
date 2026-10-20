/* ── LearningHub — the learning loop as one work surface (/learning) ──── */
/* Strictly ADDITIVE. Settings keeps every panel it already had, and the
 * settings registry is untouched: this route groups five surfaces by what a
 * human does with them — decide (Inbox), inspect what was learned (Skills /
 * Memory), watch the background passes (Scheduler), and read what the
 * journal measured (Decisions).
 *
 * Every tab renders an EXISTING section component. Nothing is forked,
 * re-implemented, or moved; there is one implementation of the review inbox,
 * the skills catalogue, the memory browser, and the job ledger, and this
 * route is one more door into each. */

import { useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  CalendarClock,
  Database,
  GraduationCap,
  HeartPulse,
  Scale,
  type LucideIcon,
} from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { WorkspaceNavLink } from '@/components/workspace/WorkspaceNavLink';
import { useReviewInboxCount } from '@/lib/useReviewInboxCount';
import { DecisionsSection } from '@/sections/settings/DecisionsSection';
import { HarnessImprovementsSection } from '@/sections/settings/HarnessImprovementsSection';
import { LearningPanel } from '@/sections/settings/LearningPanel';
import { MemorySection } from '@/sections/settings/MemorySection';
import { SkillsSection } from '@/sections/settings/SkillsSection';

type HubTabId = 'inbox' | 'skills' | 'memory' | 'scheduler' | 'decisions';

interface HubTab {
  id: HubTabId;
  label: string;
  Icon: LucideIcon;
  /** The Inbox row wears the pending-decision count — the same number the
   *  settings rail shows on its review-inbox row, so a proposal waiting for
   *  approval is visible from the Learning hub and the main nav rail too. */
  countsDecisions?: boolean;
}

const TABS: readonly HubTab[] = [
  { id: 'inbox', label: 'Inbox', Icon: HeartPulse, countsDecisions: true },
  { id: 'skills', label: 'Skills', Icon: BookOpen },
  { id: 'memory', label: 'Memory', Icon: Database },
  { id: 'scheduler', label: 'Scheduler', Icon: CalendarClock },
  { id: 'decisions', label: 'Decisions', Icon: Scale },
];

/* MemorySection keys its browse-state reset off the settings id it is handed.
 * A hub-local id keeps a deep-linked tab from inheriting the settings page's
 * last-opened entry. */
const HUB_MEMORY_ID = 'learning-hub-memory';

/* Header grammar — decided ONCE, here, because three surfaces used to each
 * invent their own and the plan asked for a single ruling:
 *
 *   • A ROUTE page owns the header under the titlebar: an icon, the page
 *     name, one muted line saying what the page is for. Runs, History and
 *     the Agent Board are shaped this way.
 *   • A SECTION inside a panel uses `SectionHeader` — no icon (the nav
 *     already carries it) and a smaller title.
 *   • A RAIL keeps its own rail header. A rail is navigation, not content,
 *     so it does not take SectionHeader.
 *   • A full-screen MODE surface keeps its own top bar (see LiveSurface).
 *     It is not a page — the chat stays visible behind it, and a page
 *     header would claim the whole window for a mode.
 *
 * What that means HERE, now that the hub is the second home of the four
 * settings sections:
 *
 *   • The hub is a ROUTE, so the hub owns a rail header ("Learning" + the
 *     graduation cap) — the rail header it already had.
 *   • Each TAB is a SECTION inside that route, so each tab's content opens
 *     with `SectionHeader` (no icon — the rail row carries it). The
 *     Inbox, Skills and Scheduler tabs do; the Memory tab follows the
 *     reference capture literally and opens straight into its own section
 *     headers ("You", "Topics", "Notes", "Rules"), which is what the
 *     Claude memory list does.
 *   • The four sections render the SAME header in the SETTINGS host as
 *     they do here. One shape, two homes — see `host.ts` for the one
 *     difference that survives (a link that leaves the surface). */

export function LearningHub() {
  /* The tab is a local view, not a route segment — the hub is ONE nav
   * destination and each tab is a view inside it, the way the settings rail
   * is a view inside /settings. It is still DEEP-LINKABLE, though: a link
   * from another surface (the skills detail's "Review inbox") has to be able
   * to land on a named tab, and `?tab=` is the only way to say which one
   * without turning five tabs into five routes.
   *
   * The PARAMETER is the single source of truth — one `?tab=`, read by the
   * hub and written by the rail. A second copy of the tab (local state) would
   * be a second truth, and the two would disagree the moment a reader edited
   * the URL by hand. */
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab: HubTabId =
    requested && TABS.some((t) => t.id === requested) ? (requested as HubTabId) : 'inbox';
  const inbox = useReviewInboxCount();

  /** Select a tab and write it into the URL, so the view can be linked to.
   * `replace` — the hub is one destination, so moving between its tabs is
   * not a navigation the back button should walk. */
  const selectTab = (id: HubTabId) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', id);
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div className="flex h-full min-h-0" data-testid="learning-hub">
      {/* Left rail — same shape, width and row component as the settings
          rail, so the two read as the same instrument. */}
      <aside className="flex h-full w-44 shrink-0 flex-col border-r border-sidebar-border bg-sidebar sm:w-60">
        <div className="flex items-center gap-2 px-4 py-3">
          <GraduationCap className="size-4 text-primary" aria-hidden="true" />
          <span className="text-[0.8125rem] font-semibold text-sidebar-foreground">
            Learning
          </span>
        </div>
        <nav
          className="min-h-0 flex-1 overflow-y-auto pb-3"
          aria-label="Learning sections"
        >
          {/* Borderless rows, like the settings rail: the tinted panel this
              used to wrap them in changed the grouping metaphor of the same
              list, and the reference's nav rows have no background. */}
          <div className="flex flex-col gap-0.5 px-2 py-1">
            {TABS.map(({ id, label, Icon, countsDecisions }) => (
              <WorkspaceNavLink
                key={id}
                icon={Icon}
                label={label}
                active={tab === id}
                badge={countsDecisions && inbox.total > 0 ? String(inbox.total) : null}
                onSelect={() => selectTab(id)}
              />
            ))}
          </div>
        </nav>
      </aside>

      {/* Content pane. Panels that own their scroll (Inbox, Skills) fill it;
          the ones that flow (Memory, Decisions, the Learning panel card)
          ride its scrollbar — one rule for all of them. */}
      <div className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {tab === 'inbox' ? <HarnessImprovementsSection /> : null}
        {tab === 'skills' ? <SkillsSection host="hub" /> : null}
        {tab === 'memory' ? <MemorySection active={{ id: HUB_MEMORY_ID }} /> : null}
        {tab === 'scheduler' ? (
          <div className="px-8 py-6">
            {/* A tab is a SECTION inside the route, so it takes SectionHeader:
                no icon (the rail row carries it) and a smaller title. The
                panel below keeps its own collapsed-header grammar — it is a
                card, and a card names itself. */}
            <SectionHeader
              title="Scheduler"
              subtitle="The background passes that learn from your sessions, and when each one last ran"
              className="mb-4"
            />
            <LearningPanel defaultExpanded />
          </div>
        ) : null}
        {tab === 'decisions' ? <DecisionsSection /> : null}
      </div>
    </div>
  );
}
