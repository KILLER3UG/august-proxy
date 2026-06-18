/* ── Conversation Inspector — merges Inspector/Conversations/Thinking ─ */
/* The readable transcript (Conversations), raw request/response bodies
 * (Inspector), and thinking traces (Thinking) all describe the same
 * RequestDetailEntry. Tabbed into one debugging surface. */

import { useState } from 'react';
import { MessagesSquare, Search, Brain } from 'lucide-react';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { Conversations } from '@/sections/conversations/Conversations';
import { Inspector } from '@/sections/inspector/Inspector';
import { Thinking } from '@/sections/thinking/Thinking';

const TABS = [
  { key: 'readable', label: 'Conversation', icon: MessagesSquare },
  { key: 'raw',      label: 'Raw Request/Response', icon: Search },
  { key: 'thinking', label: 'Thinking', icon: Brain },
] as const;

export function ConversationInspectorSection() {
  const [tab, setTab] = useState<string>('readable');

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 px-6 pt-5 pb-3 shrink-0">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Conversation Inspector</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            Read a request as a conversation, inspect raw bodies, or view the model&apos;s thinking.
          </p>
        </div>
        <SettingsTabs value={tab} onChange={setTab} items={TABS} label="Inspector views" />
      </header>
      <div className="flex-1 overflow-auto">
        {tab === 'readable' && <Conversations />}
        {tab === 'raw' && <Inspector />}
        {tab === 'thinking' && <Thinking />}
      </div>
    </div>
  );
}
