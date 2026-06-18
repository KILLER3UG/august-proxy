/* ── Conversations & History — merges Archive/Conversations ────────── */
/* Archived sessions (Archive) and live conversation history (Conversations)
 * both present session/message identity. Tabbed under one history hub. */

import { useState } from 'react';
import { Archive as ArchiveIcon, MessagesSquare } from 'lucide-react';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { Archive } from '@/sections/archive/Archive';
import { Conversations } from '@/sections/conversations/Conversations';

const TABS = [
  { key: 'archive',       label: 'Archived Sessions', icon: ArchiveIcon },
  { key: 'conversations', label: 'Conversations', icon: MessagesSquare },
] as const;

export function ConversationsHistorySection() {
  const [tab, setTab] = useState<string>('archive');

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 px-6 pt-5 pb-3 shrink-0">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Conversations &amp; History</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            Browse, restore, and review your past conversations and archived sessions.
          </p>
        </div>
        <SettingsTabs value={tab} onChange={setTab} items={TABS} label="History views" />
      </header>
      <div className="flex-1 overflow-auto">
        {tab === 'archive' && <Archive />}
        {tab === 'conversations' && <Conversations />}
      </div>
    </div>
  );
}
