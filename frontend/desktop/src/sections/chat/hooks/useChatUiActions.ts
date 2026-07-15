/* ── useChatUiActions ─────────────────────────────────────────────────── */
/* Command-palette / ui-action handlers: guard mode, undo, compact, branch, */
/* restore latest checkpoint.                                               */

import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import {
  createSession,
  updateSessionWorkbenchMetadata,
  type Session,
} from '@/store/sessions';
import {
  setWorkbenchGuardMode,
  undoWorkbenchLastTurn,
  compactWorkbenchSession,
  branchWorkbenchSession,
  listWorkbenchCheckpoints,
  restoreWorkbenchCheckpoint,
} from '@/api/workbench';
import type { WorkbenchSession } from '@/types/workbench';
import {
  WORKBENCH_GUARD_MODES,
  type WorkbenchGuardMode,
} from '@/components/chat/WorkbenchModeSelector';
import { onUiAction } from '@/api/ui-events';
import type { ChatMessage } from '@/types/chat';
import { persistMessages } from '../message-storage';

export interface UseChatUiActionsOptions {
  sessionId: string | null;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  streaming: boolean;
  workbenchSession: WorkbenchSession | null;
  setWorkbenchSession: Dispatch<SetStateAction<WorkbenchSession | null>>;
  setWorkbenchMode: Dispatch<SetStateAction<WorkbenchGuardMode>>;
  activeSession: Session | null;
}

/**
 * Subscribes to shell ui-actions for the active chat (mode, undo, compact,
 * branch, restore checkpoint).
 */
export function useChatUiActions(opts: UseChatUiActionsOptions): void {
  const {
    sessionId,
    messages,
    setMessages,
    streaming,
    workbenchSession,
    setWorkbenchSession,
    setWorkbenchMode,
    activeSession,
  } = opts;

  useEffect(() => {
    const resolveWbId = () =>
      workbenchSession?.id ||
      activeSession?.workbenchSessionId ||
      (sessionId?.startsWith('wb_') ? sessionId : null);

    const unsub = onUiAction((e) => {
      if (e.action === 'set_guard_mode') {
        const mode = e.target as WorkbenchGuardMode;
        if (!WORKBENCH_GUARD_MODES[mode]) return;
        setWorkbenchMode(mode);
        localStorage.setItem('august_last_workbench_guard_mode', mode);
        const wbId = resolveWbId();
        if (mode === 'full' && workbenchSession) {
          setWorkbenchSession({
            ...workbenchSession,
            plan: null,
            approved: false,
            approvedAt: null,
            guardMode: 'full',
            agentId: 'build',
          });
        }
        if (wbId) {
          void setWorkbenchGuardMode(wbId, mode)
            .then((updated) => {
              if (updated) setWorkbenchSession(updated as typeof workbenchSession);
              toast.success(`Mode: ${WORKBENCH_GUARD_MODES[mode].label}`);
            })
            .catch((err: unknown) => {
              toast.error(
                `Could not set mode: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }
        return;
      }

      if (e.action === 'undo_last_turn') {
        if (streaming) {
          toast.message('Stop August first, then undo.');
          return;
        }
        const lastUserIdx = [...messages].map((m) => m.role).lastIndexOf('user');
        if (lastUserIdx < 0) {
          toast.message('Nothing to undo yet.');
          return;
        }
        const wbId = resolveWbId();
        const next = messages.slice(0, lastUserIdx);
        setMessages(next);
        persistMessages(sessionId, next);
        if (wbId) {
          void undoWorkbenchLastTurn(wbId)
            .then((res) => {
              if (res.session) setWorkbenchSession(res.session as typeof workbenchSession);
              toast.success(res.message || 'Undid last turn');
            })
            .catch((err: unknown) => {
              toast.error(
                `Undo failed on server (local chat was updated): ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
        } else {
          toast.success('Undid last turn');
        }
        return;
      }

      if (e.action === 'compact_now') {
        const wbId = resolveWbId();
        if (!wbId) {
          toast.message('Start a chat first, then free up memory.');
          return;
        }
        void compactWorkbenchSession(wbId)
          .then((res) => {
            if (res.session) setWorkbenchSession(res.session as typeof workbenchSession);
            toast.success(res.message || 'Chat memory updated');
          })
          .catch((err: unknown) => {
            toast.error(
              `Could not free memory: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        return;
      }

      if (e.action === 'branch_session') {
        const wbId = resolveWbId();
        if (!wbId) {
          toast.message('Start a chat first, then branch it.');
          return;
        }
        void branchWorkbenchSession(wbId)
          .then((branched) => {
            const ui = createSession(
              null,
              branched.title || 'Chat (branch)',
              activeSession?.workspacePath || null,
            );
            updateSessionWorkbenchMetadata(ui.id, {
              workbenchSessionId: branched.id,
              workbenchAgentId: branched.agentId,
              workbenchProvider: branched.provider,
            });
            persistMessages(ui.id, messages);
            toast.success('Branched chat — opening copy…');
            window.location.href = `/c/${ui.id}`;
          })
          .catch((err: unknown) => {
            toast.error(
              `Could not branch: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        return;
      }

      if (e.action === 'restore_checkpoint') {
        const wbId = resolveWbId();
        if (!wbId) {
          toast.message('Start a chat first.');
          return;
        }
        void (async () => {
          try {
            const list = await listWorkbenchCheckpoints(wbId);
            const latest = list[0];
            if (!latest?.id) {
              toast.message('No save points yet — they appear before file changes.');
              return;
            }
            const res = await restoreWorkbenchCheckpoint(wbId, latest.id);
            toast.success(res.message || 'Save point restored');
          } catch (err: unknown) {
            toast.error(
              `Could not restore: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
      }
    });
    return unsub;
  }, [
    sessionId,
    messages,
    streaming,
    workbenchSession,
    setWorkbenchSession,
    setWorkbenchMode,
    setMessages,
    activeSession?.workbenchSessionId,
    activeSession?.workspacePath,
  ]);
}
