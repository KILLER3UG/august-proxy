/* ── Tools & Connections — merges MCP/Connections ─────────────────── */
/* MCP & Skills is the full service configuration surface; Connections is a
 * read-only summary that links back into it. Folding them together removes
 * the duplicate service-connection read while keeping every CRUD action. */

import { useState } from 'react';
import { Plug, Network } from 'lucide-react';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { Mcp } from '@/sections/mcp/Mcp';
import { Connections } from '@/sections/connections/Connections';

const TABS = [
  { key: 'servers',     label: 'MCP Servers & Skills', icon: Plug },
  { key: 'connections', label: 'Accounts & Connections', icon: Network },
] as const;

export function ToolsConnectionsSection() {
  const [tab, setTab] = useState<string>('servers');

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 px-6 pt-5 pb-3 shrink-0">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Tools &amp; Connections</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            MCP servers, skills, and connected accounts (Google, GitHub, Slack) in one place.
          </p>
        </div>
        <SettingsTabs value={tab} onChange={setTab} items={TABS} label="Tools views" />
      </header>
      <div className="flex-1 overflow-auto">
        {tab === 'servers' && <Mcp />}
        {tab === 'connections' && <Connections />}
      </div>
    </div>
  );
}
