/* Files & Shell Access — sandbox, path grants, and Python cell on one page. */

import { SettingsSectionShell } from '@/components/settings/SettingsSectionShell';
import { AgentSandboxSection } from './AgentSandboxSection';
import { ToolGrantsSection } from './ToolGrantsSection';
import { PythonSandboxSection } from './PythonSandboxSection';

export function AccessHubSection(_props?: { active?: unknown }) {
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
