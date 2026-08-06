/* ── ArenaView — split-pane overlay for the active arena run ─────────── */
/* Renders every lane's live stream side by side. Picking a winner
 * navigates to that lane's session (full conversation + winning answer)
 * and clears the run; other lanes keep running in the background as
 * ordinary sidebar sessions. */

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileDiff, Swords, X } from 'lucide-react';
import { DiffView } from '@/components/chat/DiffView';
import {
  useArenaStore,
  clearArenaRun,
  type ArenaRunLane,
} from './arena-store';
import { ArenaPane } from './ArenaPane';
import { stopChatStream, startChatStream } from '../chat-stream-manager';
import {
  $sessionStreamStates,
  getOrInitSessionStreamState,
} from '../stream/session-stream-store';
import { resolveWorkbenchSessionId } from '../stream/session-id-map';
import { getWorkbenchSession, truncateWorkbenchSession, createWorkbenchSession } from '@/api/workbench';
import { normalizeWorkbenchSession } from '@/lib/workbench-plan';
import {
  WORKBENCH_GUARD_MODES,
  type WorkbenchGuardMode,
} from '@/components/chat/WorkbenchModeSelector';
import type { WorkbenchMode } from '@/types/chat';
import type { EffortLevel } from '../hooks/useChatSend';

export function ArenaView() {
  const run = useArenaStore((s) => s.run);
  const navigate = useNavigate();
  const [diffPair, setDiffPair] = useState<[ArenaRunLane, ArenaRunLane] | null>(null);

  // Re-render whenever ANY lane's stream state changes (new tokens, done…),
  // so finished-lane counts and the diff button stay live.
  useSyncExternalStore($sessionStreamStates.subscribe, $sessionStreamStates.get);

  const laneAnswers = useMemo(() => {
    if (!run) return new Map<string, string>();
    const out = new Map<string, string>();
    for (const lane of run.lanes) {
      const msgs = getOrInitSessionStreamState(lane.uiSessionId).messages ?? [];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      const body = last?.blocks?.find((b) => b.type === 'finalOutput')?.content || last?.content || '';
      if (body.trim()) out.set(lane.uiSessionId, body);
    }
    return out;
  }, [run]);

  if (!run) return null;

  const pickWinner = (lane: ArenaRunLane) => {
    clearArenaRun();
    navigate(`/c/${lane.uiSessionId}`);
  };

  const stopLane = (lane: ArenaRunLane) => {
    void stopChatStream(lane.uiSessionId);
  };

  const restartLane = async (lane: ArenaRunLane) => {
    // Truncate the lane back to before the prompt, then re-send it as a
    // fresh turn with the lane's model and the run's original settings.
    const msgs = getOrInitSessionStreamState(lane.uiSessionId).messages ?? [];
    const firstUserIdx = msgs.findIndex((m) => m.role === 'user');
    const base = firstUserIdx >= 0 ? msgs.slice(0, firstUserIdx) : msgs;
    const userMsg = {
      id: `m${Date.now()}_r`,
      role: 'user' as const,
      content: run.prompt,
      timestamp: new Date().toISOString(),
    };
    const chatHistory = [...base, userMsg];
    const wbId = resolveWorkbenchSessionId(lane.uiSessionId);
    if (firstUserIdx >= 0) {
      void truncateWorkbenchSession(wbId, firstUserIdx).catch(() => undefined);
    }
    let session = null;
    try {
      const loaded = await getWorkbenchSession(wbId);
      session = normalizeWorkbenchSession(loaded) ?? loaded;
    } catch {
      session = null;
    }
    if (!session) {
      // Session vanished (backend restart) — recreate one for the lane.
      session = await createWorkbenchSession({
        provider: lane.provider,
        agentId: WORKBENCH_GUARD_MODES[(run.workbenchMode as WorkbenchGuardMode) || 'full'].agentId,
        guardMode: (run.workbenchMode as WorkbenchGuardMode) || 'full',
      });
    }
    const mode = (run.workbenchMode as WorkbenchMode) || 'full';
    void startChatStream(lane.uiSessionId, {
      message: run.prompt,
      chatHistory,
      workbenchMode: mode,
      effort: (run.effort as EffortLevel) || 'medium',
      thinkingEnabled: run.thinkingEnabled ?? true,
      model: lane.modelId,
      modelProvider: lane.provider,
      provider: lane.provider,
      ensureWorkbenchSession: async () => session,
    }).then((r) => {
      if (r === 'error') {
        console.warn('[ArenaView] restart lane failed', lane.modelId, r);
      }
    });
  };

  const finishedLanes = run.lanes.filter((l) => laneAnswers.has(l.uiSessionId));

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-background/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Arena comparison"
      data-testid="arena-view"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Swords className="size-4 text-primary" />
        <h2 className="text-sm font-semibold">Arena</h2>
        <p className="text-xs text-muted-foreground truncate flex-1 min-w-0">
          “{run.prompt}” — {run.lanes.length} models answering in parallel
        </p>
        {finishedLanes.length >= 2 ? (
          <button
            type="button"
            onClick={() => {
              const a = finishedLanes[0];
              const b = finishedLanes[1];
              setDiffPair(a && b ? [a, b] : null);
            }}
            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20 shrink-0"
            title="Line-diff the two oldest finished answers"
            data-testid="arena-diff-open"
          >
            <FileDiff className="size-3.5" />
            Diff answers
          </button>
        ) : null}
        <span className="text-[10px] text-muted-foreground/70 shrink-0">
          other lanes keep running after you pick
        </span>
        <button
          type="button"
          onClick={clearArenaRun}
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 shrink-0"
          title="Exit arena (lanes stay in the sidebar)"
          aria-label="Exit arena"
          data-testid="arena-exit"
        >
          <X className="size-4" />
        </button>
      </div>

      <div
        className={[
          'flex-1 min-h-0 p-4 grid gap-4 overflow-y-auto',
          run.lanes.length <= 2 ? 'md:grid-cols-2' : 'md:grid-cols-3',
        ].join(' ')}
      >
        {run.lanes.map((lane) => (
          <ArenaPane
            key={lane.uiSessionId}
            lane={lane}
            onPickWinner={pickWinner}
            onStop={stopLane}
            onRestart={restartLane}
          />
        ))}
      </div>

      {diffPair ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Answer diff"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDiffPair(null);
          }}
          data-testid="arena-diff-modal"
        >
          <div className="w-full max-w-4xl max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-popover p-4 shadow-xl space-y-3">
            <div className="flex items-center gap-2">
              <FileDiff className="size-4 text-primary" />
              <h3 className="font-medium text-sm">Answer diff</h3>
              <span className="text-[10px] text-muted-foreground/70 ml-auto">
                {diffPair[0].modelName} → {diffPair[1].modelName}
              </span>
              <button
                type="button"
                onClick={() => setDiffPair(null)}
                className="p-1 text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <DiffView
              oldContent={laneAnswers.get(diffPair[0].uiSessionId) ?? ''}
              newContent={laneAnswers.get(diffPair[1].uiSessionId) ?? ''}
              maxLines={200}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
