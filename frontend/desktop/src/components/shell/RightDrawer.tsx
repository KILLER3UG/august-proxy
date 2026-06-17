/* ── RightDrawer ─ multi-section Workbench sidebar ────────────────── */

import type { ComponentType, ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, FileDiff, ListTodo, ClipboardList, TerminalSquare, Play, Columns } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  setActiveRightDrawerSection,
  toggleRightDrawerSection,
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
  tasks: { label: 'Task/Todo list', Icon: ListTodo },
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
  const sections = state.sections.length > 0 ? state.sections : [state.activeSection || 'diff'];
  const gridClass = sections.length >= 2 ? 'grid grid-cols-2' : 'grid grid-cols-1';

  if (!open) return null;

  return (
    <AnimatePresence initial={false}>
      <motion.aside
        key="workbench-sidebar"
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: 256, opacity: 1 }}
        exit={{ width: 0, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="shrink-0 h-full min-h-0 w-64 overflow-hidden border-l border-border bg-sidebar text-sidebar-foreground"
        aria-label="Workbench sidebar"
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 border-b border-border/60 bg-sidebar px-2 py-2">
            <div className="flex items-center gap-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1 rounded-md border border-border/50 bg-white/[0.025] p-1">
                <Columns className="size-3 text-muted-foreground/60 shrink-0" />
                {Object.entries(SECTION_META).map(([id, meta]) => {
                  const sectionId = id as RightDrawerSectionId;
                  const open = state.sections.includes(sectionId);
                  const active = state.activeSection === sectionId;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        if (open) {
                          setActiveRightDrawerSection(sectionId);
                        } else {
                          toggleRightDrawerSection(sectionId);
                        }
                      }}
                      className={cn(
                        'flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium transition',
                        open
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      )}
                      aria-pressed={open}
                      title={meta.label}
                    >
                      <meta.Icon className="size-3" />
                      {meta.label}
                    </button>
                  );
                })}
              </div>

              <div className="ml-auto shrink-0">
                <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Workbench sidebar">
                  <X className="size-3.5" />
                </Button>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden p-2">
            <div className={cn('h-full gap-2', gridClass)}>
              {sections.map((sectionId) => (
                <DrawerSectionCard key={sectionId} sectionId={sectionId} active={state.activeSection === sectionId}>
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
              ))}
            </div>
          </div>
        </div>
      </motion.aside>
    </AnimatePresence>
  );
}

function DrawerSectionCard({
  sectionId,
  active,
  children,
}: {
  sectionId: RightDrawerSectionId;
  active: boolean;
  children: ReactNode;
}) {
  const meta = SECTION_META[sectionId];

  return (
    <section
      className="min-h-0 overflow-hidden rounded-lg border border-border/50 bg-card shadow-sm"
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1.5">
        <meta.Icon className="size-3 text-muted-foreground/70 shrink-0" />
        <h2 className="truncate text-[11px] font-semibold text-foreground">{meta.label}</h2>
      </div>
      <div className="h-full overflow-auto p-2">{children}</div>
    </section>
  );
}
