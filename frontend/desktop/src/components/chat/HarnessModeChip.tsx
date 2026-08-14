/* Harness agent_mode: chat | agent | code | orchestrator (orthogonal to guard mode). */

import { useState } from 'react';
import { Bot, GitBranch, MessageSquare, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';

export type HarnessAgentMode = 'chat' | 'agent' | 'code' | 'orchestrator';

const MODES: {
  id: HarnessAgentMode;
  label: string;
  hint: string;
  Icon: typeof Bot;
}[] = [
  { id: 'agent', label: 'Agent', hint: 'Native tools in this chat', Icon: Bot },
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    hint: 'Dispatch workstreams; workers edit/shell',
    Icon: GitBranch,
  },
  { id: 'chat', label: 'Chat', hint: 'Text only — no tools', Icon: MessageSquare },
  { id: 'code', label: 'Code', hint: 'Fenced Python workspace API', Icon: Terminal },
];

export function normalizeHarnessMode(raw?: string | null): HarnessAgentMode {
  const m = (raw || 'agent').trim().toLowerCase();
  if (m === 'planner' || m === 'orchestrator') return 'orchestrator';
  if (m === 'chat' || m === 'code' || m === 'agent') return m;
  return 'agent';
}

export function HarnessModeChip({
  mode,
  onChange,
  disabled,
}: {
  mode: HarnessAgentMode;
  onChange: (mode: HarnessAgentMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  const Icon = current.Icon;

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        data-testid="harness-mode-chip"
        aria-label={`Harness mode: ${current.label}`}
        title={current.hint}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition',
          mode === 'orchestrator'
            ? 'border-violet-500/40 bg-violet-500/10 text-violet-200'
            : 'border-border/60 text-muted-foreground hover:text-foreground',
          disabled && 'opacity-40',
        )}
      >
        <Icon className="size-3" />
        {current.label}
      </button>
      {open ? (
        <div
          className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-xl border border-border/60 bg-popover py-1 shadow-xl"
          data-testid="harness-mode-menu"
          role="menu"
        >
          {MODES.map((opt) => {
            const OIcon = opt.Icon;
            return (
              <button
                key={opt.id}
                type="button"
                role="menuitemradio"
                aria-checked={opt.id === mode}
                data-mode={opt.id}
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/40',
                  opt.id === mode && 'bg-muted/30',
                )}
                onClick={() => {
                  onChange(opt.id);
                  setOpen(false);
                }}
              >
                <OIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span>
                  <span className="block text-xs font-medium text-foreground">{opt.label}</span>
                  <span className="block text-[10px] text-muted-foreground">{opt.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
