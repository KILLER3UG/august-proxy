/* ── RoomView — Bot Mode Phase D: group rooms with deterministic rounds.
 *
 * A room is 2-6 Bots deliberating over a shared log. The backend driver
 * (app/services/bot_mode/rooms.py) runs ≤3 serial rounds / ≤10 messages per
 * send, chooses speakers by a deterministic mention parse (never an LLM
 * router), and flips a "needs you" badge on two consecutive blocks (G-2).
 * This surface reads/writes that log: pick a room, see the shared transcript
 * with member handles, send a message (which runs the rounds), and create a
 * room from the live roster.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessagesSquare, Plus, Send, Trash2, TriangleAlert } from 'lucide-react';
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

/** One log row: user turns read left-aligned, member turns carry a handle. */
function LogRow({ msg, bots }: { msg: RoomMessage; bots: Array<{ id: string; name: string }> }) {
  const isUser = msg.sender_agent === 'user';
  const kind = msg.kind;
  if (kind === 'pass') return null; // silence is not shown as a message
  return (
    <div className={cn('px-3 py-2 text-sm', isUser ? 'bg-accent/40' : 'bg-transparent')}>
      <div className="mb-0.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {kind === 'escalation' && <TriangleAlert className="h-3 w-3 text-amber-500" />}
        <span>{isUser ? 'You' : `@${handleFor(msg.sender_agent, bots)}`}</span>
        {kind === 'verdict' && <span className="rounded bg-violet-500/15 px-1 text-violet-500">review</span>}
      </div>
      <div className="whitespace-pre-wrap">{msg.body}</div>
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
    mutationFn: (text: string) => sendToRoom(selected as number, text),
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
        {selected == null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select or create a room.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="truncate text-sm font-medium">{logQ.data?.room.name ?? 'Room'}</span>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-500"
                onClick={() => deleteMut.mutate(selected)}
                aria-label="Delete room"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 divide-y divide-border overflow-auto">
              {(logQ.data?.log ?? []).map((m) => (
                <LogRow key={m.id} msg={m} bots={botsLite} />
              ))}
            </div>
            <form
              className="flex items-center gap-2 border-t border-border p-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) sendMut.mutate(draft.trim());
              }}
            >
              <input
                className="flex-1 rounded border border-border bg-transparent px-2 py-1 text-sm"
                placeholder="Message the room… (@handle to direct a member)"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                type="submit"
                className="rounded bg-primary p-2 text-primary-foreground disabled:opacity-50"
                disabled={!draft.trim() || sendMut.isPending}
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

export default RoomView;
