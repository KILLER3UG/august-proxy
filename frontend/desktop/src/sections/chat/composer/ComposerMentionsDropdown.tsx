/* ── Skills & tools picker ─────────────────────────────────────────────── */
/* Fixed portal above the composer for @-mentions and the tools shortcut.  */

import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { COMPOSER_TOOLS as TOOLS, type MentionItem } from '../composer-mentions';
import type { AnchorPos } from './useComposerPopovers';

export function ComposerMentionsDropdown({
  open,
  pos,
  mentionQuery,
  mentionItems,
  skillMentions,
  skillsLoading,
  highlightedMentionIndex,
  onPick,
  onInsertToolText,
}: {
  open: boolean;
  pos: AnchorPos | null;
  mentionQuery: string | null;
  mentionItems: MentionItem[];
  skillMentions: MentionItem[];
  skillsLoading: boolean;
  highlightedMentionIndex: number;
  onPick: (item: MentionItem) => void;
  onInsertToolText: (text: string) => void;
}) {
  if (!open || !pos) return null;

  const list: MentionItem[] =
    mentionQuery !== null
      ? mentionItems
      : [
          ...skillMentions.slice(0, 12),
          ...TOOLS.map((t) => ({
            kind: 'tool' as const,
            name: t.name,
            desc: t.desc,
            insert: `${t.name} `,
          })),
        ];

  // Part 27 G1: section header per kind group (the merged list is sorted by
  // kind), plus a compact kind chip on each row.
  const KIND_SECTION: Record<MentionItem['kind'], string> = {
    skill: 'Skills',
    tool: 'Tools',
    mcp: 'Plugins',
    file: 'Files',
    conversation: 'Chats',
    lane: 'Lanes & routines',
    routine: 'Lanes & routines',
    bot: 'Bots',
  };
  const KIND_CHIP: Record<MentionItem['kind'], string> = {
    skill: 'skill',
    tool: 'tool',
    mcp: 'plugin',
    file: 'file',
    conversation: 'chat',
    lane: 'lane',
    routine: 'routine',
    bot: 'bot',
  };

  return createPortal(
    <div
      data-composer-popover
      data-testid="mention-picker"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        transform: 'translateY(-100%)',
      }}
      className="z-50 w-80 max-h-72 overflow-auto bg-card border border-border shadow-2xl rounded-xl p-1.5 space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150"
    >
      <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold flex items-center justify-between">
        <span>{mentionQuery !== null ? 'Mentions' : 'Skills & tools'}</span>
        {skillsLoading && <Loader2 className="size-3 animate-spin" />}
      </div>
      {mentionQuery !== null && mentionItems.length === 0 && !skillsLoading && (
        <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
          No skills match “{mentionQuery}”. Try another name or pick a tool.
        </div>
      )}
      {list.map((item, idx) => {
        const prev = list[idx - 1];
        const showHeader = !prev || KIND_SECTION[prev.kind] !== KIND_SECTION[item.kind];
        return (
          <div key={`${item.kind}-${item.name}`}>
            {showHeader && (
              <div className="px-2.5 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                {KIND_SECTION[item.kind]}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                if (mentionQuery !== null) {
                  onPick(item);
                } else if (item.kind === 'skill') {
                  onPick(item);
                } else {
                  onInsertToolText(item.insert.trimEnd());
                }
              }}
              className={cn(
                'w-full text-left rounded-md px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition flex items-center justify-between gap-2',
                mentionQuery !== null && idx === highlightedMentionIndex && 'bg-muted',
              )}
            >
              <span className="font-mono font-medium text-primary truncate">
                {item.kind === 'skill' ? `@${item.name}` : item.name}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="rounded border border-border/50 bg-muted/30 px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
                  {KIND_CHIP[item.kind]}
                </span>
                <span className="max-w-[45%] truncate text-[10px] text-muted-foreground">
                  {item.desc}
                </span>
              </span>
            </button>
          </div>
        );
      })}
      {mentionQuery === null && skillMentions.length === 0 && !skillsLoading && (
        <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
          Type <span className="font-mono text-foreground/80">@</span> to search
          skills, or pick a tool below.
        </div>
      )}
    </div>,
    document.body,
  );
}
