/* ── RightDrawer ─ multi-section Workbench sidebar ────────────────── */

import type { ComponentType, ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, FileDiff, ListTodo, ClipboardList, TerminalSquare, Play, Columns } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  useRightDrawer,
  type RightDrawerSectionId,
} from './RightDrawerState';
import { RightDrawerDiffSection } from './RightDrawerDiffSection';
import { RightDrawerTasksSection } from './RightDrawerTasksSection';
import { RightDrawerPlanSection } from './RightDrawerPlanSection';
import { RightDrawerTerminalSection } from './RightDrawerTerminalSection';
import { RightDrawerPreviewSection } from './RightDrawerPreviewSection';
import type { WorkbenchSession } from '@/types/workbench';

const SECTION_META: Record<RightDrawerSectionId, { label: string; Icon: ComponentType<{ className?: string }> }> = {
  preview: { label: 'Preview', Icon: Play },
  diff: { label: 'Diff', Icon: FileDiff },
  terminal: { label: 'Terminal', Icon: TerminalSquare },
  tasks: { label: 'Tasks', Icon: ListTodo },
  plan: { label: 'Plan', Icon: ClipboardList },
};

export function RightDrawer({
  open,
  sessionId,
  workspacePath,
  workbenchSession,
  onApprovePlan,
  onClose,
}: {
  open: boolean;
  sessionId: string | null;
  workspacePath: string | null;
  workbenchSession: WorkbenchSession | null;
  onApprovePlan: () => Promise<void>;
  onClose: () => void;
}) {
  const state = useRightDrawer();
  const sectionId = state.activeSection ?? state.sections[0] ?? 'diff';

  if (!open) return null;

  return (
    <AnimatePresence initial={false}>
      <motion.aside
        key="workbench-sidebar"
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: 320, opacity: 1 }}
        exit={{ width: 0, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="shrink-0 h-full min-h-0 w-80 overflow-hidden border-l border-border bg-sidebar text-sidebar-foreground"
        aria-label="Workbench sidebar"
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 bg-sidebar px-3">
            <div className="flex min-w-0 items-center gap-2">
              <Columns className="size-3 text-muted-foreground/60 shrink-0" />
              <span className="truncate text-xs font-semibold text-foreground">Workbench</span>
            </div>

            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Workbench sidebar">
              <X className="size-3.5" />
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden p-2">
            <DrawerSectionCard sectionId={sectionId}>
              {sectionId === 'preview' && (
                <RightDrawerPreviewSection
                  sessionId={sessionId}
                  workspacePath={workspacePath}
                />
              )}
              {sectionId === 'diff' && (
                <RightDrawerDiffSection sessionId={sessionId} />
              )}
              {sectionId === 'terminal' && <RightDrawerTerminalSection />}
              {sectionId === 'tasks' && (
                <RightDrawerTasksSection todos={workbenchSession?.todos ?? []} />
              )}
              {sectionId === 'plan' && (
                <RightDrawerPlanSection
                  session={workbenchSession}
                  onApprove={onApprovePlan}
                />
              )}
            </DrawerSectionCard>
          </div>
        </div>
      </motion.aside>
    </AnimatePresence>
  );
}

function DrawerSectionCard({
  sectionId,
  children,
}: {
  sectionId: RightDrawerSectionId;
  children: ReactNode;
}) {
  const meta = SECTION_META[sectionId];

  return (
    <section
      className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border/50 bg-card shadow-sm"
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1.5">
        <meta.Icon className="size-3 text-muted-foreground/70 shrink-0" />
        <h2 className="truncate text-[11px] font-semibold text-foreground">{meta.label}</h2>
      </div>
      <div className="h-full overflow-auto p-2">{children}</div>
    </section>
  );
}
