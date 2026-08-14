/* Memory — one page: saved, recalled, projects, store. No inner tabs. */

import { useEffect } from 'react';
import { SettingsSectionShell } from '@/components/settings/SettingsSectionShell';
import type { SettingsSection } from '@/settings/settings-registry';
import { WorkspaceMemorySection } from '@/sections/workspace/WorkspaceMemorySection';
import { RecalledMemorySection } from './RecalledMemorySection';
import { AddedMemorySection } from './AddedMemorySection';
import { ProjectMemoriesSection } from './ProjectMemoriesSection';

const ANCHOR: Record<string, string> = {
  'added-memory': 'memory-added',
  'recalled-memory': 'memory-recalled',
  'project-memories': 'memory-projects',
  'memory-knowledge': 'memory-store',
};

export function MemoryHubSection({ active }: { active: SettingsSection }) {
  useEffect(() => {
    const id = ANCHOR[active.id];
    if (!id) return;
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [active.id]);

  return (
    <SettingsSectionShell
      title="Memory"
      subtitle="Facts you saved, what August recalled, project notes, and the knowledge store — one list, not four tabs."
    >
      <div className="mx-auto max-w-3xl space-y-10">
        <section id="memory-added" className="scroll-mt-4 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Saved for every chat</h3>
          <p className="text-[13px] text-muted-foreground">
            You told August to remember these. They are included on parent turns.
          </p>
          <AddedMemorySection embedded />
        </section>

        <section id="memory-recalled" className="scroll-mt-4 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Recalled on demand</h3>
          <p className="text-[13px] text-muted-foreground">
            Agent-captured context. Searchable in chat; pin a row to always include it.
          </p>
          <RecalledMemorySection embedded />
        </section>

        <section id="memory-projects" className="scroll-mt-4 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">By project</h3>
          <ProjectMemoriesSection embedded />
        </section>

        <section id="memory-store" className="scroll-mt-4 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Knowledge store</h3>
          <p className="text-[13px] text-muted-foreground">
            Facts, vectors, graph, and the system prompt.
          </p>
          <WorkspaceMemorySection compact />
        </section>
      </div>
    </SettingsSectionShell>
  );
}
