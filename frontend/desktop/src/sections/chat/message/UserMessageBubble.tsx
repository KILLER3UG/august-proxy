import { useState } from 'react';
import { Check, Copy, History, Pencil, RotateCw } from 'lucide-react';
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
  const editCount = message.editHistory?.length ?? 0;
  const [showHistory, setShowHistory] = useState(false);

  return (
    <>
      <div className="group max-w-[80%] ml-auto flex flex-col items-end gap-1.5">
        {hasAttachments && !editing ? (
          <FileAttachmentCardRow attachments={message.attachments!} />
        ) : null}

        {(editing || displayContent || message.queued) && (
          <div className="rounded-2xl bg-user-bubble px-4 py-2.5 w-full border border-border/20 shadow-2xs hover:border-border/40 transition-colors duration-150 text-[0.84375rem] leading-relaxed">
            {message.queued && (
              <div className="mb-1 flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-warning">
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
                  <button onClick={onCancelEdit} className="px-2.5 py-0.5 text-2xs rounded-md hover:bg-muted text-muted-foreground transition">Cancel</button>
                  <button onClick={onSaveEdit} className="px-2.5 py-0.5 text-2xs rounded-md bg-primary text-primary-foreground hover:opacity-90 transition">Save</button>
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
            className="mr-1 text-2xs font-semibold uppercase tracking-caps text-primary hover:underline"
          >
            {userMsgExpanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {!editing && message.timestamp && (
          <span className="bubble-footer-text mr-0.5 font-medium text-muted-foreground/50">
            {formatClockTime(message.timestamp)}
          </span>
        )}
        {!editing && editCount > 0 && (
          <div className="relative">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="flex items-center gap-0.5 rounded p-1 text-muted-foreground/70 transition-colors duration-150 hover:text-foreground"
              title={`${editCount} previous version${editCount > 1 ? 's' : ''}`}
            >
              <History className="size-3" />
              <span className="text-2xs">{editCount}</span>
            </button>
            {showHistory && (
              <div className="absolute bottom-full right-0 mb-1 w-64 bg-card border border-border rounded-lg shadow-lg p-2 z-50 max-h-48 overflow-y-auto">
                <div className="text-2xs uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
                  Version History
                </div>
                {message.editHistory?.map((v, i) => (
                  <div key={i} className="text-xs p-1.5 rounded bg-muted/30 mb-1 last:mb-0">
                    <div className="text-2xs text-muted-foreground mb-0.5">
                      {new Date(v.timestamp).toLocaleString()}
                    </div>
                    <div className="line-clamp-3 text-foreground/80">{v.content}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
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
              <Copy className="size-3" />
            )}
          </button>
        )}
        <button
          onClick={onStartEdit}
          className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          title="Edit message"
          aria-label="Edit message"
        >
          <Pencil className="size-3" />
        </button>
        <button
          onClick={onRevert}
          className="rounded p-1 font-mono text-2xs leading-none text-muted-foreground transition hover:bg-muted hover:text-foreground"
          title="Revert changes after this message" aria-label="Revert changes after this message"
        >
          &larr;
        </button>
        {isLast && (
          <button
            onClick={onRegen}
            disabled={streaming || isRegenerating}
            className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="Regenerate response"
            aria-label="Regenerate response"
          >
            <RotateCw
              className={cn('size-3', isRegenerating && 'animate-spin')}
            />
          </button>
        )}
      </div>
    </>
  );
}
