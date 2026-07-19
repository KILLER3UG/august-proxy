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

type TabKey = (typeof TABS)[number]['key'];
const TAB_KEYS = new Set<string>(TABS.map((t) => t.key));

function asTabKey(value: string): TabKey | null {
  return TAB_KEYS.has(value) ? (value as TabKey) : null;
}

export function AgentsAutomationSection() {
  const [params, setParams] = useSearchParams();
  const sectionParam = params.get('section') || '';
  const initial = asTabKey(sectionParam) ?? 'agents';
  const [tab, setTab] = useState<TabKey>(initial);

  const activeTab = useMemo(() => {
    return asTabKey(sectionParam) ?? tab;
  }, [sectionParam, tab]);

  const onChange = (next: string) => {
    const key = asTabKey(next) ?? 'agents';
    setTab(key);
    const nextParams = new URLSearchParams(params);
    nextParams.set('section', key);
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
