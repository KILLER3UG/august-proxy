/* ── Composer toolbar ──────────────────────────────────────────────────── */
/* Slim pill controls: + menu, model/effort, voice, send / steer / stop.   */

import { useState, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { Loader2, Mic, Send, ShieldCheck, Square } from 'lucide-react';
import { toast } from 'sonner';
import { updateSessionModel } from '@/store/sessions';
import { setWorkbenchGuardMode, setWorkbenchSandboxMode, setWorkbenchVerifier, setWorkbenchAgentMode, compactWorkbenchSession } from '@/api/workbench';
import type { WorkbenchSession } from '@/types/workbench';
import type { ChatMessage } from '@/types/chat';
import {
  WorkbenchModeSelector,
  type WorkbenchGuardMode,
} from '@/components/chat/WorkbenchModeSelector';
import {
  normalizeSandboxMode,
  type WorkbenchSandboxMode,
} from '@/components/chat/SandboxModeSelector';
import { ProjectRulesBadge } from '@/components/chat/ProjectRulesBadge';
import { ContextRing, type ContextBreakdown } from '../ChatComposer';
import type { ModelItem } from '../model-display';
import type { SessionUsageState } from '../hooks/useChatUsage';
import type { EffortLevel } from '../hooks/useChatSend';
import { ComposerActionsMenu } from './ComposerActionsMenu';
import { ModelEffortMenu } from './ModelEffortMenu';
import { SubagentSpawnModal } from './SubagentSpawnModal';
import { CostCeilingChip } from './CostCeilingChip';
import type { AnchorPos } from './useComposerPopovers';
import { cn } from '@/lib/utils';
import { normalizeHarnessMode, type HarnessAgentMode } from '@/components/chat/HarnessModeChip';
import { GalleryVertical } from 'lucide-react';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';

export function ComposerToolbar({
  sessionId,
  loadedSessionId,
  input,
  attachmentsCount,
  attachmentsReading = false,
  streaming,
  send,
  stop,
  setMessages,
  ensureWorkbenchSession,
  workbenchSession,
  setWorkbenchSession,
  workbenchMode,
  setWorkbenchMode,
  workspacePath,
  pct,
  estTokens,
  maxContext,
  contextBreakdown,
  sessionUsage,
  modelForRequest,
  models,
  visibleModels,
  modelsLoading,
  selectedModel,
  setSelectedModel,
  userSelectedRef,
  onRefreshModels,
  onEditModels,
  effort,
  setEffort,
  thinkingEnabled,
  setThinkingEnabled,
  modelMenuOpenSignal,
  actionsOpen,
  actionsPos,
  actionsTriggerRef,
  onToggleActions,
  onAttach,
  onMention,
  onVoice,
  sendKind = 'send',
  onAskParallel,
  onStartDebate,
}: {
  sessionId: string | null;
  loadedSessionId: string | null;
  input: string;
  attachmentsCount: number;
  /** Disable send while files are still being read. */
  attachmentsReading?: boolean;
  streaming: boolean;
  send: (textOverride?: string) => Promise<void>;
  stop: () => void;
  /** Optional: lets the toolbar append a synthetic handoff-notice card. */
  setMessages?: Dispatch<SetStateAction<ChatMessage[]>>;
  /** Creates the backend workbench session on demand — used by the verifier
   *  toggle, which must work on a fresh chat BEFORE the first send creates
   *  the session (otherwise opt-in verification can never cover turn 1). */
  ensureWorkbenchSession: () => Promise<WorkbenchSession | null>;
  workbenchSession: WorkbenchSession | null;
  setWorkbenchSession: (
    session:
      | WorkbenchSession
      | null
      | ((prev: WorkbenchSession | null) => WorkbenchSession | null),
  ) => void;
  workbenchMode: WorkbenchGuardMode;
  setWorkbenchMode: Dispatch<SetStateAction<WorkbenchGuardMode>>;
  workspacePath?: string | null;
  pct: number;
  estTokens: number;
  maxContext: number;
  contextBreakdown: ContextBreakdown;
  sessionUsage: SessionUsageState;
  modelForRequest: ModelItem | null;
  models: ModelItem[];
  visibleModels: ModelItem[];
  modelsLoading: boolean;
  selectedModel: ModelItem | null;
  setSelectedModel: Dispatch<SetStateAction<ModelItem | null>>;
  userSelectedRef: MutableRefObject<string | null>;
  onRefreshModels: () => void;
  onEditModels: () => void;
  effort: EffortLevel;
  setEffort: Dispatch<SetStateAction<EffortLevel>>;
  thinkingEnabled: boolean;
  setThinkingEnabled: Dispatch<SetStateAction<boolean>>;
  /** Incrementing counter — opens the model menu (command palette). */
  modelMenuOpenSignal?: number;
  actionsOpen: boolean;
  actionsPos: AnchorPos | null;
  actionsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onToggleActions: () => void;
  onAttach: () => void;
  onMention: () => void;
  onVoice: () => void;
  sendKind?: 'steer' | 'continue' | 'dispatch' | 'send';
  onAskParallel?: () => void;
  onStartDebate?: () => void;
}) {
  const [handoffPreparing, setHandoffPreparing] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setSpawnOpen(true);
    window.addEventListener('august:open-spawn', onOpen);
    return () => window.removeEventListener('august:open-spawn', onOpen);
  }, []);

  const canSend =
    !!sessionId &&
    loadedSessionId === sessionId &&
    !!selectedModel &&
    !attachmentsReading &&
    (input.trim().length > 0 || attachmentsCount > 0);

  const handleModeChange = (mode: WorkbenchGuardMode) => {
    setWorkbenchMode(mode);
    localStorage.setItem('august_last_workbench_guard_mode', mode);
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
    if (workbenchSession?.id) {
      void setWorkbenchGuardMode(workbenchSession.id, mode)
        .then((updated) => {
          if (updated) setWorkbenchSession(updated);
        })
        .catch((error) => {
          console.warn('[ChatThread] Failed to persist guard mode:', error);
        });
    }
  };

  const persistHarnessMode = (next: HarnessAgentMode) => {
    const apply = (sid: string) => {
      setWorkbenchSession((prev) => (prev ? { ...prev, agentMode: next } : prev));
      void setWorkbenchAgentMode(sid, next)
        .then((updated) => {
          if (updated) setWorkbenchSession(updated);
        })
        .catch((error) => {
          console.warn('[ChatThread] Failed to persist agent mode:', error);
        });
    };
    if (!workbenchSession?.id) {
      void ensureWorkbenchSession()
        .then((session) => {
          if (session?.id) apply(session.id);
        })
        .catch((error) => {
          console.warn('[ChatThread] Failed to create session for harness mode:', error);
        });
      return;
    }
    apply(workbenchSession.id);
  };

  const sandboxMode = normalizeSandboxMode(workbenchSession?.sandboxMode);
  const handleSandboxChange = (mode: WorkbenchSandboxMode) => {
    localStorage.setItem('august_last_sandbox_mode', mode);
    let network: boolean | undefined;
    try {
      if (mode === 'workspace-write' && localStorage.getItem('august_sandbox_network_default') === '1') {
        network = true;
      }
    } catch {
      /* ignore */
    }
    if (workbenchSession) {
      setWorkbenchSession({
        ...workbenchSession,
        sandboxMode: mode,
        sandboxNetwork: mode === 'danger-full-access' ? true : network ?? workbenchSession.sandboxNetwork,
      });
    }
    if (workbenchSession?.id) {
      void setWorkbenchSandboxMode(workbenchSession.id, mode, network)
        .then((updated) => {
          if (updated) setWorkbenchSession(updated);
        })
        .catch((error) => {
          console.warn('[ChatThread] Failed to persist sandbox mode:', error);
        });
    }
  };

  const verifierEnforced = !!workbenchSession?.verifierEnforced;
  const handleVerifierToggle = () => {
    // No workbench session exists before the first send on a fresh chat —
    // create one on demand so opt-in verification can cover turn 1. The
    // session-ensure helper is the same one startChatStream uses.
    if (!workbenchSession?.id) {
      void ensureWorkbenchSession()
        .then((session) => {
          if (!session?.id) return;
          applyVerifierToggle(session.id);
        })
        .catch((error) => {
          console.warn('[ChatThread] Failed to create workbench session for verifier toggle:', error);
        });
      return;
    }
    applyVerifierToggle(workbenchSession.id);
  };

  const applyVerifierToggle = (sessionId: string) => {
    const next = !verifierEnforced;
    setWorkbenchSession((prev) => (prev ? { ...prev, verifierEnforced: next } : prev));
    void setWorkbenchVerifier(sessionId, next)
      .then((updated) => {
        if (updated) setWorkbenchSession(updated);
        if (next) {
          // First-use explainer — the amber banner + withheld answer is jargon
          // until you have seen it once.
          toast('Verifier ON', {
            description:
              'August will withhold the final answer until a verification check passes. Watch for the amber banner.',
          });
        }
      })
      .catch((error) => {
        console.warn('[ChatThread] Failed to persist verifier enforcement:', error);
        setWorkbenchSession((prev) => (prev ? { ...prev, verifierEnforced: !next } : prev));
      });
  };

  // "Compact now" from the context-ring panel: force context compression and
  // swap in the returned session so the chat + right drawer see the result.
  const [compacting, setCompacting] = useState(false);
  const handleCompact = async () => {
    if (!sessionId || compacting) return;
    setCompacting(true);
    try {
      const res = await compactWorkbenchSession(sessionId);
      if (res.session) setWorkbenchSession(res.session);
      toast.success(res.message || 'Context compacted');
    } catch (error) {
      console.warn('[ChatThread] Failed to compact context:', error);
      toast.error('Could not compact context');
    } finally {
      setCompacting(false);
    }
  };

  return (
    <div className="flex flex-col gap-0">
      <div className="flex items-center justify-between gap-1.5 px-2 pb-1 pt-0">
      <div className="flex items-center gap-1 min-w-0">
        <ComposerActionsMenu
          open={actionsOpen}
          pos={actionsPos}
          triggerRef={actionsTriggerRef}
          onToggle={onToggleActions}
          onAttach={onAttach}
          onMention={onMention}
          onVoice={onVoice}
          onSpawn={() => {
            onToggleActions();
            setSpawnOpen(true);
          }}
          onAskParallel={
            onAskParallel
              ? () => {
                  onToggleActions();
                  onAskParallel();
                }
              : undefined
          }
          onStartDebate={
            onStartDebate
              ? () => {
                  onToggleActions();
                  onStartDebate();
                }
              : undefined
          }
          extras={
            <div className="flex items-center gap-2 px-1.5 flex-wrap pt-0.5">
              {sessionUsage && workbenchSession?.id && (
                <CostCeilingChip
                  sessionId={workbenchSession.id}
                  cost={sessionUsage.totalCost ?? 0}
                  initialCeiling={workbenchSession.costCeiling ?? 0}
                />
              )}
              <ProjectRulesBadge workspacePath={workspacePath} />
            </div>
          }
        />
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {handoffPreparing && (
          <span
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 px-1"
            aria-live="polite"
          >
            <Loader2 className="size-3 animate-spin" />
            Preparing handoff…
          </span>
        )}

        <button
          type="button"
          onClick={onVoice}
          className="h-8 w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition"
          title="Voice input"
          aria-label="Voice input"
        >
          <Mic className="size-3.5" />
        </button>

        {streaming ? (
          <>
            <button
              type="button"
              onClick={() => {
                void send();
              }}
              disabled={!canSend}
              title="Steer mid-run — applies after the current tool step without stopping"
              className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              Steer
            </button>
            <button
              type="button"
              onClick={stop}
              title="Stop"
              aria-label="Stop"
              className="h-8 w-8 rounded-full flex items-center justify-center bg-primary text-primary-foreground hover:bg-primary/90 transition"
            >
              <Square className="size-3 fill-current" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              void send();
            }}
            disabled={!canSend}
            title={
              sendKind === 'steer'
                ? 'Steer this worker on its next round'
                : sendKind === 'continue'
                  ? 'Continue the named workstream'
                  : sendKind === 'dispatch'
                    ? 'Send to the orchestrator (it will spawn workers)'
                    : canSend
                      ? 'Send (Enter)'
                      : !selectedModel
                        ? 'Select a model first — open the model picker above'
                        : !sessionId
                          ? 'Open a chat session first'
                          : 'Type a message to send'
            }
            aria-label={
              sendKind === 'steer'
                ? 'Steer'
                : sendKind === 'continue'
                  ? 'Continue'
                  : sendKind === 'dispatch'
                    ? 'Dispatch'
                    : 'Send'
            }
            className={cn(
              'h-8 rounded-full px-3 text-xs font-medium flex items-center gap-1.5 transition',
              'bg-primary text-primary-foreground hover:bg-primary/90',
              'disabled:opacity-40 disabled:pointer-events-none',
            )}
          >
            <Send className="size-3" />
            {sendKind === 'steer'
              ? 'Steer'
              : sendKind === 'continue'
                ? 'Continue'
                : sendKind === 'dispatch'
                  ? 'Dispatch'
                  : 'Send'}
          </button>
        )}
      </div>
      </div>

      <div
        className="flex items-center gap-1 overflow-x-auto px-2 pb-1.5 pt-0.5 text-[11px] text-muted-foreground scrollbar-none"
        data-testid="composer-island-footer"
      >
        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border", sandboxMode === 'danger-full-access' ? "bg-orange-500/10 text-orange-400 border-orange-500/20" : "bg-muted/40 text-muted-foreground border-border/50") } title={`Tool reach: ${sandboxMode}`}>
          <ShieldCheck className="size-3" />
          {sandboxMode === 'danger-full-access' ? 'Full access' : sandboxMode === 'workspace-write' ? 'Workspace' : 'Read-only'}
        </span>
        <span className="inline-flex items-center gap-1">
          <ContextRing
            pct={pct}
            estTokens={estTokens}
            maxContext={maxContext}
            modelName={modelForRequest?.name}
            size={16}
            breakdown={contextBreakdown}
            serverTokens={sessionUsage}
            promptCache={
              sessionUsage
                ? {
                    hitTokens: sessionUsage.cacheHitTokens ?? 0,
                    missTokens: sessionUsage.cacheMissTokens ?? 0,
                    hitRate: sessionUsage.cacheHitRate,
                  }
                : null
            }
            onCompact={sessionId ? handleCompact : undefined}
            compacting={compacting}
          />
          <span className="text-[10px] tabular-nums text-muted-foreground/60">{pct}%</span>
        </span>
        <WorkbenchModeSelector
          selectedMode={workbenchMode}
          onChange={handleModeChange}
          sandboxMode={sandboxMode}
          onSandboxChange={handleSandboxChange}
          harnessMode={normalizeHarnessMode(workbenchSession?.agentMode)}
          onHarnessChange={persistHarnessMode}
        />
        <button
          type="button"
          onClick={() => addRightDrawerSection('artifacts')}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] leading-none text-muted-foreground/50 hover:bg-muted/40 hover:text-foreground/80 transition"
          title="Artifacts — files, images, links from this chat"
        >
          <GalleryVertical className="size-3 opacity-70" />
        </button>
        <ModelEffortMenu
          models={models}
          visibleModels={visibleModels}
          loading={modelsLoading}
          selected={selectedModel}
          onRefresh={() => {
            void onRefreshModels();
          }}
          onEditModels={onEditModels}
          effort={effort}
          onEffortChange={setEffort}
          thinkingEnabled={thinkingEnabled}
          onThinkingChange={setThinkingEnabled}
          openSignal={modelMenuOpenSignal}
          promptHint={input}
          onSelect={(m) => {
            void (async () => {
              const prev = selectedModel;
              const { getOrInitSessionStreamState } = await import(
                '@/sections/chat/stream/session-stream-store'
              );
              const msgs = sessionId
                ? getOrInitSessionStreamState(sessionId).messages || []
                : [];

              const { switchChatModel } = await import('@/sections/chat/switch-model');
              const result = await switchChatModel({
                sessionId,
                prevModel: prev,
                nextModel: m,
                streaming,
                stopStream: async () => {
                  if (!sessionId) return;
                  const { stopChatStream } = await import(
                    '@/sections/chat/stream/start-stop-stream'
                  );
                  await stopChatStream(sessionId);
                },
                getMessages: () => msgs,
                setMessages: (updater) => setMessages?.(updater),
                onModelApplied: (mm) => {
                  setSelectedModel(mm);
                  userSelectedRef.current = mm.id;
                  try {
                    localStorage.setItem('august_last_model', JSON.stringify(mm));
                  } catch {
                    /* silent */
                  }
                  if (sessionId) updateSessionModel(sessionId, mm.id, mm.provider);
                },
                onHandoffPreparingChange: setHandoffPreparing,
              });
              if (result.interrupted && sessionId) {
                window.dispatchEvent(
                  new CustomEvent('august:model-selected', {
                    detail: { modelId: m.id, provider: m.provider, skipSwitch: true, interrupted: true },
                  }),
                );
              }
            })();
          }}
        />
        <button
          type="button"
          onClick={handleVerifierToggle}
          disabled={!sessionId}
          aria-pressed={verifierEnforced}
          aria-label="Enforce verification before final answer"
          title={
            verifierEnforced
              ? 'Verifier ON: final answer withheld until update_state(phase="complete") passes'
              : 'Verifier OFF: allow answers without a passing verification run'
          }
          data-testid="verifier-toggle"
          className={cn(
            'ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 transition disabled:opacity-40',
            verifierEnforced
              ? 'text-amber-400 hover:bg-white/[0.06]'
              : 'text-muted-foreground/70 hover:bg-white/[0.06] hover:text-foreground',
          )}
        >
          <ShieldCheck className="size-3.5" />
          <span className={cn('text-[9px] font-bold uppercase tracking-wide', verifierEnforced ? '' : 'opacity-60')}>
            {verifierEnforced ? 'Verify · On' : 'Verify'}
          </span>
        </button>
      </div>
      <div className="flex items-center gap-2 mx-1 mt-2 rounded-lg bg-white/[0.04] border border-white/[0.06] px-2.5 py-1.5 text-[11px]">
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('august:open-folder'))} className="inline-flex items-center gap-1.5 text-foreground/80 hover:text-foreground">
          <span className="size-3 rounded-sm border border-border/60 bg-card grid place-items-center text-[9px]">▭</span>
          {workspacePath ? workspacePath.split(/[\\/]/).pop() || 'Choose project' : 'Choose project'}
        </button>
        <span className="text-white/10">·</span>
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('august:ui-action', { detail: { action: 'navigate', target: '/settings/tools' } }))} className="inline-flex items-center gap-1 text-foreground/70 hover:text-foreground">
          <span className="size-3 rounded-sm bg-sky-500/20 grid place-items-center text-[8px]">⬢</span> Plugins
        </button>
        <span className="ml-auto text-muted-foreground/30 text-[10px]">{selectedModel ? selectedModel.name?.split(' ').slice(0,2).join(' ') : ''}</span>
      </div>
      <SubagentSpawnModal
        sessionId={workbenchSession?.id}
        open={spawnOpen}
        onClose={() => setSpawnOpen(false)}
        models={visibleModels}
      />
    </div>
  );
}

