/* ── ArenaView — split-pane overlay for the active arena run ─────────── */
/* Renders every lane's live stream side by side. Picking a winner
 * navigates to that lane's session (full conversation + winning answer)
 * and clears the run; other lanes keep running in the background as
 * ordinary sidebar sessions. */

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileDiff, RotateCcw, Swords, X } from 'lucide-react';
import { DiffView } from '@/components/chat/DiffView';
import { SectionHeader } from '@/components/SectionHeader';
import { cn } from '@/lib/utils';
import {
  useArenaStore,
  clearArenaRun,
  closeArenaArchive,
  type ArenaRunLane,
} from './arena-store';
import { launchArenaRun, type ArenaLaunchOpts } from './launchArenaRun';
import { ArenaPane } from './ArenaPane';
import { stopChatStream, startChatStream } from '../chat-stream-manager';
import {
  $sessionStreamStates,
  getOrInitSessionStreamState,
} from '../stream/session-stream-store';
import { resolveWorkbenchSessionId } from '../stream/session-id-map';
import { getWorkbenchSession, truncateWorkbenchSession, createWorkbenchSession } from '@/api/workbench';
import { api } from '@/api/client';
import { normalizeWorkbenchSession } from '@/lib/workbench-plan';
import {
  WORKBENCH_GUARD_MODES,
  type WorkbenchGuardMode,
} from '@/components/chat/WorkbenchModeSelector';
import type { WorkbenchMode } from '@/types/chat';
import type { EffortLevel } from '../hooks/useChatSend';

interface ArenaHistoryRow {
  sessionId: string;
  taskType: string;
  model: string;
  provider: string;
  won: boolean;
  tokens: number;
  durationMs: number;
  at: string;
  prompt: string;
}

interface ArenaGroup {
  sessionId: string;
  prompt: string;
  taskType: string;
  at: string;
  rows: Array<{ model: string; provider: string; won: boolean }>;
}

export function ArenaView() {
  const run = useArenaStore((s) => s.run);
  const archiveOpen = useArenaStore((s) => s.archiveOpen);
  const navigate = useNavigate();
  const [diffPair, setDiffPair] = useState<[ArenaRunLane, ArenaRunLane] | null>(null);

  // Re-render whenever ANY lane's stream state changes (new tokens, done…),
  // so finished-lane counts and the diff button stay live.
  useSyncExternalStore($sessionStreamStates.subscribe, $sessionStreamStates.get);

  // Lane answers: read from the subscribed store snapshot EVERY render —
  // a useMemo keyed on `run` would freeze the diff button at the mount
  // snapshot (the store re-renders via useSyncExternalStore but the memo
  // deps never change — audit finding: 'Diff answers' was dead).
  const laneAnswers = (() => {
    if (!run) return new Map<string, string>();
    const out = new Map<string, string>();
    for (const lane of run.lanes) {
      const msgs = getOrInitSessionStreamState(lane.uiSessionId).messages ?? [];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      const body = last?.blocks?.find((b) => b.type === 'finalOutput')?.content || last?.content || '';
      if (body.trim()) out.set(lane.uiSessionId, body);
    }
    return out;
  })();

  // Arena archive: recent verdicts (results used to vanish when the overlay
  // closed — the routing_evidence arena rows are the durable record).
  const historyQ = useQuery<{ results: ArenaHistoryRow[] }>({
    queryKey: ['arena-history'],
    queryFn: () => api.get<{ results: ArenaHistoryRow[] }>('/api/brain/routing/arena'),
    refetchInterval: 30_000,
  });

  // Group per verdict (session) so one archive entry = one arena/debate,
  // and replay can re-run all its lanes on the stored prompt.
  const groups = useMemo<ArenaGroup[]>(() => {
    const map = new Map<string, ArenaGroup>();
    for (const h of historyQ.data?.results ?? []) {
      const g = map.get(h.sessionId) ?? {
        sessionId: h.sessionId,
        prompt: h.prompt ?? '',
        taskType: h.taskType,
        at: h.at,
        rows: [],
      };
      g.rows.push({ model: h.model, provider: h.provider, won: h.won });
      map.set(h.sessionId, g);
    }
    return [...map.values()];
  }, [historyQ.data]);

  const replayGroup = async (g: ArenaGroup) => {
    const seen = new Set<string>();
    const targets: ArenaLaunchOpts['targets'] = [];
    for (const r of g.rows) {
      const key = `${r.model}::${r.provider}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ id: r.model, name: r.model, provider: r.provider });
    }
    await launchArenaRun({
      sourceSessionId: g.sessionId,
      prompt: g.prompt,
      targets,
      workbenchMode: 'full',
      effort: 'medium',
      thinkingEnabled: true,
      folderId: null,
      workspacePath: null,
    });
  };

  if (!run && !archiveOpen) {
    // No run and the archive isn't open — the chat area stays clean.
    return null;
  }

  if (!run) {
    // Idle state = the full-screen archive, so past verdicts never
    // disappear. Only rendered while `archiveOpen` is true.
    return (
      <div
        className="fixed inset-0 z-40 flex flex-col bg-background/95 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Arena archive"
        data-testid="arena-archive"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <Swords className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">Arena</h2>
          <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
            Archive — past verdicts
          </span>
          <button
            type="button"
            onClick={closeArenaArchive}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 shrink-0"
            title="Close archive"
            aria-label="Close archive"
            data-testid="arena-archive-close"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
          <SectionHeader
            title="Arena archive"
            subtitle="Past arena / debate verdicts — the routing-evidence loop's training data. Replay re-runs the same lanes on the stored prompt."
          />
          {groups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No arena verdicts recorded yet — run an arena comparison and pick a
              winner; the verdict is recorded here for the routing-evidence loop.
            </p>
          )}
          <div className="space-y-2">
            {groups.map((g) => (
              <div
                key={g.sessionId}
                className="rounded-xl border border-border bg-card/60 px-3 py-2.5 text-xs"
                data-testid={`arena-group-${g.sessionId}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground/70 shrink-0">{g.taskType || 'general'}</span>
                  <span className="text-muted-foreground/50 truncate flex-1 min-w-0" title={g.prompt}>
                    {g.prompt ? `“${g.prompt.slice(0, 80)}${g.prompt.length > 80 ? '…' : ''}”` : 'verdict recorded before prompts were stored'}
                  </span>
                  <span className="text-muted-foreground/50 shrink-0">
                    {new Date(g.at).toLocaleString()}
                  </span>
                  {g.prompt && g.rows.length >= 2 ? (
                    <button
                      type="button"
                      onClick={() => void replayGroup(g)}
                      className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20 shrink-0"
                      title="Re-run these models on the same prompt"
                      data-testid={`arena-replay-${g.sessionId}`}
                    >
                      <RotateCcw className="size-3" />
                      Replay
                    </button>
                  ) : null}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-3">
                  {g.rows.map((r, i) => (
                    <span
                      key={`${r.model}-${i}`}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px]',
                        r.won
                          ? 'bg-emerald-500/15 text-emerald-500'
                          : 'bg-muted/60 text-muted-foreground',
                      )}
                      title={r.won ? 'Won' : 'Lost'}
                    >
                      <span className={cn('inline-block size-1.5 rounded-full', r.won ? 'bg-success' : 'bg-muted-foreground/40')} />
                      {r.model}
                      <span className="text-muted-foreground/60">{r.provider}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const pickWinner = (lane: ArenaRunLane) => {
    // Record the verdict for the routing-evidence loop (surpass #1/#7).
    try {
      const losers = run.lanes
        .filter((l) => l.uiSessionId !== lane.uiSessionId)
        .map((l) => ({ modelId: l.modelId, provider: l.provider }));
      void api
        .post('/api/brain/routing/arena', {
          sessionId: lane.uiSessionId,
          prompt: run.prompt,
          winner: { modelId: lane.modelId, provider: lane.provider },
          losers,
        })
        .catch(() => undefined);
    } catch {
      /* evidence is best-effort */
    }
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
