/* ── Agents & Automation — merges Agents/Automations/Terminal ──────── */
/* Migrated to the workspace-style chrome (big h1, WorkspaceTabs,
 * larger padding). Body components (Agents/Automations/Terminal) are
 * reused verbatim from the legacy sections. */

import { useState } from 'react';
import { Bot, CalendarClock, TerminalSquare } from 'lucide-react';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { Agents } from '@/sections/agents/Agents';
import { Automations } from '@/sections/automations/Automations';
import { Terminal } from '@/sections/terminal/Terminal';

const TABS = [
  { key: 'agents', label: 'Agents', icon: Bot, description: 'Registry and permissions' },
  { key: 'automations', label: 'Automations', icon: CalendarClock, description: 'Scheduled jobs' },
  { key: 'terminal', label: 'Terminal', icon: TerminalSquare, description: 'Approvals and shell' },
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
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <SettingsTabs
            className="lg:sticky lg:top-2 shrink-0"
            orientation="vertical"
            value={tab}
            onChange={setTab}
            items={[...TABS]}
            label="Agents & automation views"
          />
          <div className="min-w-0 flex-1">
            {tab === 'agents' && <Agents />}
            {tab === 'automations' && <Automations />}
            {tab === 'terminal' && <Terminal />}
          </div>
        </div>
      </div>
    </div>
  );
}
