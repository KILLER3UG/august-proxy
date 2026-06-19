/* ── Conversations & History — merges Archive/Conversations ────────── */
/* Migrated to the workspace-style chrome. Uses WorkspaceTabs so the
 * segmented control matches the rest of the settings panel. */

import { useState } from 'react';
import { Archive as ArchiveIcon, MessagesSquare } from 'lucide-react';
import { WorkspaceTabs } from '@/components/workspace/WorkspaceTabs';
import { Archive } from '@/sections/archive/Archive';
import { Conversations } from '@/sections/conversations/Conversations';

const TABS = [
  { key: 'archive',       label: 'Archived Sessions', icon: ArchiveIcon },
  { key: 'conversations', label: 'Conversations', icon: MessagesSquare },
] as const;

export function ConversationsHistorySection() {
  const [tab, setTab] = useState<string>('archive');

  return (
    <div className="px-8 py-6 space-y-4 h-full flex flex-col">
      <header className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Conversations &amp; History</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse, restore, and review your past conversations and archived sessions.
        </p>
      </header>
      <div className="shrink-0">
        <WorkspaceTabs value={tab} onChange={setTab} items={TABS} label="History views" />
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'archive' && <Archive />}
        {tab === 'conversations' && <Conversations />}
      </div>
    </div>
  );
}
