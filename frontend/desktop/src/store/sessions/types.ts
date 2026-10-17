/* Chat sidebar session and folder record shapes. */

export interface Session {
  id: string;
  title: string;
  /** When the chat was CREATED. The sidebar's "Newest first" order and the
   *  History page's date buckets both key off this — never off `updatedAt`,
   *  because "started three days ago, replied to this morning" is a different
   *  fact from "last activity this morning". */
  startedAt: string;
  /** Last activity, from the workbench session SoT (`GET /api/workbench/sessions`).
   *  Absent on local-only drafts that have not synced yet. Drives the sidebar's
   *  active-first ordering — two chats generating at once are ordered by which
   *  one moved most recently — and nothing else. */
  updatedAt?: string;
  messageCount: number;
  lastMessage: string;
  provider: string;
  model: string;
  folderId?: string | null;
  isArchived?: boolean;
  workspacePath?: string | null;
  workbenchSessionId?: string;
  workbenchAgentId?: string;
  workbenchProvider?: string;
}

export type SessionStatus = 'idle' | 'working' | 'awaiting' | 'error' | 'done' | 'streaming';

export interface Folder {
  id: string;
  name: string;
  isCollapsed?: boolean;
  /** Filesystem path this folder represents (for workspace folders created via
   *  the folder picker). Manual sidebar folders have `null`/`undefined` here and
   *  are never auto-matched to a path. */
  workspacePath?: string | null;
}
