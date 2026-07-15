/* ── Composer toolbar ──────────────────────────────────────────────────── */
/* Mode selector, context ring, model/effort pickers, send / steer / stop. */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { Send, StopCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { updateSessionModel } from '@/store/sessions';
import { setWorkbenchGuardMode } from '@/api/workbench';
import type { WorkbenchSession } from '@/types/workbench';
import {
  WorkbenchModeSelector,
  type WorkbenchGuardMode,
} from '@/components/chat/WorkbenchModeSelector';
import { ProjectRulesBadge } from '@/components/chat/ProjectRulesBadge';
import { ModelDropdown, EffortDropdown } from '../ComposerControls';
import { ContextRing, type ContextBreakdown } from '../ChatComposer';
import type { ModelItem } from '../model-display';
import type { SessionUsageState } from '../hooks/useChatUsage';
import type { EffortLevel } from '../hooks/useChatSend';
import { ComposerActionsMenu } from './ComposerActionsMenu';
import type { AnchorPos } from './useComposerPopovers';

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

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-1.5 pb-1.5">
      <div className="flex items-center gap-1.5">
        <ComposerActionsMenu
          open={actionsOpen}
          pos={actionsPos}
          triggerRef={actionsTriggerRef}
          onToggle={onToggleActions}
          onAttach={onAttach}
          onMention={onMention}
          onVoice={onVoice}
        />

        <WorkbenchModeSelector
          selectedMode={workbenchMode}
          onChange={(mode) => {
            setWorkbenchMode(mode);
            localStorage.setItem('august_last_workbench_guard_mode', mode);
            // Full Access: clear local plan so approval chrome never blocks the composer.
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
                  if (updated) setWorkbenchSession(updated as typeof workbenchSession);
                })
                .catch((error) => {
                  console.warn('[ChatThread] Failed to persist guard mode:', error);
                });
            }
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <ProjectRulesBadge workspacePath={workspacePath} />
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
        <ModelDropdown
          models={models}
          visibleModels={visibleModels}
          loading={modelsLoading}
          selected={selectedModel}
          onRefresh={() => {
            void onRefreshModels();
          }}
          onEditModels={onEditModels}
          onSelect={(m) => {
            if (!m) return;
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
        <EffortDropdown value={effort} onChange={setEffort} />

        {streaming ? (
          <>
            <Button
              onClick={() => {
                void send();
              }}
              disabled={!canSend}
              size="sm"
              variant="secondary"
              title="Steer mid-run — applies after the current tool step without stopping"
            >
              <Send className="size-3" />
              Add direction
            </Button>
            <Button onClick={stop} size="sm" variant="outline">
              <StopCircle className="size-3" /> Stop
            </Button>
          </>
        ) : (
          <Button
            onClick={() => {
              void send();
            }}
            disabled={!canSend}
            size="sm"
          >
            <Send className="size-3" />
            Send
            <kbd className="ml-1 rounded bg-muted/20 border border-border/20 px-1 text-[10px] font-mono">
              ↵
            </kbd>
          </Button>
        )}
      </div>
    </div>
  );
}
