import { useEffect, useState } from 'react';
import { SettingsSectionShell } from '@/components/settings/SettingsSectionShell';
import type { SettingsSection } from '@/settings/settings-registry';
import { WorkspaceMemorySection } from '@/sections/workspace/WorkspaceMemorySection';
import { RecalledMemorySection } from './RecalledMemorySection';
import { AddedMemorySection } from './AddedMemorySection';
import { MemoryGraphSection } from './MemoryGraphSection';
import {
  MemoryHubTabs,
  type MemoryHubTabId,
} from './MemoryHubTabs';

// 0.16.8: 'by-project' tab removed — it rendered the SAME recalled pool
// filtered to one folder (Recalled already covers all projects). Old deep
// links land on the recalled tab.
const ANCHOR_TAB: Record<string, MemoryHubTabId> = {
  'recalled-memory': 'recalled',
  'project-memories': 'recalled',
  'added-memory': 'saved',
  'memory-knowledge': 'graph',
};

function tabFromActive(activeId: string): MemoryHubTabId {
  return ANCHOR_TAB[activeId] ?? 'recalled';
}

export function MemoryHubSection({ active }: { active: SettingsSection }) {
  const [tab, setTab] = useState<MemoryHubTabId>(() => tabFromActive(active.id));
  useEffect(() => {
    setTab(tabFromActive(active.id));
  }, [active.id]);

  return (
    <SettingsSectionShell
      title="Memory"
      subtitle={
        <>
          <span className="font-medium text-foreground/80">Recalled</span> is what August learned automatically (all projects, ranked when relevant).
          {' '}<span className="font-medium text-foreground/80">Saved</span> memories are pinned and always included.
        </>
      }
      toolbar={<MemoryHubTabs active={tab} onChange={setTab} />}
    >
      <div className="mx-auto max-w-3xl">
        {tab === 'recalled' ? (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[13px] leading-5 text-muted-foreground">Review mode lets the model check each recalled memory — keep what matters, remove what doesn&apos;t.</p>
              <a href="/api/memory/export?origin=recalled" target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">View Markdown</a>
            </div>
            <RecalledMemorySection embedded />
          </section>
        ) : null}
        {tab === 'saved' ? (
          <section className="space-y-3">
            <p className="text-[13px] leading-5 text-muted-foreground">You told August to remember these — pinned and injected into every chat turn.</p>
            <AddedMemorySection embedded />
          </section>
        ) : null}
        {tab === 'graph' ? (
          <section className="space-y-3">
            <p className="text-[13px] leading-5 text-muted-foreground">Knowledge graph — entities and relations built from memories, with project-filtered neighborhoods.</p>
            <MemoryGraphSection embedded />
            <div className="border-t border-border/40 pt-6">
              <h4 className="text-sm font-semibold text-foreground">Knowledge store</h4>
              <p className="mt-1 text-[13px] text-muted-foreground">Facts, vectors, and system prompt.</p>
              <div className="mt-3">
                <WorkspaceMemorySection compact />
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </SettingsSectionShell>
  );
}
