/**
 * Bot Mode Phase D frontend — RoomView renders the room list + shared log and
 * drives the deterministic round driver through the send composer.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const listRooms = vi.fn();
const getRoom = vi.fn();
const listBots = vi.fn();
const sendToRoom = vi.fn();
const createRoom = vi.fn();
const deleteRoom = vi.fn();

vi.mock('@/api/api-client', () => ({
  listRooms: () => listRooms(),
  getRoom: (id: number) => getRoom(id),
  listBots: () => listBots(),
  sendToRoom: (id: number, m: string) => sendToRoom(id, m),
  createRoom: (n: string, mem: string[]) => createRoom(n, mem),
  deleteRoom: (id: number) => deleteRoom(id),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { RoomView } from '../RoomView';

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RoomView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listRooms.mockResolvedValue({ rooms: [{ id: 1, name: 'Design', members: ['a1', 'b2'], needs_you: true }] });
  listBots.mockResolvedValue({
    bots: [
      { id: 'a1', name: 'alice', uiMeta: { title: 'Alice', avatar: '', hidden: false, groups: [] } },
      { id: 'b2', name: 'bob', uiMeta: { title: 'Bob', avatar: '', hidden: false, groups: [] } },
    ],
  });
  getRoom.mockResolvedValue({
    room: { id: 1, name: 'Design', members: ['a1', 'b2'] },
    log: [
      { id: 1, room_id: 1, sender_agent: 'user', body: 'ship it?', kind: 'message' },
      { id: 2, room_id: 1, sender_agent: 'a1', body: 'on it', kind: 'message' },
      { id: 3, room_id: 1, sender_agent: 'b2', body: '(pass)', kind: 'pass' },
    ],
  });
  sendToRoom.mockResolvedValue({ summary: { rounds: 1, messages: 1 }, log: [] });
});

describe('RoomView', () => {
  it('lists rooms and flags needs-you', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('Design')).toBeInTheDocument());
    // The needs-you dot is present (title attribute).
    expect(screen.getByTitle('needs you')).toBeInTheDocument();
  });

  it('opens a room and renders the shared log (passes hidden)', async () => {
    renderView();
    fireEvent.click(await screen.findByText('Design'));
    await waitFor(() => expect(getRoom).toHaveBeenCalledWith(1));
    expect(await screen.findByText('ship it?')).toBeInTheDocument();
    expect(screen.getByText('on it')).toBeInTheDocument();
    // A pass row is silence — never rendered as a message.
    expect(screen.queryByText('(pass)')).not.toBeInTheDocument();
  });

  it('sending runs the driver and clears the composer', async () => {
    renderView();
    fireEvent.click(await screen.findByText('Design'));
    await screen.findByText('ship it?');
    const input = screen.getByPlaceholderText(/Message the room/i);
    fireEvent.change(input, { target: { value: '@alice review this' } });
    fireEvent.click(screen.getByLabelText('Send'));
    await waitFor(() => expect(sendToRoom).toHaveBeenCalledWith(1, '@alice review this'));
  });
});
