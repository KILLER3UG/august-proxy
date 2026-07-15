/* ── Conversations & History — merges Archive/Conversations ────────── */
/* Migrated to the workspace-style chrome. Uses WorkspaceTabs so the
 * segmented control matches the rest of the settings panel. */

import { useState } from 'react';
import { Archive as ArchiveIcon, MessagesSquare } from 'lucide-react';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { Archive } from '@/sections/archive/Archive';
import { Conversations } from '@/sections/conversations/Conversations';

const TABS = [
  { key: 'archive', label: 'Archived', icon: ArchiveIcon, description: 'Restorable sessions' },
  { key: 'conversations', label: 'Conversations', icon: MessagesSquare, description: 'Recent history' },
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
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <SettingsTabs
            className="lg:sticky lg:top-2 shrink-0"
            orientation="vertical"
            value={tab}
            onChange={setTab}
            items={[...TABS]}
            label="History views"
          />
          <div className="min-w-0 flex-1">
            {tab === 'archive' && <Archive />}
            {tab === 'conversations' && <Conversations />}
          </div>
        </div>
      </div>
    </div>
  );
}
