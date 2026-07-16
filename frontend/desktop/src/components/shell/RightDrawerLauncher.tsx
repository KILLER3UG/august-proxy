/* ── RightDrawerLauncher ─ Workbench section dropdown ───────────── */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  PanelRight,
  PanelRightClose,
  FileDiff,
  ListTodo,
  ClipboardList,
  TerminalSquare,
  Play,
  Check,
  Globe,
} from 'lucide-react';
import { useRightDrawer, type RightDrawerSectionId } from './RightDrawerState';

const SECTION_META: Record<
  RightDrawerSectionId,
  { label: string; hint?: string; Icon: typeof FileDiff }
> = {
  preview: {
    label: 'Preview',
    hint: 'Live preview of what August is building',
    Icon: Play,
  },
  diff: {
    label: 'Diffs',
    hint: 'Files August changed this session',
    Icon: FileDiff,
  },
  terminal: {
    label: 'Terminal',
    hint: 'Real PowerShell/bash shell (or open Windows Terminal)',
    Icon: TerminalSquare,
  },
  tasks: {
    label: 'Tasks',
    hint: 'Step-by-step todos for the current plan',
    Icon: ListTodo,
  },
  plan: {
    label: 'Plan',
    hint: 'Proposed steps — accept or revise before edits',
    Icon: ClipboardList,
  },
  browser: {
    label: 'Browser',
    hint: 'Pages August opened for research',
    Icon: Globe,
  },
};

const OPTIONS: RightDrawerSectionId[] = ['diff', 'terminal', 'plan', 'tasks', 'preview', 'browser'];

export function RightDrawerDropdown({ drawerOpen, onSelect }: {
  drawerOpen: boolean;
  onSelect: (section: RightDrawerSectionId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const state = useRightDrawer();

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Checkmarks only appear when the drawer itself is expanded.
  const showCheck = state.open;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="size-11 flex items-center justify-center shrink-0 hover:bg-accent text-muted-foreground/60 hover:text-foreground transition"
        title={drawerOpen ? 'Workbench sections' : 'Open Workbench'}
      >
        {drawerOpen ? (
          <PanelRightClose className="size-3.5" />
        ) : (
          <PanelRight className="size-3.5" />
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="absolute top-full mt-1.5 right-0 z-50 min-w-[220px] max-w-[280px] bg-popover rounded-lg shadow-2xl overflow-hidden origin-top-right"
          >
            <div className="max-h-[300px] overflow-y-auto py-0.5">
              {OPTIONS.map((sectionId) => {
                const meta = SECTION_META[sectionId];
                const isOpen = showCheck && state.sections.includes(sectionId);
                return (
                  <button
                    key={sectionId}
                    type="button"
                    title={meta.hint}
                    onClick={() => {
                      onSelect(sectionId);
                      setOpen(false);
                    }}
                    className={cn(
                      'w-full text-left px-3 py-2 text-sm transition-all duration-150 flex items-start gap-2 rounded-md mx-1',
                      isOpen
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-white/5 hover:text-foreground'
                    )}
                  >
                    <meta.Icon className="size-4 text-muted-foreground/70 shrink-0 mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-sans font-semibold">{meta.label}</span>
                      {meta.hint && (
                        <span className="block text-[10px] leading-snug text-muted-foreground font-normal mt-0.5">
                          {meta.hint}
                        </span>
                      )}
                    </span>
                    {isOpen && (
                      <Check className="size-3.5 ml-auto text-primary shrink-0 mt-0.5" />
                    )}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
