/* Access hub — the rail advertises three entries (Files & Shell Access,
 * Path Permissions, Python Sandbox) that previously all rendered this one
 * combined page because the component ignored `active.id` (audit 3.5b).
 * Branch on the id so each rail entry shows its own content; `agent-sandbox`
 * stays the combined "Files & Shell Access" hub. */

import { SettingsSectionShell } from '@/components/settings/SettingsSectionShell';
import { AgentSandboxSection } from './AgentSandboxSection';
import { ToolGrantsSection } from './ToolGrantsSection';
import { PythonSandboxSection } from './PythonSandboxSection';

interface AccessHubProps {
  active?: { id?: string };
}

export function AccessHubSection({ active }: AccessHubProps) {
  const id = active?.id;

  if (id === 'tool-grants') {
    return (
      <SettingsSectionShell
        title="Path Permissions"
        subtitle="Always-here tool grants by workspace path — list, explain, revoke."
      >
        <ToolGrantsSection />
      </SettingsSectionShell>
    );
  }

  if (id === 'python-sandbox') {
    return (
      <SettingsSectionShell
        title="Python Sandbox"
        subtitle="Safe Python cell with no network, banned imports, and timeout."
      >
        <PythonSandboxSection />
      </SettingsSectionShell>
    );
  }

  // Default / `agent-sandbox`: the combined Files & Shell Access hub.
  return (
    <SettingsSectionShell
      title="Files & Shell Access"
      subtitle="Where tools can touch, remembered path grants, and the safe Python cell."
      bodyClassName="space-y-2 px-0 pb-0"
    >
      <AgentSandboxSection />
      <ToolGrantsSection />
      <PythonSandboxSection />
    </SettingsSectionShell>
  );
}
