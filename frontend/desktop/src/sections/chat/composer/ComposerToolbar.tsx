/* ── Composer toolbar ──────────────────────────────────────────────────── */
/* Slim pill controls: + menu, model/effort, voice, send / steer / stop.   */

import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { Loader2, Mic, Send, ShieldCheck, Square } from 'lucide-react';
import { toast } from 'sonner';
import { updateSessionModel } from '@/store/sessions';
import { setWorkbenchGuardMode, setWorkbenchSandboxMode, setWorkbenchVerifier } from '@/api/workbench';
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
import { ContextUsedBadge } from './ContextUsedBadge';
import type { ModelItem } from '../model-display';
import type { SessionUsageState } from '../hooks/useChatUsage';
import type { EffortLevel } from '../hooks/useChatSend';
import { ComposerActionsMenu } from './ComposerActionsMenu';
import { ModelEffortMenu } from './ModelEffortMenu';
import { SubagentSpawnModal } from './SubagentSpawnModal';
import { CostCeilingChip } from './CostCeilingChip';
import type { AnchorPos } from './useComposerPopovers';
import { cn } from '@/lib/utils';

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
}) {
  const [handoffPreparing, setHandoffPreparing] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);

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
    if (!workbenchSession?.id) return;
    const next = !verifierEnforced;
    setWorkbenchSession((prev) => (prev ? { ...prev, verifierEnforced: next } : prev));
    void setWorkbenchVerifier(workbenchSession.id, next)
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

  return (
    <div className="flex items-center justify-between gap-1.5 px-2 pb-2 pt-0.5">
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
        <WorkbenchModeSelector
          selectedMode={workbenchMode}
          onChange={handleModeChange}
          sandboxMode={sandboxMode}
          onSandboxChange={handleSandboxChange}
        />
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* Context gauge beside the model dropdown — always visible, like
            Claude/Codex; hover for the full breakdown. */}
        <ContextRing
          pct={pct}
          estTokens={estTokens}
          maxContext={maxContext}
          modelName={modelForRequest?.name}
          size={20}
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
        />
        <ContextUsedBadge sessionId={sessionId} />
        <button
          type="button"
          onClick={handleVerifierToggle}
          disabled={!workbenchSession?.id}
          aria-pressed={verifierEnforced}
          aria-label="Enforce verification before final answer"
          title={
            verifierEnforced
              ? 'Verifier ON: final answer withheld until update_state(phase="complete") passes'
              : 'Verifier OFF: allow answers without a passing verification run'
          }
          data-testid="verifier-toggle"
          className={cn(
            'flex items-center gap-1 rounded px-1.5 transition disabled:opacity-40',
            verifierEnforced
              ? 'text-amber-400 hover:bg-white/[0.06]'
              : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground',
          )}
        >
          <ShieldCheck className="size-3.5" />
          <span className={cn('text-[9px] font-bold uppercase tracking-wide', verifierEnforced ? '' : 'opacity-60')}>
            {verifierEnforced ? 'Verify · On' : 'Verify'}
          </span>
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

              // Shared stop → handoff → apply flow (single source of truth
              // with the chat-thread model-selected event handler).
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
              // Auto-continue the interrupted turn with the new model: the
              // chat-thread event handler owns the truncate+regenerate logic,
              // so re-dispatch with skipSwitch (audit finding: the composer
              // path previously dropped the interrupted turn entirely).
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
              className={cn(
                'h-8 px-2.5 rounded-full text-xs font-medium flex items-center gap-1 transition',
                'bg-secondary text-secondary-foreground hover:bg-secondary/80',
                'disabled:opacity-40 disabled:pointer-events-none',
              )}
            >
              <Send className="size-3" />
              Steer
            </button>
            <button
              type="button"
              onClick={stop}
              title="Stop"
              aria-label="Stop"
              className="h-8 w-8 rounded-full flex items-center justify-center bg-muted hover:bg-muted/80 text-foreground border border-border/40 transition"
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
              canSend
                ? 'Send (Enter)'
                : !selectedModel
                  ? 'Select a model first — open the model picker above'
                  : !sessionId
                    ? 'Open a chat session first'
                    : 'Type a message to send'
            }
            aria-label="Send"
            className={cn(
              'h-8 w-8 rounded-full flex items-center justify-center transition',
              canSend
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground opacity-50',
            )}
          >
            <Send className="size-3.5" />
          </button>
        )}
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
