/* ── Composer actions (+) ──────────────────────────────────────────────── */
/* Plus-button menu: attach, mention, voice, camera, dispatch, arena, debate,
 * and — in the footer group — the session mode and cost controls.
 *
 * Its ANATOMY is the reference's popover, not a flat list. The capture
 * describes that popover: "a floating rounded panel, radius ~12 px, hairline
 * border, a near-black fill, and a soft drop shadow… A small uppercase muted
 * group label… Rows are borderless, separated by hairlines, hover = lighter fill. A
 * footer group below a hairline." The group labels here are sentence case
 * rather than uppercase — the capture's own Claude nav says the group labels
 * are "small, muted, sentence case — NOT uppercase", and sentence case is the
 * vocabulary the lists in this app already use.
 *
 * The rows also moved their glyph to the FRONT: the reference's row is
 * [glyph][label]…[chevron], while this one had [label]……[glyph], which put
 * seven labels and seven unrelated icons at opposite ends of a 224 px panel.
 */

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Paperclip, Mic, AtSign, Plus, Bot, Swords, Gavel, Camera, type LucideIcon } from 'lucide-react';
import { ToolBtn } from '../ComposerControls';
import type { AnchorPos } from './useComposerPopovers';

/** One menu row: a muted glyph, then the label. Borderless; the hairline
 *  between rows is drawn by the group's `divide-y`. */
function MenuRow({
  icon: Icon,
  label,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 transition hover:bg-muted/50"
      data-testid={testId}
    >
      <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/** A labelled group of rows. `divide-y` draws the hairline between them —
 *  the reference's "rows are borderless, separated by hairlines". */
function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-1 last:mb-0">
      <div className="px-2 pb-0.5 pt-1.5 text-2xs font-medium text-muted-foreground/80">
        {label}
      </div>
      <div className="divide-y divide-border/50">{children}</div>
    </div>
  );
}

export function ComposerActionsMenu({
  open,
  pos,
  triggerRef,
  onToggle,
  onAttach,
  onMention,
  onVoice,
  onCamera,
  onSpawn,
  onAskParallel,
  onStartDebate,
  extras,
}: {
  open: boolean;
  pos: AnchorPos | null;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  onAttach: () => void;
  onMention: () => void;
  onVoice: () => void;
  /** Open the camera capture popover (browser webcam). */
  onCamera?: () => void;
  /** Open the sub-agent spawn launcher (bound to the active session). */
  onSpawn?: () => void;
  onAskParallel?: () => void;
  onStartDebate?: () => void;
  /** Make Changes / context / cost — the panel's FOOTER group, below the
   *  hairline, where the reference keeps its secondary commands. */
  extras?: ReactNode;
}) {
  return (
    <div className="relative">
      <ToolBtn
        Icon={Plus}
        label="Composer actions"
        className="h-8 w-8 rounded-full"
        buttonRef={triggerRef}
        onClick={onToggle}
      />
      {open &&
        pos &&
        createPortal(
          <div
            data-composer-popover
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              transform: 'translateY(-100%)',
            }}
            className="z-50 w-56 bg-popover border border-border/60 rounded-xl shadow-2xl p-1.5"
          >
            <MenuGroup label="Add">
              <MenuRow icon={Paperclip} label="Attach file" onClick={onAttach} />
              <MenuRow icon={AtSign} label="Mention skill / tool" onClick={onMention} />
            </MenuGroup>
            <MenuGroup label="Input">
              <MenuRow icon={Mic} label="Voice input" onClick={onVoice} />
              {onCamera && (
                <MenuRow
                  icon={Camera}
                  label="Camera capture"
                  onClick={onCamera}
                  testId="composer-camera-open"
                />
              )}
            </MenuGroup>
            <MenuGroup label="Run">
              {onSpawn && (
                <MenuRow
                  icon={Bot}
                  label="Dispatch workstreams"
                  onClick={onSpawn}
                  testId="composer-spawn-subagents"
                />
              )}
              {onAskParallel && (
                <MenuRow
                  icon={Swords}
                  label="Ask in parallel"
                  onClick={onAskParallel}
                  testId="arena-open"
                />
              )}
              {onStartDebate && (
                <MenuRow
                  icon={Gavel}
                  label="Debate"
                  onClick={onStartDebate}
                  testId="debate-open"
                />
              )}
            </MenuGroup>
            {extras && (
              <div className="mt-1 border-t border-border/50 px-1.5 py-1.5">{extras}</div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
