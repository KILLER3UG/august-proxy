/* ── RightDrawerLauncher ─ Workbench section dropdown ───────────── */

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { ChevronDown, FileDiff, ListTodo, ClipboardList, TerminalSquare, Play } from 'lucide-react';
import type { RightDrawerSectionId } from './RightDrawerState';

const SECTION_META: Record<RightDrawerSectionId, { label: string; desc: string; Icon: typeof FileDiff }> = {
  preview: {
    label: 'Preview',
    desc: 'Run a local browser preview',
    Icon: Play,
  },
  diff: {
    label: 'Diff',
    desc: 'View full file changes',
    Icon: FileDiff,
  },
  terminal: {
    label: 'Terminal',
    desc: 'Run commands and inspect output',
    Icon: TerminalSquare,
  },
  tasks: {
    label: 'Task/Todo list',
    desc: 'Track active Workbench todos',
    Icon: ListTodo,
  },
  plan: {
    label: 'Plan',
    desc: 'Review the Workbench plan',
    Icon: ClipboardList,
  },
};

const OPTIONS: RightDrawerSectionId[] = ['diff', 'terminal', 'plan', 'tasks', 'preview'];

export function RightDrawerDropdown({ onSelect }: {
  onSelect: (section: RightDrawerSectionId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex items-center gap-1.5 text-xs outline-none cursor-pointer shrink-0 h-8',
          'text-muted-foreground hover:text-foreground transition-all duration-200',
          'bg-muted/30 hover:bg-muted/50 rounded-md px-2 py-1',
        )}
        title="Open Workbench section"
      >
        <span className="font-medium text-foreground">Workbench</span>
        <ChevronDown className={cn('size-3 shrink-0 opacity-60 transition-transform duration-200', open && 'rotate-180')} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="absolute bottom-full mb-1.5 right-0 z-50 min-w-[240px] max-w-[320px] bg-popover rounded-lg shadow-2xl overflow-hidden origin-bottom-right"
          >
            <div className="px-2.5 py-1 text-[10px] text-muted-foreground/50 uppercase tracking-widest font-semibold mb-0.5">
              Workbench sections
            </div>
            <div className="max-h-[260px] overflow-y-auto py-0.5">
              {OPTIONS.map((sectionId) => {
                const meta = SECTION_META[sectionId];
                return (
                  <button
                    key={sectionId}
                    type="button"
                    onClick={() => {
                      onSelect(sectionId);
                      setOpen(false);
                    }}
                    className="w-full text-left px-2.5 py-1.5 text-sm transition-all duration-150 flex items-center gap-2 rounded-md mx-1 hover:bg-white/5 hover:text-foreground"
                  >
                    <meta.Icon className="size-4 text-muted-foreground/70 shrink-0" />
                    <span className="truncate flex-1 font-sans">{meta.label}</span>
                    <span className="text-[11px] text-muted-foreground/55">{meta.desc}</span>
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
