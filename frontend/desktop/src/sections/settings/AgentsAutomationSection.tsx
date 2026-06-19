/* ── Agents & Automation — merges Agents/Automations/Terminal ──────── */
/* Migrated to the workspace-style chrome (big h1, WorkspaceTabs,
 * larger padding). Body components (Agents/Automations/Terminal) are
 * reused verbatim from the legacy sections. */

import { useState } from 'react';
import { Bot, CalendarClock, TerminalSquare } from 'lucide-react';
import { WorkspaceTabs } from '@/components/workspace/WorkspaceTabs';
import { Agents } from '@/sections/agents/Agents';
import { Automations } from '@/sections/automations/Automations';
import { Terminal } from '@/sections/terminal/Terminal';

const TABS = [
  { key: 'agents',      label: 'Agents', icon: Bot },
  { key: 'automations', label: 'Automations', icon: CalendarClock },
  { key: 'terminal',    label: 'Terminal & Approvals', icon: TerminalSquare },
] as const;

export function AgentsAutomationSection() {
  const [tab, setTab] = useState<string>('agents');

  return (
    <div className="px-8 py-6 space-y-4 h-full flex flex-col">
      <header className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Agents &amp; Automation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage agents and their permissions, schedule automations, and review terminal approvals.
        </p>
      </header>
      <div className="shrink-0">
        <WorkspaceTabs value={tab} onChange={setTab} items={TABS} label="Agents & automation views" />
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'agents' && <Agents />}
        {tab === 'automations' && <Automations />}
        {tab === 'terminal' && <Terminal />}
      </div>
    </div>
  );
}
