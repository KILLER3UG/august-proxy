/* ── RightDrawer ─ multi-section Workbench sidebar ────────────────── */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  CalendarClock,
  ClipboardList,
  Columns,
  Cpu,
  FileDiff,
  GalleryVertical,
  Globe,
  ListTodo,
  Play,
  Plus,
  StickyNote,
  TerminalSquare,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  addRightDrawerSection,
  closeRightDrawerSection,
  openRightDrawerChooser,
  setActiveRightDrawerSection,
  setRightDrawerChooser,
  toggleBottomTerminal,
  useRightDrawerSections,
  type RightDrawerSectionId,
} from './RightDrawerState';
import { RightDrawerDiffSection } from './RightDrawerDiffSection';
import { RightDrawerTasksSection } from './RightDrawerTasksSection';
import { RightDrawerPlanSection } from './RightDrawerPlanSection';
import { RightDrawerTerminalSection } from './RightDrawerTerminalSection';
import { RightDrawerPreviewSection } from './RightDrawerPreviewSection';
import { RightDrawerBrowserSection } from './RightDrawerBrowserSection';
import { RightDrawerNotesSection } from './RightDrawerNotesSection';
import { RightDrawerFileSection } from './RightDrawerFileSection';
import { RightDrawerSubagentsSection } from './RightDrawerSubagentsSection';
import { RightDrawerArtifactsSection } from './RightDrawerArtifactsSection';
import { RightDrawerCircuitSection } from './RightDrawerCircuitSection';
import { RoutinesPane } from '@/components/sidebar/RoutinesPane';
import { getBot } from '@/api/api-client';
import type { WorkbenchSession } from '@/types/workbench';
import { useRightDrawer } from './RightDrawerState';
import { getFileIcon } from '@/lib/file-icon';
import { PANEL_EASE, PANEL_MS } from '@/lib/motion';

const DEFAULT_BASE_WIDTH = 420;   // Zed-like breathing room for the single view
// v2 keys: the old defaults pinned returning installs to cramped widths.
const BASE_WIDTH_KEY = 'august-right-drawer-width-base-v2';
const MIN_WIDTH = 200;
// Leave at least 40% of the viewport for chat — at minimum window widths
// the drawer previously swallowed the conversation (audit finding).
const MAX_VIEWPORT_FRACTION = 0.6;

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
  const { file: filePreview, activeSection, chooserActive } = useRightDrawer();
  const showingFile = sections.length === 1 && sections[0] === 'file' && !!filePreview;
  const HeaderFileIcon = filePreview ? getFileIcon(filePreview.name).Icon : null;
  const [baseWidth, setBaseWidth] = useState<number>(() => loadStoredWidth(BASE_WIDTH_KEY, DEFAULT_BASE_WIDTH));
  const [isDragging, setIsDragging] = useState(false);
  const ctx = { sessionId, workspacePath, workbenchSession, onApprovePlan, onRejectPlan, onRevisePlan };

  // Single active view — one width, no wide/narrow split.
  const width = baseWidth;
  const setWidth = setBaseWidth;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(BASE_WIDTH_KEY, String(baseWidth));
  }, [baseWidth]);

  // ZCode-style chooser: Escape backs out without changing open sections.
  useEffect(() => {
    if (!chooserActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRightDrawerChooser(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chooserActive]);

  // Overlay drawer (Part 15.4): Escape dismisses the whole panel. The
  // chooser handles its own Escape above, and editable fields keep Escape
  // for themselves (terminal, inputs, textareas).
  useEffect(() => {
    if (!open || chooserActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, chooserActive, onClose]);

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

  // Re-clamp when the window shrinks below the stored drawer width — the
  // drawer previously overflowed the viewport until the next drag.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setBaseWidth((w) => clampWidth(w));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
  // Part 15.4 hard rule — content renders in the middle column: the drawer
  // OVERLAYS the right edge (absolute inside the relative .august-content-area)
  // instead of pushing the chat column left as an inline flex sibling.
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside
          key="workbench-sidebar"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{
            duration: isDragging ? 0 : PANEL_MS,
            ease: PANEL_EASE,
          }}
          className="august-right-drawer absolute right-0 top-0 bottom-0 z-30 min-h-0 overflow-hidden border-l border-border bg-background text-foreground"
          aria-label="Workbench sidebar"
        >
          {/* Inner shell keeps content at target width while the outer panel animates. */}
          <div className="flex h-full min-h-0 flex-col" style={{ width }} data-testid="drawer-inner">
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

            <div className="august-right-drawer-header flex h-10 shrink-0 items-center justify-between border-b border-border/60 bg-transparent px-3">
              {showingFile ? (
                <div className="flex min-w-0 items-center gap-2">
                  {HeaderFileIcon && (
                    <HeaderFileIcon size={15} color={getFileIcon(filePreview.name).color} className="shrink-0" />
                  )}
                  <span className="truncate text-sm font-semibold text-foreground">
                    {filePreview.name}
                  </span>
                </div>
              ) : sections.length > 0 ? (
                /* Zed-style tab strip: one tab per open section, click to
                   focus, ✕ to close. The whole-drawer close stays at right. */
                <div
                  role="tablist"
                  aria-label="Workbench sections"
                  data-testid="drawer-tab-strip"
                  className="-mx-3 flex h-full min-w-0 items-stretch overflow-x-auto px-1"
                >
                  {sections.map((sectionId) => (
                    <DrawerTab key={sectionId} sectionId={sectionId} active={sectionId === activeSection} />
                  ))}
                  <DrawerAddSectionButton />
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2">
                  <Columns className="size-3 text-muted-foreground/60 shrink-0" />
                  <span className="truncate text-sm font-semibold text-foreground">Workbench</span>
                </div>
              )}

              <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Workbench sidebar">
                <X className="size-3.5" />
              </Button>
            </div>

            <div className={showingFile ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-hidden px-2 pb-2 pt-1.5'}>
              {showingFile ? (
                <RightDrawerFileSection file={filePreview} />
              ) : chooserActive ? (
                /* ZCode "Open tab": centered card grid replaces the body. */
                <SectionChooser openSections={sections} />
              ) : activeSection && sections.includes(activeSection) ? (
                /* Zed-style single view: the ACTIVE tab fills the whole
                   panel — switching tabs swaps content, nothing stacks. */
                <div className="flex h-full min-h-0 flex-col">
                  {renderSection(activeSection, ctx)}
                </div>
              ) : null}
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/** Tab metadata mirrors RightDrawerLauncher's SECTION_META so the strip
 *  shows the same icon + label the user used to open each section. */
const TAB_META: Record<RightDrawerSectionId, { label: string; Icon: typeof FileDiff }> = {
  preview: { label: 'Preview', Icon: Play },
  diff: { label: 'Diffs', Icon: FileDiff },
  terminal: { label: 'Terminal', Icon: TerminalSquare },
  tasks: { label: 'Tasks', Icon: ListTodo },
  plan: { label: 'Plan', Icon: ClipboardList },
  browser: { label: 'Browser', Icon: Globe },
  notes: { label: 'Notepad', Icon: StickyNote },
  subagents: { label: 'Subagents', Icon: Users },
  artifacts: { label: 'Artifacts', Icon: GalleryVertical },
  circuit: { label: 'Circuit', Icon: Cpu },
  file: { label: 'File', Icon: FileDiff },
  routines: { label: 'Routines', Icon: CalendarClock },
};

/** Menu order for the "+" picker (workbench-first, mirrors launcher). */
const SECTION_ADD_ORDER: RightDrawerSectionId[] = [
  'preview',
  'diff',
  'terminal',
  'tasks',
  'plan',
  'browser',
  'notes',
  'subagents',
  'artifacts',
  'circuit',
  'routines',
];

function DrawerTab({ sectionId, active }: { sectionId: RightDrawerSectionId; active: boolean }) {
  const meta = TAB_META[sectionId];
  if (!meta) return null;
  const { label, Icon } = meta;
  return (
    <div
      role="tab"
      aria-selected={active}
      data-testid={`drawer-tab-${sectionId}`}
      onClick={() => setActiveRightDrawerSection(sectionId)}
      className={cn(
        'group relative flex min-w-0 cursor-pointer select-none items-center gap-1.5 px-2.5 pt-1',
        active ? 'text-foreground' : 'text-muted-foreground/70 hover:text-foreground',
      )}
    >
      <Icon className="size-3 shrink-0 opacity-80" />
      <span className="truncate text-xs font-medium">{label}</span>
      <button
        type="button"
        aria-label={`Close ${label} section`}
        data-testid={`drawer-tab-close-${sectionId}`}
        onClick={(e) => {
          e.stopPropagation();
          closeRightDrawerSection(sectionId);
        }}
        className="ml-0.5 rounded p-0.5 opacity-40 transition hover:bg-muted/60 hover:opacity-100"
      >
        <X className="size-2.5" />
      </button>
      {/* Active underline, Zed/Cursor tab style. */}
      <span
        className={cn(
          'absolute inset-x-1 bottom-0 h-[2px] rounded-full transition-opacity',
          active ? 'bg-primary/80 opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}

function DrawerAddSectionButton() {
  // ZCode-style: the + swaps the body to the full card-grid chooser instead
  // of a small dropdown.
  return (
    <button
      type="button"
      aria-label="Open a section in the side pane"
      title="Open section"
      data-testid="drawer-tab-add"
      onClick={() => openRightDrawerChooser()}
      className="rounded p-1 text-muted-foreground/60 transition hover:bg-muted/50 hover:text-foreground"
    >
      <Plus className="size-3.5" />
    </button>
  );
}

/** ZCode "Open tab" view — centered heading over a wrap grid of section
 *  cards (icon above label). Open sections carry a check; picking one
 *  opens it and returns to the panel. */
function SectionChooser({ openSections }: { openSections: RightDrawerSectionId[] }) {
  const bottomTerminalOpen = useRightDrawer().bottomTerminal;
  const pick = (id: RightDrawerSectionId) => {
    if (id === 'terminal') {
      // Terminal lives in the JetBrains-style BOTTOM dock now.
      toggleBottomTerminal(true);
      setRightDrawerChooser(false);
      return;
    }
    addRightDrawerSection(id);
    setRightDrawerChooser(false);
  };
  return (
    <div
      data-testid="drawer-section-chooser"
      className="flex h-full min-h-0 flex-col items-center overflow-y-auto px-4 py-10 chat-scroll"
    >
      <h2 className="text-center text-xl font-semibold tracking-tight text-foreground">Open tab</h2>
      <p className="mt-1 text-center text-[13px] text-muted-foreground">
        Choose a tab to open in the side pane.
      </p>
      <div role="listbox" aria-label="Sections" className="mt-8 grid w-full max-w-[340px] grid-cols-2 gap-3">
        {SECTION_ADD_ORDER.map((id) => {
          const meta = TAB_META[id];
          const isBottomTerminal = id === 'terminal';
          const isOpen = openSections.includes(id) || (isBottomTerminal && bottomTerminalOpen);
          const Icon = meta.Icon;
          return (
            <button
              key={id}
              type="button"
              role="option"
              aria-selected={isOpen}
              title={isBottomTerminal ? 'Dock a terminal at the bottom' : isOpen ? `${meta.label} is already open` : `Open ${meta.label}`}
              onClick={() => pick(id)}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border px-4 py-6 transition',
                isOpen
                  ? 'border-primary/40 bg-primary/5 text-foreground'
                  : 'border-border/60 bg-card/60 text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )}
            >
              <Icon className="size-6 shrink-0 opacity-80" />
              <span className="text-[13px] font-medium">
                {isBottomTerminal ? 'Terminal (bottom)' : meta.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
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
      return <RightDrawerTasksSection sessionId={ctx.sessionId} todos={ctx.workbenchSession?.todos ?? []} />;
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
    case 'notes':
      return <RightDrawerNotesSection sessionId={ctx.sessionId} />;
    case 'subagents':
      return (
        <RightDrawerSubagentsSection
          sessionId={ctx.sessionId}
          workbenchSessionId={ctx.workbenchSession?.id ?? null}
        />
      );
    case 'artifacts':
      return <RightDrawerArtifactsSection sessionId={ctx.sessionId} />;
    case 'circuit':
      return <RightDrawerCircuitSection sessionId={ctx.sessionId} />;
    case 'routines':
      // Bot Mode Phase B: routines are a Bot-chat surface — render only
      // inside a canonical Bot Chat (the pane derives the Bot handle).
      if (!ctx.workbenchSession?.canonicalBotChat || !ctx.workbenchSession.agentId) {
        return (
          <p className="px-4 py-6 text-xs text-muted-foreground/60">
            Routines live in a Bot&apos;s chat — open a Bot from the sidebar rail.
          </p>
        );
      }
      return <RoutinesDrawerSection agentId={ctx.workbenchSession.agentId} />;
  }
}

/** Resolve the Bot handle then mount the pane (the [bot:<name>] namespace). */
function RoutinesDrawerSection({ agentId }: { agentId: string }) {
  const botQ = useQuery({
    queryKey: ['bots', 'one', agentId],
    queryFn: () => getBot(agentId),
    staleTime: 60_000,
  });
  const bot = botQ.data;
  if (!bot) return <p className="px-4 py-6 text-xs text-muted-foreground/60">Loading Bot…</p>;
  return (
    <div className="p-2">
      <RoutinesPane agentId={agentId} botName={bot.name} />
    </div>
  );
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
    <section className="august-drawer-card relative flex h-full min-h-0 overflow-hidden rounded-lg border border-border/50 shadow-sm">
      <div className="min-h-0 flex-1 overflow-y-auto">{renderSection(sectionId, ctx)}</div>
    </section>
  );
}

