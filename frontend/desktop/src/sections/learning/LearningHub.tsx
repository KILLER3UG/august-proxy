/* ── LearningHub — the learning loop as one work surface (/learning) ──── */
/* Strictly ADDITIVE. Settings keeps every panel it already had, and the
 * settings registry is untouched: this route groups the same four surfaces
 * by what a human does with them — decide (Inbox), inspect what was learned
 * (Skills / Memory), watch the background passes (Scheduler).
 *
 * Every tab renders an EXISTING section component. Nothing is forked,
 * re-implemented, or moved; there is one implementation of the review inbox,
 * the skills catalogue, the memory browser, and the job ledger, and this
 * route is one more door into each. */

import { useState } from 'react';
import {
  BookOpen,
  CalendarClock,
  Database,
  GraduationCap,
  HeartPulse,
  type LucideIcon,
} from 'lucide-react';
import { WorkspaceNavLink } from '@/components/workspace/WorkspaceNavLink';
import { useReviewInboxCount } from '@/lib/useReviewInboxCount';
import { HarnessImprovementsSection } from '@/sections/settings/HarnessImprovementsSection';
import { LearningPanel } from '@/sections/settings/LearningPanel';
import { MemorySection } from '@/sections/settings/MemorySection';
import { SkillsSection } from '@/sections/settings/SkillsSection';

type HubTabId = 'inbox' | 'skills' | 'memory' | 'scheduler';

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
];

/* MemorySection keys its browse-state reset off the settings id it is handed.
 * A hub-local id keeps a deep-linked tab from inheriting the settings page's
 * last-opened entry. */
const HUB_MEMORY_ID = 'learning-hub-memory';

export function LearningHub() {
  // Tab state is local, not a route segment: the hub is one nav destination
  // and each tab is a view inside it, the way the settings rail is a view
  // inside /settings. The deep link for a tab's full page remains the
  // settings section it was always reachable at.
  const [tab, setTab] = useState<HubTabId>('inbox');
  const inbox = useReviewInboxCount();

  return (
    <div className="flex h-full min-h-0" data-testid="learning-hub">
      {/* Left rail — same shape and row component as the settings rail. */}
      <aside className="flex h-full w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
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
          <div className="mx-2 flex flex-col gap-0.5 rounded-xl bg-sidebar-accent/40 py-1">
            {TABS.map(({ id, label, Icon, countsDecisions }) => (
              <WorkspaceNavLink
                key={id}
                icon={Icon}
                label={label}
                active={tab === id}
                badge={countsDecisions && inbox.total > 0 ? String(inbox.total) : null}
                onSelect={() => setTab(id)}
              />
            ))}
          </div>
        </nav>
      </aside>

      {/* Content pane. Panels that own their scroll (Inbox, Skills) fill it;
          the ones that flow (Memory, the Learning panel card) ride its
          scrollbar — one rule for all four. */}
      <div className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {tab === 'inbox' ? <HarnessImprovementsSection /> : null}
        {tab === 'skills' ? <SkillsSection /> : null}
        {tab === 'memory' ? <MemorySection active={{ id: HUB_MEMORY_ID }} /> : null}
        {tab === 'scheduler' ? (
          <div className="px-8 py-6">
            <LearningPanel defaultExpanded />
          </div>
        ) : null}
      </div>
    </div>
  );
}
