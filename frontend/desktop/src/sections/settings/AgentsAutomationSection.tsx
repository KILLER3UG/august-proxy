/* ── Agents & Automation ───────────────────────────────────────────── */
/* Workspace-style section hosting Agents, Automations, and Terminal tabs. */

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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

const TAB_KEYS = new Set(TABS.map((t) => t.key));

export function AgentsAutomationSection() {
  const [params, setParams] = useSearchParams();
  const sectionParam = params.get('section') || '';
  const initial = TAB_KEYS.has(sectionParam) ? sectionParam : 'agents';
  const [tab, setTab] = useState<string>(initial);

  const activeTab = useMemo(() => {
    if (TAB_KEYS.has(sectionParam)) return sectionParam;
    return tab;
  }, [sectionParam, tab]);

  const onChange = (next: string) => {
    setTab(next);
    const nextParams = new URLSearchParams(params);
    nextParams.set('section', next);
    setParams(nextParams, { replace: true });
  };

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
            value={activeTab}
            onChange={onChange}
            items={[...TABS]}
            label="Agents & automation views"
          />
          <div className="min-w-0 flex-1">
            {activeTab === 'agents' && <Agents />}
            {activeTab === 'automations' && <Automations />}
            {activeTab === 'terminal' && <Terminal />}
          </div>
        </div>
      </div>
    </div>
  );
}
