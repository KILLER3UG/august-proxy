/* Bot Mode roster — /api/agents/bots (Bots are agent-registry records + uiMeta). */

import { api } from '../client';

export interface BotUiMeta {
  title: string;
  avatar: string;
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
  avatar?: string;
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

/* ── Group rooms (Phase D) ─────────────────────────────────────────────── */

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
): Promise<{ summary: Record<string, unknown>; log: RoomMessage[] }> {
  return api.post<{ summary: Record<string, unknown>; log: RoomMessage[] }>(
    `/api/agents/rooms/${id}/send`,
    { message },
  );
}

export function deleteRoom(id: number): Promise<{ status: string; deleted: number }> {
  return api.delete<{ status: string; deleted: number }>(`/api/agents/rooms/${id}`);
}
