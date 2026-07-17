/* ── Composer toolbar ──────────────────────────────────────────────────── */
/* Slim pill controls: + menu, model/effort, voice, send / steer / stop.   */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { Mic, Send, Square } from 'lucide-react';
import { updateSessionModel } from '@/store/sessions';
import { setWorkbenchGuardMode, setWorkbenchSandboxMode } from '@/api/workbench';
import type { WorkbenchSession } from '@/types/workbench';
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
  actionsOpen: boolean;
  actionsPos: AnchorPos | null;
  actionsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onToggleActions: () => void;
  onAttach: () => void;
  onMention: () => void;
  onVoice: () => void;
}) {
  const canSend =
    !!sessionId &&
    loadedSessionId === sessionId &&
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
          extras={
            <div className="flex items-center gap-2 px-1.5 flex-wrap pt-0.5">
              <ContextRing
                pct={pct}
                estTokens={estTokens}
                maxContext={maxContext}
                modelName={modelForRequest?.name}
                size={18}
                breakdown={contextBreakdown}
                serverTokens={sessionUsage}
              />
              {sessionUsage && (sessionUsage.totalCost ?? 0) > 0 && (
                <span
                  className="text-[10px] tabular-nums text-muted-foreground font-mono"
                  title="Estimated session cost"
                  data-testid="session-cost-chip"
                >
                  ${sessionUsage.totalCost!.toFixed(4)}
                </span>
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
          onSelect={(m) => {
            setSelectedModel(m);
            userSelectedRef.current = m.id;
            try {
              localStorage.setItem('august_last_model', JSON.stringify(m));
            } catch {
              /* silent */
            }
            if (sessionId) updateSessionModel(sessionId, m.id, m.provider);
          }}
        />

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
            title="Send (Enter)"
            aria-label="Send"
            className={cn(
              'h-8 w-8 rounded-full flex items-center justify-center transition',
              canSend
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground opacity-50 pointer-events-none',
            )}
          >
            <Send className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
