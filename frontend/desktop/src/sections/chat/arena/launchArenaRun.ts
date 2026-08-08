/* ── launchArenaRun — shared arena launcher ──────────────────────────── */
/* Extracted from ChatThread.launchArena so the arena archive can replay
 * past verdicts with the same branching + streaming + overlay wiring.
 * Forks the source workbench session per target model, seeds each lane's
 * UI session with the prompt, streams every lane, then opens ArenaView. */

import { toast } from 'sonner';
import { branchWorkbenchSession } from '@/api/workbench';
import { createSession, updateSessionWorkbenchMetadata } from '@/store/sessions';
import { resolveWorkbenchSessionId } from '../stream/session-id-map';
import { getOrInitSessionStreamState } from '../stream/session-stream-store';
import { startChatStream } from '../chat-stream-manager';
import { persistMessages } from '../message-storage';
import { normalizeWorkbenchSession } from '@/lib/workbench-plan';
import { setArenaRun, type ArenaRunLane } from './arena-store';
import type { ChatMessage } from '@/types/chat';
import type { WorkbenchMode } from '@/types/chat';
import type { EffortLevel } from '../hooks/useChatSend';

/** A lane target: the full ModelItem from the picker, or a minimal
 *  {id, name, provider} rebuilt from archive rows for replay. */
export interface ArenaTarget {
  id: string;
  name?: string;
  provider: string;
}

export interface ArenaLaunchOpts {
  sourceSessionId: string;
  prompt: string;
  /** At least two targets — arena compares lanes. */
  targets: ArenaTarget[];
  workbenchMode: WorkbenchMode;
  effort: EffortLevel;
  thinkingEnabled: boolean;
  folderId: string | null;
  workspacePath: string | null;
}

export async function launchArenaRun(opts: ArenaLaunchOpts): Promise<void> {
  const { sourceSessionId, prompt, targets, folderId, workspacePath } = opts;
  if (!sourceSessionId || targets.length < 2) return;

  const wbId = resolveWorkbenchSessionId(sourceSessionId);
  const prefix = getOrInitSessionStreamState(sourceSessionId).messages ?? [];
  const lanes: ArenaRunLane[] = [];
  try {
    for (let i = 0; i < targets.length; i++) {
      const m = targets[i];
      const branch = await branchWorkbenchSession(wbId);
      const ui = createSession(folderId, `⚔ ${m.name || m.id}`, workspacePath);
      updateSessionWorkbenchMetadata(ui.id, {
        workbenchSessionId: branch.id,
        workbenchAgentId: branch.agentId,
        workbenchProvider: branch.provider,
      });
      const userMsg: ChatMessage = {
        id: `m${Date.now()}_a${i}`,
        role: 'user',
        content: prompt,
        timestamp: new Date().toISOString(),
      };
      const seeded = [...prefix, userMsg];
      persistMessages(ui.id, seeded);
      lanes.push({
        uiSessionId: ui.id,
        modelId: m.id,
        modelName: m.name || m.id,
        provider: m.provider,
      });
      void startChatStream(ui.id, {
        message: prompt,
        chatHistory: seeded,
        workbenchMode: opts.workbenchMode,
        effort: opts.effort,
        thinkingEnabled: opts.thinkingEnabled,
        model: m.id,
        modelProvider: m.provider,
        provider: m.provider,
        ensureWorkbenchSession: async () => normalizeWorkbenchSession(branch) ?? branch,
      }).then((r) => {
        if (r === 'error') {
          toast.error(`Arena lane on ${m.name || m.id} failed — check the backend`);
        }
      });
    }
    setArenaRun({
      runId: `arena_${Date.now()}`,
      sourceSessionId,
      prompt,
      lanes,
      startedAt: Date.now(),
      workbenchMode: opts.workbenchMode,
      effort: opts.effort,
      thinkingEnabled: opts.thinkingEnabled,
    });
    toast.success(`Arena launched — ${lanes.length} models answering in parallel`);
  } catch (err) {
    toast.error(`Arena launch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
