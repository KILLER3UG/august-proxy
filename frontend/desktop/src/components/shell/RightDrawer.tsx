/* ── RightDrawer ─ multi-section Workbench sidebar ────────────────── */

import { AnimatePresence, motion } from 'framer-motion';
import { X, Columns, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  closeRightDrawerSection,
  useRightDrawer,
  type RightDrawerSectionId,
} from './RightDrawerState';
import { RightDrawerDiffSection } from './RightDrawerDiffSection';
import { RightDrawerTasksSection } from './RightDrawerTasksSection';
import { RightDrawerPlanSection } from './RightDrawerPlanSection';
import { RightDrawerTerminalSection } from './RightDrawerTerminalSection';
import { RightDrawerPreviewSection } from './RightDrawerPreviewSection';
import type { WorkbenchSession } from '@/types/workbench';

const BASE_WIDTH = 320;   // 1-2 sections
const WIDE_WIDTH = 640;   // 3-4 sections — doubles so they don't squish

export function RightDrawer({
  open,
  sessionId,
  workspacePath,
  workbenchSession,
  onApprovePlan,
  onRejectPlan,
  onRevisePlan,
  onClose,
}: {
  open: boolean;
  sessionId: string | null;
  workspacePath: string | null;
  workbenchSession: WorkbenchSession | null;
  onApprovePlan: () => Promise<void>;
  onRejectPlan?: () => Promise<void>;
  onRevisePlan?: (feedback: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const state = useRightDrawer();
  const sections = state.sections;
  const width = sections.length >= 3 ? WIDE_WIDTH : BASE_WIDTH;

  if (!open) return null;

  return (
    <AnimatePresence initial={false}>
      <motion.aside
        key="workbench-sidebar"
        initial={{ width: 0, opacity: 0 }}
        animate={{ width, opacity: 1 }}
        exit={{ width: 0, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="shrink-0 h-full min-h-0 overflow-hidden border-l border-border bg-sidebar text-sidebar-foreground"
        style={{ width }}
        aria-label="Workbench sidebar"
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 bg-sidebar px-3">
            <div className="flex min-w-0 items-center gap-2">
              <Columns className="size-3 text-muted-foreground/60 shrink-0" />
              <span className="truncate text-sm font-semibold text-foreground">Workbench</span>
              {sections.length > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-md bg-white/5 px-1.5 py-0.5 text-xs font-semibold text-muted-foreground/80">
                  {sections.length}
                </span>
              )}
            </div>

            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Workbench sidebar">
              <X className="size-3.5" />
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden p-2">
            {sections.length === 0 && <NoSectionSelected />}

            {sections.length === 1 && (
              <DrawerSectionCard
                sectionId={sections[0]}
                ctx={{ sessionId, workspacePath, workbenchSession, onApprovePlan, onRejectPlan, onRevisePlan }}
              />
            )}

            {sections.length === 2 && (
              <div className="flex h-full flex-col gap-2">
                {sections.map((sectionId) => (
                  <DrawerSectionCard
                    key={sectionId}
                    sectionId={sectionId}
                    ctx={{ sessionId, workspacePath, workbenchSession, onApprovePlan, onRejectPlan, onRevisePlan }}
                  />
                ))}
              </div>
            )}

            {sections.length >= 3 && (
              <div className="grid h-full grid-cols-2 gap-2">
                {sections.map((sectionId) => (
                  <DrawerSectionCard
                    key={sectionId}
                    sectionId={sectionId}
                    ctx={{ sessionId, workspacePath, workbenchSession, onApprovePlan, onRejectPlan, onRevisePlan }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </motion.aside>
    </AnimatePresence>
  );
}

function renderSection(
  sectionId: RightDrawerSectionId,
  ctx: {
    sessionId: string | null;
    workspacePath: string | null;
    workbenchSession: WorkbenchSession | null;
    onApprovePlan: () => Promise<void>;
    onRejectPlan?: () => Promise<void>;
    onRevisePlan?: (feedback: string) => void | Promise<void>;
  },
) {
  switch (sectionId) {
    case 'preview':
      return (
        <RightDrawerPreviewSection
          sessionId={ctx.sessionId}
          workspacePath={ctx.workspacePath}
        />
      );
    case 'diff':
      return <RightDrawerDiffSection sessionId={ctx.sessionId} />;
    case 'terminal':
      return <RightDrawerTerminalSection />;
    case 'tasks':
      return <RightDrawerTasksSection todos={ctx.workbenchSession?.todos ?? []} />;
    case 'plan':
      return (
        <RightDrawerPlanSection
          session={ctx.workbenchSession}
          onApprove={ctx.onApprovePlan}
          onReject={ctx.onRejectPlan}
          onRevise={ctx.onRevisePlan}
        />
      );
  }
}

function DrawerSectionCard({
  sectionId,
  ctx,
}: {
  sectionId: RightDrawerSectionId;
  ctx: {
    sessionId: string | null;
    workspacePath: string | null;
    workbenchSession: WorkbenchSession | null;
    onApprovePlan: () => Promise<void>;
    onRejectPlan?: () => Promise<void>;
    onRevisePlan?: (feedback: string) => void | Promise<void>;
  };
}) {
  return (
    <section className="relative flex h-full min-h-0 overflow-hidden rounded-lg border border-border/50 bg-card shadow-sm">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => closeRightDrawerSection(sectionId)}
        className="absolute right-1 top-1 z-10"
        aria-label={`Close ${sectionId} section`}
        title="Close section"
      >
        <X className="size-3" />
      </Button>
      <div className="min-h-0 flex-1 overflow-y-auto">{renderSection(sectionId, ctx)}</div>
    </section>
  );
}

function NoSectionSelected() {
  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/40">
      <div className="flex flex-col items-center text-center px-6">
        <Inbox className="size-6 text-muted-foreground/40" />
        <div className="mt-2 text-sm font-semibold text-foreground/80">No section selected</div>
        <div className="mt-1 text-xs text-muted-foreground/70">
          Pick a section from the Workbench menu to get started.
        </div>
      </div>
    </div>
  );
}
