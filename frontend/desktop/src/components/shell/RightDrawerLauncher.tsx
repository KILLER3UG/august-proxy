/* ── RightDrawerLauncher ─ section picker modal ─────────────────── */

import type { ComponentType } from 'react';
import { Backdrop } from '@/components/overlays/Backdrop';
import { cn } from '@/lib/utils';
import { FileDiff, ListTodo, ClipboardList, TerminalSquare, Play } from 'lucide-react';
import type { RightDrawerSectionId } from './RightDrawerState';

const SECTION_META: Record<RightDrawerSectionId, { label: string; description: string; Icon: ComponentType<{ className?: string }> }> = {
  preview: {
    label: 'Preview',
    description: 'Run a local browser preview',
    Icon: Play,
  },
  diff: {
    label: 'Diff',
    description: 'View full file changes',
    Icon: FileDiff,
  },
  terminal: {
    label: 'Terminal',
    description: 'Run commands and inspect output',
    Icon: TerminalSquare,
  },
  tasks: {
    label: 'Task/Todo list',
    description: 'Track active Workbench todos',
    Icon: ListTodo,
  },
  plan: {
    label: 'Plan',
    description: 'Review the Workbench plan',
    Icon: ClipboardList,
  },
};

const LAUNCHER_SECTIONS: RightDrawerSectionId[] = ['diff', 'terminal', 'plan', 'tasks', 'preview'];

export function RightDrawerLauncher({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (section: RightDrawerSectionId) => void;
}) {
  if (!open) return null;

  return (
    <Backdrop onClose={onClose}>
      <div className="w-[280px] rounded-2xl border border-border bg-card p-3 shadow-2xl">
        <div className="mb-3">
          <div className="text-sm font-semibold text-foreground">Open Workbench</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">Choose what to show in the sidebar</div>
        </div>

        <div className="space-y-2">
          {LAUNCHER_SECTIONS.map((sectionId) => {
            const meta = SECTION_META[sectionId];
            return (
              <button
                key={sectionId}
                type="button"
                onClick={() => onSelect(sectionId)}
                className={cn(
                  'w-full rounded-xl border border-border/60 bg-background/60 p-3 text-left transition',
                  'hover:border-primary/50 hover:bg-primary/10'
                )}
              >
                <div className="flex items-center gap-2">
                  <meta.Icon className="size-4 text-muted-foreground shrink-0" />
                  <span className="text-[13px] font-medium text-foreground">{meta.label}</span>
                </div>
                <div className="mt-1 pl-6 text-[11px] text-muted-foreground">{meta.description}</div>
              </button>
            );
          })}
        </div>
      </div>
    </Backdrop>
  );
}
