/* ── Slash-command picker ──────────────────────────────────────────────── */
/* Fixed portal listing voice/slash commands while the input starts with /. */

import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { getDisplayCommands } from '@/api/voice/registry';
import type { AnchorPos } from './useComposerPopovers';

export function ComposerCommandsDropdown({
  open,
  pos,
  input,
  highlightedCommandIndex,
  onPick,
}: {
  open: boolean;
  pos: AnchorPos | null;
  input: string;
  highlightedCommandIndex: number;
  onPick: (name: string) => void;
}) {
  if (!open || !pos) return null;

  const queryToken = input.trim().toLowerCase().split(/\s+/)[0];
  const commands = getDisplayCommands().filter((c) => {
    if (!queryToken) return true;
    return c.name.toLowerCase().startsWith(queryToken);
  });
  const hasTypedQuery = Boolean(input.trim());
  const noMatch =
    hasTypedQuery &&
    getDisplayCommands().filter((c) => {
      const q = input.trim().toLowerCase().split(/\s+/)[0];
      if (!q) return false;
      return c.name.toLowerCase().startsWith(q);
    }).length === 0;

  return createPortal(
    <div
      data-composer-popover
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        transform: 'translateY(-100%)',
      }}
      className="z-50 w-72 bg-card border border-border shadow-2xl rounded-xl p-1.5 space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150"
    >
      <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold">
        Commands & Tools
      </div>
      {commands.map((c, idx) => (
        <button
          key={c.name}
          onClick={() => onPick(c.name)}
          className={cn(
            'w-full text-left rounded-md px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition flex items-center justify-between gap-2',
            idx === highlightedCommandIndex && 'bg-muted',
          )}
        >
          <span className="font-mono font-medium text-warning shrink-0">{c.name}</span>
          <span className="text-[10px] text-muted-foreground truncate">{c.desc}</span>
        </button>
      ))}
      {noMatch && (
        <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
          No matching command. Press Enter to send as a normal message.
        </div>
      )}
    </div>,
    document.body,
  );
}
