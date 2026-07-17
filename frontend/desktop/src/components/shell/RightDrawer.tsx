/* ── RightDrawer ─ multi-section Workbench sidebar ────────────────── */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Columns, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  closeRightDrawerSection,
  useRightDrawerSections,
  type RightDrawerSectionId,
} from './RightDrawerState';
import { RightDrawerDiffSection } from './RightDrawerDiffSection';
import { RightDrawerTasksSection } from './RightDrawerTasksSection';
import { RightDrawerPlanSection } from './RightDrawerPlanSection';
import { RightDrawerTerminalSection } from './RightDrawerTerminalSection';
import { RightDrawerPreviewSection } from './RightDrawerPreviewSection';
import { RightDrawerBrowserSection } from './RightDrawerBrowserSection';
import type { WorkbenchSession } from '@/types/workbench';

const DEFAULT_BASE_WIDTH = 320;   // 1-2 sections
const DEFAULT_WIDE_WIDTH = 640;   // 3-4 sections — doubles so they don't squish
const BASE_WIDTH_KEY = 'august-right-drawer-width-base';
const WIDE_WIDTH_KEY = 'august-right-drawer-width-wide';
const MIN_WIDTH = 200;
const MAX_VIEWPORT_FRACTION = 0.8;

/** Shared panel open/close — matches session sidebar feel. */
const PANEL_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const PANEL_MS = 0.32;

function loadStoredWidth(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return clampWidth(parsed);
}

function clampWidth(value: number): number {
  const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_VIEWPORT_FRACTION));
  return Math.min(max, Math.max(MIN_WIDTH, value));
}

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
  const sections = useRightDrawerSections();
  const isWide = sections.length >= 3;
  const [baseWidth, setBaseWidth] = useState<number>(() => loadStoredWidth(BASE_WIDTH_KEY, DEFAULT_BASE_WIDTH));
  const [wideWidth, setWideWidth] = useState<number>(() => loadStoredWidth(WIDE_WIDTH_KEY, DEFAULT_WIDE_WIDTH));
  const [isDragging, setIsDragging] = useState(false);

  const width = isWide ? wideWidth : baseWidth;
  const setWidth = isWide ? setWideWidth : setBaseWidth;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(BASE_WIDTH_KEY, String(baseWidth));
  }, [baseWidth]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(WIDE_WIDTH_KEY, String(wideWidth));
  }, [wideWidth]);

  // Stop dragging if the component unmounts mid-drag.
  useEffect(() => {
    if (!isDragging) return;
    const stop = () => setIsDragging(false);
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchend', stop);
    return () => {
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('touchend', stop);
    };
  }, [isDragging]);

  const startResize = (clientX: number) => {
    const startX = clientX;
    const startW = width;
    setIsDragging(true);

    const onMove = (ev: MouseEvent | TouchEvent) => {
      const next = 'touches' in ev && ev.touches.length
        ? ev.touches[0].clientX
        : (ev as MouseEvent).clientX;
      // Right drawer expands when dragged left (delta is negative on leftward drag).
      const delta = startX - next;
      setWidth(clampWidth(startW + delta));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove as (e: MouseEvent) => void);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove as (e: TouchEvent) => void);
      window.removeEventListener('touchend', onUp);
      setIsDragging(false);
    };

    window.addEventListener('mousemove', onMove as (e: MouseEvent) => void);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove as (e: TouchEvent) => void, { passive: true });
    window.addEventListener('touchend', onUp);
  };

  // Keep AnimatePresence mounted so exit width/opacity can play.
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside
          key="workbench-sidebar"
          initial={{ width: 0, opacity: 0, x: 24 }}
          animate={{ width, opacity: 1, x: 0 }}
          exit={{ width: 0, opacity: 0, x: 16 }}
          transition={{
            duration: isDragging ? 0 : PANEL_MS,
            ease: PANEL_EASE,
          }}
          className="relative shrink-0 h-full min-h-0 overflow-hidden border-l border-border bg-sidebar text-sidebar-foreground"
          aria-label="Workbench sidebar"
        >
          {/* Inner shell keeps content at target width while the outer panel animates. */}
          <div className="flex h-full min-h-0 flex-col" style={{ width }}>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize workbench sidebar"
              onMouseDown={(e) => {
                e.preventDefault();
                startResize(e.clientX);
              }}
              onTouchStart={(e) => {
                if (e.touches.length) startResize(e.touches[0].clientX);
              }}
              className={`absolute top-0 left-0 z-20 h-full w-1 cursor-col-resize select-none touch-none transition-colors hover:bg-primary/40 ${isDragging ? 'bg-primary/50' : 'bg-transparent'}`}
            />

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
      )}
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
    case 'browser':
      return <RightDrawerBrowserSection />;
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
