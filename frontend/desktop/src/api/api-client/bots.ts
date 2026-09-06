/* Bot Mode roster — /api/agents/bots (Bots are agent-registry records + uiMeta). */

import { api } from '../client';

/** Part 27 F2: the avatar field on uiMeta is the lock-aware face descriptor.
 *  Backwards-compat: a bare string is read as a salt with locked=true. */
export type BotAvatar =
  | string
  | { salt: string; locked: boolean; source: 'shape' | 'shuffle' | 'upload' | 'auto' };

export interface BotUiMeta {
  title: string;
  avatar: BotAvatar;
  hidden: boolean;
  groups: string[];
}

export interface Bot {
  id: string;
  name: string;
  description?: string;
  role?: string;
  model?: string;
  provider?: string;
  createdAt?: string;
  uiMeta: BotUiMeta;
}

export interface BotUiMetaUpdate {
  title?: string;
  avatar?: BotAvatar;
  hidden?: boolean;
  groups?: string[];
}

export interface BotCreateInput {
  name: string;
  title?: string;
  description?: string;
  role?: string;
  model?: string;
  provider?: string;
  cloneFrom?: string;
  /** Part 27 F2: skills the bot can use (the existing Bot skills field). */
  skills?: string[];
  /** Part 27 F2: memory scope — 'global' (default), 'project' (workspacePath), or 'none'. */
  memoryScope?: 'global' | 'project' | 'none';
  /** Optional workspace path when memoryScope === 'project'. */
  workspacePath?: string;
}

export function listBots(): Promise<{ bots: Bot[] }> {
  return api.get<{ bots: Bot[] }>('/api/agents/bots');
}

export function getBot(agentId: string): Promise<Bot> {
  return api.get<Bot>(`/api/agents/bots/${encodeURIComponent(agentId)}`);
}

export function createBot(input: BotCreateInput): Promise<Bot> {
  return api.post<Bot>('/api/agents', input);
}

export function updateBotUiMeta(agentId: string, update: BotUiMetaUpdate): Promise<Bot> {
  return api.put<Bot>(
    `/api/agents/bots/${encodeURIComponent(agentId)}/ui-meta`,
    update,
  );
}

export function deleteBot(agentId: string): Promise<{ status: string; deleted: string }> {
  return api.delete<{ status: string; deleted: string }>(
    `/api/agents/bots/${encodeURIComponent(agentId)}`,
  );
}

export function ensureDefaultBot(): Promise<Bot> {
  return api.post<Bot>('/api/agents/bots/ensure-default', {});
}

/** Resolve (404 when absent) the Bot's canonical chat session id. */
export function getBotChat(agentId: string): Promise<{ sessionId: string; title: string; agentId: string }> {
  return api.get<{ sessionId: string; title: string; agentId: string }>(
    `/api/agents/bots/${encodeURIComponent(agentId)}/chat`,
  );
}

/** Create-if-missing the Bot's canonical chat (idempotent). */
export function ensureBotChat(agentId: string): Promise<{ sessionId: string; title: string; agentId: string }> {
  return api.post<{ sessionId: string; title: string; agentId: string }>(
    `/api/agents/bots/${encodeURIComponent(agentId)}/chat`,
    {},
  );
}

export function getBotAvatar(name: string, salt = ''): Promise<{ svg: string }> {
  return api.get<{ svg: string }>(
    `/api/agents/bots/avatar?name=${encodeURIComponent(name)}&salt=${encodeURIComponent(salt)}`,
  );
}

/* ── Group rooms ─────────────────────────────────────────────── */

export interface Room {
  id: number;
  name: string;
  members: string[];
  needs_you?: boolean;
  created_at?: string;
}

export interface RoomMessage {
  id: number;
  room_id: number;
  sender_agent: string;
  body: string;
  kind: string; // message | pass | review | verdict | escalation
  created_at?: string;
  /** Part 27 F4: the thread root this message belongs to. */
  thread_id?: number;
}

export function listRooms(): Promise<{ rooms: Room[] }> {
  return api.get<{ rooms: Room[] }>('/api/agents/rooms');
}

export function getRoom(id: number): Promise<{ room: Room; log: RoomMessage[] }> {
  return api.get<{ room: Room; log: RoomMessage[] }>(`/api/agents/rooms/${id}`);
}

export function createRoom(name: string, members: string[]): Promise<{ status: string; roomId: number }> {
  return api.post<{ status: string; roomId: number }>('/api/agents/rooms', { name, members });
}

export function sendToRoom(
  id: number,
  message: string,
  threadId?: number,
  caps?: { maxRounds?: number; maxMessages?: number },
): Promise<{ summary: Record<string, unknown>; log: RoomMessage[] }> {
  return api.post<{ summary: Record<string, unknown>; log: RoomMessage[] }>(
    `/api/agents/rooms/${id}/send`,
    {
      message,
      thread_id: threadId ?? null,
      ...(caps?.maxRounds != null ? { max_rounds: caps.maxRounds } : {}),
      ...(caps?.maxMessages != null ? { max_messages: caps.maxMessages } : {}),
    },
  );
}

export function deleteRoom(id: number): Promise<{ status: string; deleted: number }> {
  return api.delete<{ status: string; deleted: number }>(`/api/agents/rooms/${id}`);
}

export function updateRoom(
  id: number,
  updates: { name?: string; members?: string[] },
): Promise<{ status: string; room: Room }> {
  return api.patch<{ status: string; room: Room }>(`/api/agents/rooms/${id}`, updates);
}
