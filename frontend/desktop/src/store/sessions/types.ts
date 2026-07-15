/* Chat sidebar session and folder record shapes. */

export interface Session {
  id: string;
  title: string;
  startedAt: string;
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
