/* ── QueuePills ───────────────────────────────────────────────────────── */
/* Mid-response queue: drag reorder, edit pill text, cancel, clear-all.   */

import { useState } from 'react';
import { GripVertical, Pencil, Trash2, X, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { workbenchClient } from '@/api/workbench';
import {
  setQueuedMessages,
  reorderQueuedMessagesLocal,
  updateQueuedMessageLocal,
  type QueuedUserMessage,
} from './queue-store';

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
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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

  const onDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    const ids = items.map((e) => e.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, dragId);
    reorderQueuedMessagesLocal(sessionId, next);
    void workbenchClient.reorderQueue(wbId, next).catch((err) => {
      console.error('[reorder queue] failed', err);
      toast.error('Could not reorder queue');
    });
    setDragId(null);
    setDragOverId(null);
  };

  return (
    <div
      className="flex flex-col gap-1.5 mb-2 animate-in fade-in slide-in-from-bottom-1 duration-150"
      data-testid="queue-pills"
    >
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Queue ({items.length})
        </span>
        {items.length > 1 && (
          <button
            type="button"
            onClick={clearAll}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition"
            title="Clear all queued messages"
          >
            <Trash2 className="size-3" />
            Clear all
          </button>
        )}
      </div>
      {items.map((q, i) => (
        <div
          key={q.id}
          draggable={editingId !== q.id}
          onDragStart={() => setDragId(q.id)}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverId(q.id);
          }}
          onDragEnd={() => {
            setDragId(null);
            setDragOverId(null);
          }}
          onDrop={() => onDrop(q.id)}
          className={cn(
            'flex items-center gap-2 px-2 py-1.5 rounded-xl border text-[11px] transition',
            q.kind === 'steer'
              ? 'border-primary/35 bg-primary/10'
              : 'border-warning/30 bg-warning/5',
            dragOverId === q.id && dragId !== q.id && 'ring-1 ring-primary/50',
            dragId === q.id && 'opacity-60',
          )}
        >
          <span
            className="cursor-grab active:cursor-grabbing text-muted-foreground shrink-0"
            title="Drag to reorder"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-3.5" />
          </span>
          <span
            className={cn(
              'font-semibold uppercase tracking-wider shrink-0',
              q.kind === 'steer' ? 'text-primary' : 'text-warning',
            )}
          >
            {q.kind === 'steer' ? 'Direction' : 'Queued'}
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
                className="flex-1 min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-primary"
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
              <span className="truncate text-muted-foreground flex-1 min-w-0" title={q.text}>
                {q.text.length > 120 ? q.text.slice(0, 120).trim() + '…' : q.text}
              </span>
              <button
                type="button"
                onClick={() => startEdit(q)}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition shrink-0"
                title="Edit message"
                aria-label="Edit queued message"
              >
                <Pencil className="size-3" />
              </button>
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
      ))}
    </div>
  );
}

export default QueuePills;
