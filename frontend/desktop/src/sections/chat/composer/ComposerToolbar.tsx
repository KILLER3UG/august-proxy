/* ── Composer toolbar ──────────────────────────────────────────────────── */
/* Slim pill controls: + menu, voice, send / steer / stop.               */
 /* The model + effort control is gone from this toolbar and from the composer
  * below the card; the prop list shrank with it. `selectedModel` and
  * `visibleModels` stay because the send gate and the subagent modal still
  * need them. */

import { useState, useEffect, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { setWorkbenchGuardMode, setWorkbenchSandboxMode, setWorkbenchAgentMode } from '@/api/workbench';
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
import type { ModelItem } from '../model-display';
import type { SessionUsageState } from '../hooks/useChatUsage';
import { ComposerActionsMenu } from './ComposerActionsMenu';
import { CameraPopover } from './CameraPopover';
import { SubagentSpawnModal } from './SubagentSpawnModal';
import { CostCeilingChip } from './CostCeilingChip';
import type { AnchorPos } from './useComposerPopovers';
import { cn } from '@/lib/utils';
import { normalizeHarnessMode, type HarnessAgentMode } from '@/components/chat/HarnessModeChip';
import type { ChatSendFn } from '../hooks/useChatSend';

export function ComposerToolbar({
  sessionId,
  loadedSessionId,
  input,
  attachmentsCount,
  attachmentsReading = false,
  streaming,
  send,
  stop,
  ensureWorkbenchSession,
  workbenchSession,
  setWorkbenchSession,
  workbenchMode,
  setWorkbenchMode,
  sessionUsage,
  visibleModels,
  selectedModel,
  actionsOpen,
  actionsPos,
  actionsTriggerRef,
  onToggleActions,
  onAttach,
  folderSlot,
  onMention,
  onVoice,
  onCamera,
  cameraOpen,
  cameraPos,
  onCameraClose,
  onCameraCapture,
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
  send: ChatSendFn;
  stop: () => void;
  /** Optional: lets the toolbar append a synthetic handoff-notice card. */
  /** Creates the backend workbench session on demand — must run BEFORE the
   *  first send creates the session (session-scoped settings on fresh chats). */
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
  sessionUsage: SessionUsageState;
  visibleModels: ModelItem[];
  selectedModel: ModelItem | null;
  actionsOpen: boolean;
  actionsPos: AnchorPos | null;
  actionsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onToggleActions: () => void;
  onAttach: () => void;
  /** Optional control rendered beside the `+` in the left cluster — the
   *  composer passes the folder chip here so the card stays one row tall. */
  folderSlot?: ReactNode;
  onMention: () => void;
  onVoice: () => void;
  /** Open the camera capture popover. When omitted, no camera item is shown. */
  onCamera?: () => void;
  /** True while the camera popover is open. */
  cameraOpen?: boolean;
  /** Anchor position for the camera popover (re-uses the actions menu slot). */
  cameraPos?: AnchorPos | null;
  /** Close the camera popover. */
  onCameraClose?: () => void;
  /** Forward a captured webcam frame to the composer attachment pipeline. */
  onCameraCapture?: (file: File) => void;
  sendKind?: 'steer' | 'continue' | 'dispatch' | 'send';
  onAskParallel?: () => void;
  onStartDebate?: () => void;
}) {
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

  return (
    <div className="flex flex-col gap-0">
      <div className="flex items-center justify-between gap-1.5 px-2 pb-1 pt-0">
      <div className="flex items-center gap-1 min-w-0">
        {/* REMOVED: the `⌘` "Browse slash commands" trigger.
            The reference composer has no such control — its only left-hand
            affordance is the `+` beside the placeholder. Removed as the button
            itself plus the `onCommands` prop and its call site, not hidden with
            a class, so there is no dead element left in the DOM.

            NOT deleted: `ComposerCommandsDropdown` and the
            `showCommandsDropdown` state it is driven by. This button was its
            ONLY entry point (`ChatThread.tsx:415` exposes the setter on a ref,
            but nothing calls that ref method), and the ⌘K Command Palette does
            not list slash commands. Removing the dropdown as well would delete
            the feature rather than the icon, which is a different decision and
            the user's to make. */}
        {folderSlot}
        <ComposerActionsMenu
          open={actionsOpen}
          pos={actionsPos}
          triggerRef={actionsTriggerRef}
          onToggle={onToggleActions}
          onAttach={onAttach}
          onMention={onMention}
          onVoice={onVoice}
          onCamera={onCamera}
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
              <WorkbenchModeSelector
                selectedMode={workbenchMode}
                onChange={handleModeChange}
                sandboxMode={sandboxMode}
                onSandboxChange={handleSandboxChange}
                harnessMode={normalizeHarnessMode(workbenchSession?.agentMode)}
                onHarnessChange={persistHarnessMode}
              />
              {sessionUsage && workbenchSession?.id && (
                <CostCeilingChip
                  sessionId={workbenchSession.id}
                  cost={sessionUsage.totalCost ?? 0}
                  estimated={sessionUsage.costEstimated}
                  initialCeiling={workbenchSession.costCeiling ?? 0}
                />
              )}
            </div>
          }
        />
        {onCamera && onCameraCapture && (
          <CameraPopover
            open={!!cameraOpen}
            pos={cameraPos ?? null}
            onClose={() => onCameraClose?.()}
            onCapture={(file) => onCameraCapture(file)}
          />
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">

        {streaming ? (
          <>
            {/* Neutral, circular, monochrome — measured off the Claude reference:
                the composer's right-hand control is a CIRCLE (a stop button while
                generating, an outlined circle here), and neither it nor anything
                else in the card is the accent colour. August's `bg-primary` made
                this the only saturated element on the whole surface.
                `rounded-full` + a token-based fill keeps it legible on either
                theme without inventing a hue. */}
            <button
              type="button"
              onClick={stop}
              title="Stop"
              aria-label="Stop"
              className="size-8 shrink-0 rounded-full flex items-center justify-center bg-foreground/90 text-background hover:bg-foreground transition"
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
                        ? 'No model available — check Settings → AI Setup'
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
              /* Same reasoning as the stop button above: circular and neutral.
                 The reference's send control is not the accent colour, and a
                 32px circle matches the stop button it swaps into. */
              'size-8 justify-center rounded-full p-0 text-xs font-medium flex items-center gap-1.5 transition',
              'bg-foreground/90 text-background hover:bg-foreground',
              'disabled:opacity-30 disabled:pointer-events-none',
            )}
          >
            <ArrowUp className="size-3" />
          </button>
        )}
      </div>
      </div>

      {/* The model+effort control lived here once, then below the card, and is now
         * gone entirely by request. This slot stays empty on purpose: a third
         * row inside the card is what made the composer read as a control panel
         * rather than a text field, and nothing may claim it back. */}
      <SubagentSpawnModal
        sessionId={workbenchSession?.id}
        open={spawnOpen}
        onClose={() => setSpawnOpen(false)}
        models={visibleModels}
      />
    </div>
  );
}
