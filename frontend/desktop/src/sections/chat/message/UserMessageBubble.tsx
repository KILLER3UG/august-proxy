import { Check } from 'lucide-react';
import { cn, formatClockTime } from '@/lib/utils';
import type { ChatMessage } from '@/types/chat';
import { Markdown } from '../ChatMarkdown';
import { ChatAttachmentService } from '../services/ChatAttachmentService';
import { FileAttachmentCardRow } from './FileAttachmentCard';

/** Collapse long user messages until the user expands them. */
export const LONG_MSG_THRESHOLD = 1000;

export function UserMessageBubble({
  message,
  editing,
  editText,
  setEditText,
  userMsgExpanded,
  setUserMsgExpanded,
  showActions,
  copied,
  streaming,
  isLast,
  isRegenerating,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onCopy,
  onRegen,
  onRevert,
}: {
  message: ChatMessage;
  editing: boolean;
  editText: string;
  setEditText: (text: string) => void;
  userMsgExpanded: boolean;
  setUserMsgExpanded: (expanded: boolean) => void;
  showActions: boolean;
  copied: boolean;
  streaming?: boolean;
  isLast?: boolean;
  isRegenerating: boolean;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onCopy: () => void;
  onRegen: () => void;
  onRevert?: () => void;
}) {
  const displayContent = ChatAttachmentService.displayText(
    message.content,
    message.attachments,
  );
  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  const isLong = displayContent.length > LONG_MSG_THRESHOLD;

  return (
    <>
      <div className="group max-w-[80%] ml-auto flex flex-col items-end gap-1.5">
        {hasAttachments && !editing ? (
          <FileAttachmentCardRow attachments={message.attachments!} />
        ) : null}

        {(editing || displayContent || message.queued) && (
          <div className="rounded-2xl bg-muted/35 px-3.5 py-2 w-full border border-transparent hover:bg-muted/45 transition-colors duration-150">
            {message.queued && (
              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-warning">
                <span className="size-1.5 rounded-full bg-warning" />
                Queued
              </div>
            )}
            {editing ? (
              <div className="flex flex-col gap-2">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="w-full resize-none bg-transparent text-sm outline-none text-foreground"
                  rows={3}
                  autoFocus
                />
                <div className="flex items-center gap-1.5 justify-end">
                  <button onClick={onCancelEdit} className="px-2.5 py-0.5 text-[11px] rounded-md hover:bg-muted text-muted-foreground transition">Cancel</button>
                  <button onClick={onSaveEdit} className="px-2.5 py-0.5 text-[11px] rounded-md bg-primary text-primary-foreground hover:opacity-90 transition">Save</button>
                </div>
              </div>
            ) : displayContent ? (
              <div
                className={cn(
                  'relative',
                  !userMsgExpanded && isLong && 'max-h-[160px] overflow-hidden',
                )}
              >
                <Markdown content={displayContent} />
                {!userMsgExpanded && isLong && (
                  <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[hsl(var(--muted)/0.9)] to-transparent" />
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
      <div
        className={cn(
          'mt-1 mr-1 flex items-center gap-1 self-end transition-opacity duration-150',
          showActions ? 'opacity-100' : 'opacity-0',
        )}
      >
        {isLong && !editing && (
          <button
            type="button"
            onClick={() => setUserMsgExpanded(!userMsgExpanded)}
            className="mr-1 text-[11px] font-semibold uppercase tracking-caps text-primary hover:underline"
          >
            {userMsgExpanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {!editing && message.timestamp && (
          <span className="bubble-footer-text mr-0.5 font-medium text-muted-foreground/50">
            {formatClockTime(message.timestamp)}
          </span>
        )}
        {!editing && (
          <button
            onClick={onCopy}
            className="rounded p-1 text-muted-foreground/70 transition-colors duration-150 hover:text-foreground"
            title="Copy message"
            aria-label="Copy message"
          >
            {copied ? (
              <Check className="size-3 text-success" />
            ) : (
              <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            )}
          </button>
        )}
        <button
          onClick={onStartEdit}
          className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          title="Edit message"
        >
          <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>
          </svg>
        </button>
        <button
          onClick={onRevert}
          className="rounded p-1 font-mono text-[11px] leading-none text-muted-foreground transition hover:bg-muted hover:text-foreground"
          title="Revert changes after this message"
        >
          &larr;
        </button>
        {isLast && (
          <button
            onClick={onRegen}
            disabled={streaming || isRegenerating}
            className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="Regenerate response"
          >
            <svg
              className={cn('size-3', isRegenerating && 'animate-spin')}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        )}
      </div>
    </>
  );
}
