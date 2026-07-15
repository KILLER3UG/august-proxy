/* ── Composer actions (+) ──────────────────────────────────────────────── */
/* Plus-button menu: attach file, open @-mention picker, start voice input. */

import { createPortal } from 'react-dom';
import { Paperclip, Mic, AtSign, Plus } from 'lucide-react';
import { ToolBtn } from '../ComposerControls';
import type { AnchorPos } from './useComposerPopovers';

export function ComposerActionsMenu({
  open,
  pos,
  triggerRef,
  onToggle,
  onAttach,
  onMention,
  onVoice,
}: {
  open: boolean;
  pos: AnchorPos | null;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  onAttach: () => void;
  onMention: () => void;
  onVoice: () => void;
}) {
  return (
    <div className="relative">
      <ToolBtn
        Icon={Plus}
        label="Composer actions"
        className="h-8 w-8"
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
            className="z-50 w-44 bg-card border border-border rounded-xl shadow-2xl p-1.5"
          >
            <button
              type="button"
              onClick={onAttach}
              className="w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted transition flex items-center justify-between"
            >
              <span>Attach file</span>
              <Paperclip className="size-3.5 text-muted-foreground" />
            </button>
            <button
              type="button"
              onClick={onMention}
              className="w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted transition flex items-center justify-between"
            >
              <span>Mention skill / tool</span>
              <AtSign className="size-3.5 text-muted-foreground" />
            </button>
            <button
              type="button"
              onClick={onVoice}
              className="w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted transition flex items-center justify-between"
            >
              <span>Voice input</span>
              <Mic className="size-3.5 text-muted-foreground" />
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
