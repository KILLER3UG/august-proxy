/* ── RoomView — Bot Mode Phase D + Part 27 F3/F4: group rooms with threads.
 *
 * A room is 2-6 Bots deliberating over a shared log. The backend driver
 * (app/services/bot_mode/rooms.py) runs ≤3 serial rounds / ≤10 messages per
 * send, chooses speakers by a deterministic mention parse, and flips a
 * "needs you" badge on two consecutive blocks (G-2). Part 27 F4 adds THREADS:
 * each top-level post roots a thread; replies and the member turns they trigger
 * inherit its thread_id, so a reply stays scoped to its thread. This surface
 * renders the reference layout — member tab strip, an Activity row, collapsible
 * threads with "Reply in thread", and a "New thread" composer.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  MessagesSquare,
  Plus,
  Send,
  Settings2,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  createRoom,
  deleteRoom,
  getRoom,
  listBots,
  listRooms,
  sendToRoom,
  type Room,
  type RoomMessage,
} from '@/api/api-client';

function handleFor(agentId: string, bots: Array<{ id: string; name: string }>): string {
  return bots.find((b) => b.id === agentId)?.name ?? agentId.slice(0, 8);
}

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} sec. ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min. ago`;
  return `${Math.floor(ms / 3_600_000)} hr. ago`;
}

/** One log row inside a thread. */
function ThreadRow({ msg, bots }: { msg: RoomMessage; bots: Array<{ id: string; name: string }> }) {
  const isUser = msg.sender_agent === 'user';
  if (msg.kind === 'pass') return null; // silence is not shown as a message
  return (
    <div className={cn('px-3 py-2 text-sm', isUser ? 'bg-accent/40' : 'bg-transparent')}>
      <div className="mb-0.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {msg.kind === 'escalation' && <TriangleAlert className="h-3 w-3 text-amber-500" />}
        <span>{isUser ? 'You' : `@${handleFor(msg.sender_agent, bots)}`}</span>
        {msg.kind === 'verdict' && (
          <span className="rounded bg-violet-500/15 px-1 text-violet-500">review</span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground/60">{timeAgo(msg.created_at)}</span>
      </div>
      <div className="whitespace-pre-wrap">{msg.body}</div>
    </div>
  );
}

/** A thread = its root message + replies, collapsible. */
function Thread({
  root,
  replies,
  bots,
  onReply,
  replying,
}: {
  root: RoomMessage;
  replies: RoomMessage[];
  bots: Array<{ id: string; name: string }>;
  onReply: (text: string) => void;
  replying: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const submit = () => {
    if (!draft.trim()) return;
    onReply(draft.trim());
    setDraft('');
  };
  return (
    <div className="border-b border-border/40" data-testid={`room-thread-${root.id}`}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-white/[0.02]"
      >
        <ChevronDown className={cn('size-3 transition-transform', collapsed && '-rotate-90')} />
        {collapsed ? 'Expand thread' : 'Collapse thread'}
      </button>
      {!collapsed && (
        <>
          <ThreadRow msg={root} bots={bots} />
          {replies.map((m) => (
            <ThreadRow key={m.id} msg={m} bots={bots} />
          ))}
          <div className="flex items-center gap-2 px-3 pb-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Reply in thread"
              className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-primary/50"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || replying}
              className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
            >
              Reply
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function RoomView() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const roomsQ = useQuery({ queryKey: ['bot-rooms'], queryFn: () => listRooms().then((r) => r.rooms) });
  const botsQ = useQuery({ queryKey: ['bots'], queryFn: () => listBots().then((r) => r.bots) });
  const logQ = useQuery({
    queryKey: ['bot-room', selected],
    queryFn: () => getRoom(selected as number),
    enabled: selected != null,
  });

  const rooms = roomsQ.data ?? [];
  const bots = botsQ.data ?? [];
  const botsLite = useMemo(() => bots.map((b) => ({ id: b.id, name: b.name })), [bots]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['bot-rooms'] });
    if (selected != null) qc.invalidateQueries({ queryKey: ['bot-room', selected] });
  };

  const createMut = useMutation({
    mutationFn: () => createRoom(newName || 'Room', picked),
    onSuccess: (res) => {
      toast.success('Room created');
      setCreating(false);
      setNewName('');
      setPicked([]);
      setSelected(res.roomId);
      invalidate();
    },
    onError: (e: unknown) => toast.error(`Could not create room: ${String(e)}`),
  });

  const sendMut = useMutation({
    mutationFn: ({ text, threadId }: { text: string; threadId?: number }) =>
      sendToRoom(selected as number, text, threadId),
    onSuccess: () => {
      setDraft('');
      invalidate();
    },
    onError: (e: unknown) => toast.error(`Send failed: ${String(e)}`),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => deleteRoom(id),
    onSuccess: () => {
      setSelected(null);
      invalidate();
    },
  });

  // Group the log into threads by thread_id (root = first row of each thread).
  const threads = useMemo(() => {
    const log = logQ.data?.log ?? [];
    const byThread = new Map<number, RoomMessage[]>();
    for (const m of log) {
      const tid = m.thread_id ?? m.id;
      const arr = byThread.get(tid) ?? [];
      arr.push(m);
      byThread.set(tid, arr);
    }
    return Array.from(byThread.entries())
      .map(([tid, msgs]) => {
        const sorted = msgs.sort((a, b) => a.id - b.id);
        return { root: sorted[0], replies: sorted.slice(1), last: sorted[sorted.length - 1] };
      })
      .sort((a, b) => b.last.id - a.last.id); // newest activity first
  }, [logQ.data]);

  const room = logQ.data?.room;
  const memberNames = (room?.members ?? []).map((m) => handleFor(m, bots));
  const lastSpeaker = threads[0]?.last;
  const activityLabel =
    sendMut.isPending && lastSpeaker
      ? `${handleFor(lastSpeaker.sender_agent, bots)} is working…`
      : lastSpeaker
        ? `${handleFor(lastSpeaker.sender_agent, bots)} spoke · ${timeAgo(lastSpeaker.created_at)}`
        : '';

  return (
    <div className="flex h-full" data-testid="room-view">
      {/* Room list */}
      <div className="w-56 shrink-0 border-r border-border p-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase text-muted-foreground">Rooms</span>
          <button
            type="button"
            className="rounded p-1 hover:bg-accent"
            onClick={() => setCreating((v) => !v)}
            aria-label="New room"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {creating && (
          <div className="mb-2 space-y-2 rounded border border-border p-2">
            <input
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm"
              placeholder="Room name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <div className="max-h-28 space-y-1 overflow-auto">
              {bots.map((b) => (
                <label key={b.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.includes(b.id)}
                    onChange={(e) =>
                      setPicked((p) => (e.target.checked ? [...p, b.id] : p.filter((x) => x !== b.id)))
                    }
                  />
                  @{b.name}
                </label>
              ))}
            </div>
            <button
              type="button"
              className="w-full rounded bg-primary px-2 py-1 text-sm text-primary-foreground disabled:opacity-50"
              disabled={picked.length < 2 || createMut.isPending}
              onClick={() => createMut.mutate()}
            >
              Create (2-6 members)
            </button>
          </div>
        )}
        {rooms.length === 0 && !creating && (
          <p className="px-1 text-xs text-muted-foreground">No rooms yet. + to create one.</p>
        )}
        <ul className="space-y-1">
          {rooms.map((r: Room) => (
            <li key={r.id}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-accent',
                  selected === r.id && 'bg-accent',
                )}
                onClick={() => setSelected(r.id)}
              >
                <MessagesSquare className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{r.name}</span>
                {r.needs_you && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-amber-500" title="needs you" />}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Selected room */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected == null || !room ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select or create a room.
          </div>
        ) : (
          <>
            {/* Member tab strip (reference: uppercase names) */}
            <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {memberNames.map((n) => (
                <span key={n} className="rounded px-1.5 py-0.5 hover:bg-white/[0.04]">
                  {n}
                </span>
              ))}
            </div>
            {/* Room header: icon + names + N bots + settings + delete */}
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <MessagesSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {memberNames.join(', ')}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{room.members.length} bots</span>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-accent"
                aria-label="Room settings"
                title="Room settings"
              >
                <Settings2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-500"
                onClick={() => deleteMut.mutate(selected)}
                aria-label="Delete room"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            {/* Activity row */}
            {activityLabel && (
              <div className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-3 py-1 text-[11px] text-muted-foreground">
                <ChevronDown className="size-3" />
                <span className="font-medium">Activity</span>
                <span className="truncate">{activityLabel}</span>
              </div>
            )}
            {/* Threads */}
            <div className="min-h-0 flex-1 overflow-auto">
              {threads.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  Start a thread below — @name to direct a member, @everyone for all.
                </p>
              )}
              {threads.map((t) => (
                <Thread
                  key={t.root.id}
                  root={t.root}
                  replies={t.replies}
                  bots={botsLite}
                  replying={sendMut.isPending}
                  onReply={(text) => sendMut.mutate({ text, threadId: t.root.id })}
                />
              ))}
            </div>
            {/* New-thread composer */}
            <form
              className="flex shrink-0 items-center gap-2 border-t border-border p-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) sendMut.mutate({ text: draft.trim() });
              }}
            >
              <input
                className="flex-1 rounded border border-border bg-transparent px-2 py-1 text-sm"
                placeholder={`New thread in ${room.name}… (@name to direct, @everyone for all)`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                type="submit"
                className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
                disabled={!draft.trim() || sendMut.isPending}
              >
                New Thread
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

export default RoomView;
