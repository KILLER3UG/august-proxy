/* ── QueuePills ───────────────────────────────────────────────────────── */
/* Mid-response queue: drag reorder, edit pill text, cancel, clear-all.   */

import { useState } from 'react';
import { MoreHorizontal, Trash2, X, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { workbenchClient } from '@/api/workbench';
import {
  setQueuedMessages,
  reorderQueuedMessagesLocal,
  updateQueuedMessageLocal,
  type QueuedUserMessage,
} from './queue-store';
import { describeSubagentReceipt, parseSubagentReceipt } from './subagent-receipt';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

type Props = {
  /** Sidebar / UI session id (local store key). */
  sessionId: string;
  /** Workbench backend session id for API calls. */
  workbenchSessionId: string;
  items: QueuedUserMessage[];
};

export function QueuePills({ sessionId, workbenchSessionId, items }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const wbId = workbenchSessionId || sessionId;

  const cancelOne = (id: string) => {
    void workbenchClient.dequeueMessage(wbId, id).catch((err) => {
      console.error('[dequeue] failed', err);
      toast.error('Could not cancel queued message');
    });
    setQueuedMessages(
      sessionId,
      items.filter((e) => e.id !== id),
    );
  };

  const clearAll = () => {
    void workbenchClient.clearQueue(wbId).catch((err) => {
      console.error('[clear queue] failed', err);
      toast.error('Could not clear queue');
    });
    setQueuedMessages(sessionId, []);
    toast.message('Queue cleared');
  };

  /** Promote a plain queued follow-up to a mid-run steer (applies at the
   *  next tool/LLM boundary instead of waiting for the turn to end). */
  const promoteToSteer = (q: QueuedUserMessage) => {
    void (async () => {
      try {
        await workbenchClient.dequeueMessage(wbId, q.id);
        const entry = await workbenchClient.steerMessage(wbId, q.text, q.attachments);
        setQueuedMessages(sessionId, [entry, ...items.filter((e) => e.id !== q.id)]);
        toast.message('Promoted to direction — applies at the next step');
      } catch (err) {
        console.error('[promote to steer] failed', err);
        toast.error('Could not promote to direction');
      }
    })();
  };

  const startEdit = (q: QueuedUserMessage) => {
    setEditingId(q.id);
    setEditText(q.text);
  };

  const saveEdit = (id: string) => {
    const text = editText.trim();
    if (!text) {
      toast.error('Message cannot be empty');
      return;
    }
    updateQueuedMessageLocal(sessionId, id, text);
    setEditingId(null);
    void workbenchClient.updateQueuedMessage(wbId, id, text).catch((err) => {
      console.error('[update queue] failed', err);
      toast.error('Could not update queued message');
    });
  };

  const moveQueuedMessage = (id: string, offset: -1 | 1) => {
    const ids = items.map((e) => e.id);
    const from = ids.indexOf(id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    [next[from], next[to]] = [next[to], next[from]];
    reorderQueuedMessagesLocal(sessionId, next);
    void workbenchClient.reorderQueue(wbId, next).catch((err) => {
      console.error('[reorder queue] failed', err);
      toast.error('Could not reorder queue');
    });
  };

  return (
    <div
      className="flex flex-col gap-1.5 mb-2 animate-in fade-in slide-in-from-bottom-1 duration-150"
      data-testid="queue-pills"
    >
      <div className="flex items-center justify-between px-0.5">
        <span className="text-2xs uppercase tracking-wider text-muted-foreground font-semibold">
          Queue ({items.length})
        </span>
        {items.length > 1 && (
          <button
            type="button"
            onClick={clearAll}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition"
            title="Clear all queued messages" aria-label="Clear all queued messages"
          >
            <Trash2 className="size-3" />
            Clear all
          </button>
        )}
      </div>
      {/* The rows are the repo's own hairline-separated list row — the Runs
        * and History idiom (`<ul className="divide-y divide-border/60">` with
        * borderless rows that fill lighter on hover). There is no reference
        * surface for a queue, so there is nothing to match, and three bordered
        * tinted cards is not what this app does with a list anywhere else. */}
      <div className="divide-y divide-border/60">
      {items.map((q, i) => {
        // A subagent receipt addressed to the model is neither a warning nor
        // something the user should edit — render it as what it is.
        const receipt = parseSubagentReceipt(q.text);
        return (
        <div
          key={q.id}
          className="flex items-center gap-2 px-2 py-1.5 text-2xs transition-colors hover:bg-muted/40"
        >
          <span
            className={cn(
              'font-semibold uppercase tracking-wider shrink-0',
              /* The kind is named in words, so the row needs no tint to say
               * it. Only "Direction" keeps a colour — it is a live
               * instruction that applies at the next step, not a thing
               * waiting. A queued message is not a warning, and saying so in
               * amber made the strip look like an error. */
              q.kind === 'steer' ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            {q.kind === 'steer' ? 'Direction' : receipt ? 'Receipt' : 'Queued'}
            {items.length > 1 ? ` (${i + 1}/${items.length})` : ''}
          </span>
          {editingId === q.id ? (
            <div className="flex flex-1 min-w-0 items-center gap-1">
              <input
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveEdit(q.id);
                  }
                  if (e.key === 'Escape') setEditingId(null);
                }}
                className="flex-1 min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-2xs outline-none focus:ring-1 focus:ring-primary"
                autoFocus
              />
              <button
                type="button"
                onClick={() => saveEdit(q.id)}
                className="p-0.5 rounded text-success hover:bg-success/15"
                title="Save"
              >
                <Check className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => setEditingId(null)}
                className="p-0.5 rounded text-muted-foreground hover:bg-muted"
                title="Cancel edit"
              >
                <X className="size-3" />
              </button>
            </div>
          ) : (
            <>
              <span
                className="truncate text-muted-foreground flex-1 min-w-0"
                // The receipt line is the status and the goal; the reason (for a
                // failure) or the result lives in `body`, which nothing else
                // reads — without this a failed subagent reports "failed" and the
                // cause is unrecoverable in the UI.
                title={receipt ? receipt.body || undefined : q.text}
              >
                {receipt
                  ? [describeSubagentReceipt(receipt), receipt.goal && `— ${receipt.goal}`].filter(Boolean).join(' ')
                  : q.text.length > 120 ? q.text.slice(0, 120).trim() + '…' : q.text}
              </span>
              {!receipt ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`More options for queued message ${i + 1}`}>
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem disabled={i === 0} onSelect={() => moveQueuedMessage(q.id, -1)}>Move earlier</DropdownMenuItem>
                    <DropdownMenuItem disabled={i === items.length - 1} onSelect={() => moveQueuedMessage(q.id, 1)}>Move later</DropdownMenuItem>
                    {q.kind !== 'steer' ? <DropdownMenuItem onSelect={() => promoteToSteer(q)}>Promote to direction</DropdownMenuItem> : null}
                    <DropdownMenuItem onSelect={() => startEdit(q)}>Edit message</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <button
                type="button"
                onClick={() => cancelOne(q.id)}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition shrink-0"
                title="Cancel queued message"
                aria-label="Cancel queued message"
              >
                <X className="size-3" />
              </button>
            </>
          )}
        </div>
        );
      })}
      </div>
    </div>
  );
}

export default QueuePills;
