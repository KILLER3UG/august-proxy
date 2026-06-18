/* ── Agents & Automation — merges Agents/Automations/Terminal ──────── */
/* Agent registry, scheduled automations, and terminal/approval queues all
 * surface approval-gated execution state. Unified under one workbench hub. */

import { useState } from 'react';
import { Bot, CalendarClock, TerminalSquare } from 'lucide-react';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
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
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 px-6 pt-5 pb-3 shrink-0">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Agents &amp; Automation</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            Manage agents and their permissions, schedule automations, and review terminal approvals.
          </p>
        </div>
        <SettingsTabs value={tab} onChange={setTab} items={TABS} label="Agents & automation views" />
      </header>
      <div className="flex-1 overflow-auto">
        {tab === 'agents' && <Agents />}
        {tab === 'automations' && <Automations />}
        {tab === 'terminal' && <Terminal />}
      </div>
    </div>
  );
}
