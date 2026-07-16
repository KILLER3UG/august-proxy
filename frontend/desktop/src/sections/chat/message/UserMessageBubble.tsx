import { Check } from 'lucide-react';
import { cn, formatClockTime } from '@/lib/utils';
import { getFileIcon } from '@/lib/file-icon';
import type { ChatMessage } from '@/types/chat';
import { Markdown } from '../ChatMarkdown';

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
  return (
    <>
      <div className="group rounded-2xl bg-muted/35 px-3.5 py-2 max-w-[80%] ml-auto border border-transparent hover:bg-muted/45 transition-colors duration-150">
        {/* Mid-response queued messages get a small "Queued" badge
            so the conversation flow makes it clear that the
            message arrived while the model was already working
            and was injected without interrupting. */}
        {message.queued && (
          <div className="flex items-center gap-1 mb-1 text-[10px] uppercase tracking-wider text-warning font-semibold">
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
        ) : (
          <div className={cn(
            "relative",
            !userMsgExpanded && message.content.length > LONG_MSG_THRESHOLD && "max-h-[160px] overflow-hidden"
          )}>
            {message.attachments && message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {message.attachments.map((a, i) => {
                  const fi = getFileIcon(a.name);
                  const IconComp = fi.Icon;
                  const thumb = a.dataUrl || a.previewUrl;
                  const isImage = a.type === 'image' && !!thumb;
                  return (
                    <div
                      key={a.id ?? `${a.name}-${i}`}
                      className="inline-flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-md bg-muted/60 border border-border/40 text-[10px] max-w-[180px]"
                    >
                      {isImage ? (
                        <img
                          src={thumb}
                          alt=""
                          className="size-7 rounded object-cover shrink-0"
                          draggable={false}
                        />
                      ) : (
                        <span className="flex size-7 items-center justify-center rounded bg-muted shrink-0">
                          <IconComp size={14} color={fi.color} />
                        </span>
                      )}
                      <span className="font-mono truncate">{a.name}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <Markdown content={message.content} />
            {!userMsgExpanded && message.content.length > LONG_MSG_THRESHOLD && (
              <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[hsl(var(--muted)/0.9)] to-transparent pointer-events-none" />
            )}
          </div>
        )}
      </div>
      <div
        className={cn(
          "flex items-center gap-1 mt-1 mr-1 transition-opacity duration-150 self-end",
          showActions ? "opacity-100" : "opacity-0"
        )}
      >
        {message.content.length > LONG_MSG_THRESHOLD && !editing && (
          <button
            type="button"
            onClick={() => setUserMsgExpanded(!userMsgExpanded)}
            className="text-[11px] font-semibold uppercase tracking-caps text-primary hover:underline mr-1"
          >
            {userMsgExpanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {!editing && message.timestamp && (
          <span className="bubble-footer-text text-muted-foreground/50 font-medium mr-0.5">
            {formatClockTime(message.timestamp)}
          </span>
        )}
        {!editing && (
          <button
            onClick={onCopy}
            className="p-1 rounded text-muted-foreground/70 hover:text-foreground transition-colors duration-150"
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
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition"
          title="Edit message"
        >
          <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>
          </svg>
        </button>
        <button
          onClick={onRevert}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition font-mono text-[11px] leading-none"
          title="Revert changes after this message"
        >
          &larr;
        </button>
        {isLast && (
          <button
            onClick={onRegen}
            disabled={streaming || isRegenerating}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-50"
            title="Regenerate response"
          >
            <svg
              className={cn("size-3", isRegenerating && "animate-spin")}
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
