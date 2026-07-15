/* eslint-disable react-refresh/only-export-components */

/* ── Chat thread ─────────────────────────────────────────────────────── */
/* The main view. User/assistant messages with proper avatars + bubbles.  */
/* Tool calls render as inline cards. Right rail optional.                  */

import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, type Dispatch, type KeyboardEvent, type SetStateAction } from 'react';
import { Send, Paperclip, Mic, AtSign, Plus, ChevronDown, Check, StopCircle, X, Loader2, Bug, Play, Pause, RefreshCw, type LucideIcon } from 'lucide-react';
import { cn, formatClockTime, workspaceBaseName } from '@/lib/utils';
import { mockChatThread } from '@/lib/mock';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';
import { toast } from 'sonner';
import { createPortal } from 'react-dom';
import { useSessionsStore, setSessionStatus, clearSessionStatus, renameSession, deriveSessionTitleFromMessage, isPlaceholderTitle, updateSessionModel, updateSessionWorkbenchMetadata, createSession, type Session } from '@/store/sessions';
import { useActiveChatStreamsStore } from '@/store/chat-active-streams';
import { motion, AnimatePresence } from 'framer-motion';
import { ThinkingDisclosure } from '@/components/chat/ThinkingDisclosure';
import { ToolCallItem as ToolCallItemComp, ToolCallItemBody, extractAgentId } from '@/components/chat/ToolCallItem';
import { ToolSummary, buildToolSummaryEntry } from '@/components/chat/ToolSummary';
import { ActivitySummary } from '@/components/chat/ActivitySummary';
import { RecapCard } from '@/components/chat/RecapCard';
import { ScrollToTopButton, SCROLL_TO_TOP_THRESHOLD } from '@/components/chat/ScrollToTopButton';
import { ToolIcon as NewToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon as NewFileIcon } from '@/components/ui/FileIcon';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { ClarifyTool } from '@/components/chat/ClarifyTool';
import { PromptDisclosure } from '@/components/chat/PromptDisclosure';
import { visibleProgress } from '@/lib/tool-progress';
import { getToolLabel } from '@/lib/tool-labels';
import { classifyTool } from '@/lib/tool-classify';
import { WorkingIndicator } from '@/components/chat/WorkingIndicator';
import { SubagentBlock } from '@/components/chat/SubagentBlock';
import { ModelVisibilityModal, loadHiddenModels, saveHiddenModels } from '@/components/overlays/ModelVisibilityModal';
import { ApprovalBanner } from '@/components/overlays/ApprovalBanner';
import { CollaborationInsights } from '@/components/chat/CollaborationInsights';
import { ExamHost } from '@/sections/exam/ExamHost';
import { useModels } from '@/hooks/useModels';
import { useProviderAvailability } from '@/hooks/useProviderAvailability';
import { useQueryClient } from '@tanstack/react-query';
import { getAggregatedModels } from '@/api/api-client';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import { chatRuntime, type ChatTurnRecord } from './chat-runtime';
import { CommandHelpCard } from './CommandHelpCard';
import {
  voiceCommandRegistry,
  getDisplayCommands,
  type ChatMessageLite,
  type VoiceCommandCardProps,
} from '@/api/voice/registry';
import { voiceCommandEvents, type VoiceCommandEvent } from '@/api/voice/registry-events';
import {
  $sessionStreamStates,
  getOrInitSessionStreamState,
  updateSessionStreamState,
  startChatStream,
  stopChatStream,
  syncActiveStreams,
  appendBlockEvent,
  activeStreamControllers,
} from './chat-stream-manager';
import {
  useQueuedMessagesStore,
  $queuedMessagesBySession,
  setQueuedMessages,
  clearQueuedMessages,
  type QueuedUserMessage,
} from './queue-store';
import { QueuePills } from './QueuePills';
import { ProjectRulesBadge } from '@/components/chat/ProjectRulesBadge';
import { SavePointBanner } from '@/components/chat/SavePointChip';
import { ModelDropdown, EffortDropdown, ToolBtn } from './ComposerControls';
import { ChatCheckpoints } from './ChatCheckpoints';
import { MessageBubble } from './MessageBubble';
import { useSessionStream } from './hooks/useSessionStream';
import { useChatModels } from './hooks/useChatModels';
import { useChatUsage } from './hooks/useChatUsage';
import { useChatAttachments } from './hooks/useChatAttachments';
import { ChatAttachmentService } from './services/ChatAttachmentService';

const EMPTY_QUEUED_MESSAGES: QueuedUserMessage[] = [];
import { Markdown } from './ChatMarkdown';
import { readFileContent, type FileReadResult } from '@/lib/file-reader';
import { getFileIcon } from '@/lib/file-icon';
import { makeStreamHandlers } from './makeStreamHandlers';
import {
  createWorkbenchSession,
  approveWorkbenchPlan,
  rejectWorkbenchPlan,
  setWorkbenchGuardMode,
  streamPlanDecision,
  streamWorkbenchRevision,
  streamWorkbenchReconnect,
  answerWorkbenchBtw,
  getWorkbenchSession,
  listWorkbenchCapabilities,
  queueWorkbenchMessage,
  dequeueWorkbenchMessage,
  getQueuedWorkbenchMessages,
  undoWorkbenchLastTurn,
  compactWorkbenchSession,
  branchWorkbenchSession,
  listWorkbenchCheckpoints,
  restoreWorkbenchCheckpoint,
} from '@/api/workbench';
import type { WorkbenchSession } from '@/types/workbench';
import { WorkbenchBtwDrawer } from '@/components/chat/WorkbenchBtwDrawer';
import { WorkbenchModeSelector, WORKBENCH_GUARD_MODES, applyWorkbenchGuardMode, type WorkbenchGuardMode } from '@/components/chat/WorkbenchModeSelector';
import { ContextRing, estimateContextBreakdown, type ContextBreakdown } from './ChatComposer';
import { PlanProposalBanner } from '@/components/shell/PlanProposalBanner';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';
import { ChangedFilesCard } from '@/components/chat/ChangedFilesCard';
import { InitAugCard } from './InitAugCard';
import { gitApi, type GitDiffResult } from '@/api/git';
import { usageApi } from '@/api/usage';
import { WorkspaceSelector } from '@/components/workspace/WorkspaceSelector';
import { ModelPickerCard } from './ModelPickerCard';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import { onUiAction } from '@/api/ui-events';
// Chat domain types live in `@/types/chat` (Phase 2 refactor). Re-export
// from the canonical location so existing `from './ChatThread'` imports
// keep working without churn, and import for local use in this file.
import type {
  ChatMessage,
  MessageBlock,
  FileAttachment,
  ToolProgressEntry,
  WorkbenchBtwState,
} from '@/types/chat';
export type {
  ChatMessage,
  MessageBlock,
  FileAttachment,
  WorkbenchBtwState,
  WorkbenchMode,
  EffortLevel,
  ChatMessageTodo,
  ChatMessageClarify,
} from '@/types/chat';
import {
  type ModelItem,
  modelFromSession,
  loadLastModel,
  modelDisplayParts,
  getModelDisplayName,
  isLikelyReasoningModel,
  formatContextWindow,
} from './model-display';
import {
  loadMessagesForSession as loadMessagesForSessionBase,
  loadComposerDraft,
  persistComposerDraft,
  clearComposerDraft,
  persistMessages,
  messagesStorageKey,
} from './message-storage';
import { COMPOSER_TOOLS as TOOLS, parseAtMention, type MentionItem } from './composer-mentions';
import {
  parseSequentialText,
  getDisplayBlocks,
  parseThinkingAndContent,
} from './message-blocks';

export {
  modelFromSession,
  modelDisplayParts,
  getModelDisplayName,
  isLikelyReasoningModel,
  formatContextWindow,
  parseSequentialText,
  getDisplayBlocks,
  parseThinkingAndContent,
};

let visibleSessionId: string | null = null;

const STREAM_UPDATE_INTERVAL_MS = 24;

function loadMessagesForSession(sessionId: string | null): ChatMessage[] {
  return loadMessagesForSessionBase(sessionId, buildDemoThread);
}

export function ChatThread({ sessionId }: { sessionId: string | null }) {
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSession = useMemo(
    () =>
      sessions.find((s) => s.id === sessionId || s.workbenchSessionId === sessionId) ??
      null,
    [sessions, sessionId],
  );

  /* ── OOP facades / hooks (stream, models, usage, attachments) ─────── */
  const {
    messages,
    setMessages,
    subagentPrompts,
    setSubagentPrompts,
    subagentBlocks,
    toolProgress,
    setToolProgress,
    workbenchSession,
    workbenchBtw,
    setWorkbenchSession,
  } = useSessionStream(sessionId);

  const setWorkbenchBtw = useCallback(
    (btw: WorkbenchBtwState | null) => {
      if (!sessionId) return;
      updateSessionStreamState(sessionId, () => ({ workbenchBtw: btw }));
    },
    [sessionId],
  );

  const {
    models,
    visibleModels,
    modelsLoading,
    refetchModels,
    hiddenModels,
    showModelVisibility,
    setShowModelVisibility,
    toggleModelVisibility,
    selectedModel,
    setSelectedModel,
    selectModel,
    userSelectedRef,
  } = useChatModels(sessionId, activeSession);

  const sessionUsage = useChatUsage(
    sessionId,
    workbenchSession?.id,
    activeSession?.workbenchSessionId,
  );

  const {
    attachments,
    setAttachments,
    handleFileUpload,
    handleComposerPaste,
    removeAttachment,
    clearAttachments,
    composeText,
  } = useChatAttachments();

  const queryClient = useQueryClient();
  const [input, setInput] = useState(() => loadComposerDraft(sessionId));
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(sessionId);
  const [_runtimeVersion, _setRuntimeVersion] = useState(0);

  // Backend active-stream map is keyed by workbench SoT id; local turns use the
  // UI session id. OR both so the AUG indicator stays visible across tab/session switches.
  const activeChatSessions = useActiveChatStreamsStore((s) => s.active);
  const workbenchStreamId =
    workbenchSession?.id ||
    activeSession?.workbenchSessionId ||
    (sessionId?.startsWith('wb_') ? sessionId : undefined);
  const streaming =
    chatRuntime.isSessionStreaming(sessionId) ||
    (!!workbenchStreamId && chatRuntime.isSessionStreaming(workbenchStreamId)) ||
    !!(sessionId && activeChatSessions[sessionId]) ||
    !!(workbenchStreamId && activeChatSessions[workbenchStreamId]);

  const [workbenchToolCount, setWorkbenchToolCount] = useState<number | null>(null);
  const [workbenchToolTokens, setWorkbenchToolTokens] = useState<number | null>(null);
  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchGuardMode>(() => {
    const saved = localStorage.getItem('august_last_workbench_guard_mode') as WorkbenchGuardMode | null;
    return saved && WORKBENCH_GUARD_MODES[saved] ? saved : 'full';
  });
  // Whether a plan is awaiting the user's decision. When true, the composer
  // is replaced by the PlanProposalBanner so the user can only act on the
  // plan (reject / revise / accept) — no new chat message can be sent.
  // Plan gate UI only when agent mode requires it — Full Access is a hard barrier.
  const planPending =
    workbenchMode !== 'full' &&
    !!workbenchSession?.plan &&
    !workbenchSession?.approved &&
    !workbenchSession?.approvedAt;

  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>(() => {
    try {
      const saved = localStorage.getItem('august_last_effort');
      if (saved && ['low', 'medium', 'high', 'max'].includes(saved)) {
        return saved as 'low' | 'medium' | 'high' | 'max';
      }
    } catch { /* silent */ }
    return 'medium';
  });
  const [revertingIndex, setRevertingIndex] = useState<number | null>(null);

  const [voiceActive, setVoiceActive] = useState(false);
  const [showComposerActionsDropdown, setShowComposerActionsDropdown] = useState(false);
  const [showToolsDropdown, setShowToolsDropdown] = useState(false);
  const [showCommandsDropdown, setShowCommandsDropdown] = useState(false);
  const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0);
  // Skills / tools @ mention picker
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(0);
  const [skillMentions, setSkillMentions] = useState<MentionItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);
  // Live markdown preview lives below the textarea but is opt-in: most
  // users want a plain textarea while typing, and the rendered preview
  // visually reads like a second input box. Toggle via the "Preview"
  // button in the composer toolbar.
  // TODO: re-enable markdown preview via keyboard shortcut (e.g. Ctrl/Cmd+Shift+P)
  const [showPreview, setShowPreview] = useState(false);
  void setShowPreview; // retained for future shortcut; Preview toolbar toggle removed
  // Mid-response queued messages live in the queue-store (per-session).
  // ChatThread mirrors a local copy for quick synchronous access; the
  // SSE subscriber writes back into the store when messages are added /
  // removed / injected, and the Zustand selector keeps this view in sync.
  const queuedMessages = useQueuedMessagesStore(
    (s) => s.bySession[sessionId ?? ''] ?? EMPTY_QUEUED_MESSAGES,
  );

  // v3: /Exam slash command — overlay the ExamBanner with the given seed.
  const [examActive, setExamActive] = useState(false);
  const [examSeed, setExamSeed] = useState<{ topic?: string; files?: string[] }>({});

  // v4: AUG.md /init preview card state
  const [augPreview, setAugPreview] = useState<{ draft: string; existing: boolean; workspacePath: string } | null>(null);

  // v4: Voice command UI — inline model picker card
  const [modelPickerActive, setModelPickerActive] = useState(false);

  // Refs for each popover trigger — used to compute the portaled panel's
  // viewport position. We portal the panels to document.body (see
  // renderComposerContent) so they escape the overflow:hidden chain that
  // would otherwise clip them at the chat-thread boundary.
  const composerActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const composerRootRef = useRef<HTMLDivElement>(null);

  // Viewport positions for the three portaled popovers. Each recomputes
  // when the corresponding dropdown opens or the page scrolls / resizes
  // while the dropdown is open.
  const [composerActionsPos, setComposerActionsPos] = useState<{ top: number; left: number } | null>(null);
  const [toolsPos, setToolsPos] = useState<{ top: number; left: number } | null>(null);
  const [commandsPos, setCommandsPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!showComposerActionsDropdown) {
      setComposerActionsPos(null);
      return;
    }
    const compute = () => {
      const el = composerActionsTriggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setComposerActionsPos({ top: Math.max(8, r.top - 8), left: r.left });
    };
    requestAnimationFrame(compute);
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [showComposerActionsDropdown]);

  useEffect(() => {
    const open = showToolsDropdown || mentionQuery !== null;
    if (!open) {
      setToolsPos(null);
      return;
    }
    const compute = () => {
      const el = composerRootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setToolsPos({ top: Math.max(8, r.top - 8), left: r.left + 8 });
    };
    requestAnimationFrame(compute);
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [showToolsDropdown, mentionQuery]);

  useEffect(() => {
    if (!showCommandsDropdown) {
      setCommandsPos(null);
      return;
    }
    const compute = () => {
      const el = composerRootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setCommandsPos({ top: Math.max(8, r.top - 8), left: r.left + 8 });
    };
    requestAnimationFrame(compute);
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [showCommandsDropdown]);

  const showMentionsDropdown = mentionQuery !== null;

  // Fetch skills when @ mention picker opens or query changes.
  useEffect(() => {
    if (mentionQuery === null) return;
    let cancelled = false;
    setSkillsLoading(true);
    const q = mentionQuery.trim();
    const url = '/api/skills' + (q ? `?q=${encodeURIComponent(q)}` : '');
    api
      .get<{ total: number; skills: Array<{ name: string; description?: string; category?: string }> }>(url)
      .then((data) => {
        if (cancelled) return;
        const items: MentionItem[] = (data.skills ?? []).slice(0, 30).map((s) => ({
          kind: 'skill' as const,
          name: s.name,
          desc: s.description || s.category || 'Skill',
          insert: `@skill:${s.name} `,
        }));
        setSkillMentions(items);
      })
      .catch(() => {
        if (!cancelled) setSkillMentions([]);
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mentionQuery]);

  const mentionItems: MentionItem[] = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const tools: MentionItem[] = TOOLS.filter((t) => {
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q);
    }).map((t) => ({
      kind: 'tool' as const,
      name: t.name,
      desc: t.desc,
      insert: t.name.startsWith('@') ? `${t.name} ` : `@${t.name} `,
    }));
    const skills = skillMentions.filter((s) => {
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q);
    });
    return [...skills, ...tools];
  }, [mentionQuery, skillMentions]);

  // Outside-click + Escape handlers for the composer dropdowns.
  useEffect(() => {
    const anyOpen =
      showComposerActionsDropdown || showToolsDropdown || showCommandsDropdown || showMentionsDropdown;
    if (!anyOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (composerActionsTriggerRef.current?.contains(t)) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[data-composer-popover]')) return;
      setShowComposerActionsDropdown(false);
      setShowToolsDropdown(false);
      setShowCommandsDropdown(false);
      setMentionQuery(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowComposerActionsDropdown(false);
        setShowToolsDropdown(false);
        setShowCommandsDropdown(false);
        setMentionQuery(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showComposerActionsDropdown, showToolsDropdown, showCommandsDropdown, showMentionsDropdown]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const [scrolledFromBottom, setScrolledFromBottom] = useState(false);
  const [scrolledFromTop, setScrolledFromTop] = useState(false);

  const scrollToBottomSmooth = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollable = el.closest(".overflow-y-auto");
    const target = scrollable ?? el;
    target.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
  }, []);

  // Track whether the user has scrolled up from the bottom / down from the top.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollable = el.closest(".overflow-y-auto") ?? el;
    const check = () => {
      const atBottom = scrollable.scrollHeight - scrollable.scrollTop - scrollable.clientHeight < 1;
      setScrolledFromBottom(!atBottom);
      setScrolledFromTop(scrollable.scrollTop > SCROLL_TO_TOP_THRESHOLD);
    };
    check();
    scrollable.addEventListener("scroll", check, { passive: true });
    return () => scrollable.removeEventListener("scroll", check);
  }, [messages]);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);

  const scrollToBottomImmediate = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollable = el.closest('.overflow-y-auto');
    const target = scrollable ?? el;
    target.scrollTop = target.scrollHeight;
  }, []);

  const isTurnVisible = (turnSessionId: string | null) => mountedRef.current && visibleSessionId === turnSessionId;

  const finishTurn = (turn: ChatTurnRecord, status: 'done' | 'error' | 'aborted' = 'done') => {
    chatRuntime.finishTurn(turn.turnId, status);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setWorkbenchToolCount(null);
      setWorkbenchToolTokens(null);
      return;
    }

    let cancelled = false;
    listWorkbenchCapabilities()
      .then(({ totalTools, toolTokenEstimate }) => {
        if (cancelled) return;
        if (Number.isFinite(totalTools)) setWorkbenchToolCount(totalTools);
        if (Number.isFinite(toolTokenEstimate)) setWorkbenchToolTokens(toolTokenEstimate!);
      })
      .catch(() => {
        if (!cancelled) {
          setWorkbenchToolCount(null);
          setWorkbenchToolTokens(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);


  useEffect(() => chatRuntime.subscribe(() => _setRuntimeVersion((value) => value + 1)), []);



  useEffect(() => {
    visibleSessionId = sessionId;
  }, [sessionId]);

  // ── Voice command registry event subscription ─────────────────────────
  // Phase 1A: handlers in `api/voice/builtins.ts` emit events; this
  // effect wires them to local state mutations.
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  useEffect(() => {
    const unsubscribe = voiceCommandEvents.subscribe((event: VoiceCommandEvent) => {
      switch (event.type) {
        case 'push-card': {
          const cardMsg: ChatMessage = {
            id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            kind: 'voice-command-card',
            commandId: event.commandId,
            context: event.context,
          };
          setMessages(prev => [...prev, cardMsg]);
          persistMessages(sessionId, [...messagesRef.current, cardMsg]);
          setInput('');
          clearComposerDraft(sessionId);
          break;
        }
        case 'push-message': {
          setMessages(prev => [...prev, event.message as unknown as ChatMessage]);
          persistMessages(
            sessionId,
            [...messagesRef.current, event.message as unknown as ChatMessage],
          );
          break;
        }
        case 'clear-chat': {
          setMessages([]);
          persistMessages(sessionId, []);
          setInput('');
          clearAttachments();
          clearComposerDraft(sessionId);
          break;
        }
        case 'new-session': {
          window.dispatchEvent(new CustomEvent('august:new-session'));
          break;
        }
        case 'insert-text': {
          setInput(prev => prev + event.text);
          break;
        }
	      case 'send-message': {
	          void send(event.text);
          break;
        }
        case 'toast': {
          if (event.level === 'error') toast.error(event.message);
          else if (event.level === 'success') toast.success(event.message);
          else toast.info(event.message);
          break;
        }
        case 'open-skills': {
          setInput('/skills ');
          break;
        }
        case 'load-skill': {
          api.get<{ total: number; skills: Array<{ name: string; description: string; trigger: string; category: string }> }>(`/api/skills?q=${encodeURIComponent(event.skillName)}`)
            .then(data => {
              if (data.total === 0) {
                toast.error(
                  'No skill found matching "' +
                    event.skillName +
                    '". Try /skills to list available skills.',
                );
                return;
              }
              const skill = data.skills[0];
              const lines = [
                '[Loaded skill: **' + skill.name + '**]',
                '',
                '> **' + skill.description + '**',
                '> *Trigger: ' + (skill.trigger || '—') + '*',
                '> *Category: ' + skill.category + '*',
                '',
                'Use august__load_skill { name: "' + skill.name + '" } to load the full instructions.',
              ];
              setInput(lines.join('\n'));
              toast.success('Loaded skill: ' + skill.name);
            })
            .catch(() => toast.error('Failed to fetch skills.'));
          break;
        }
        case 'fetch-skills': {
          const url =
            '/api/skills' + (event.query ? '?q=' + encodeURIComponent(event.query) : '');
          api.get<{ total: number; skills: Array<{ name: string; category: string; enabled: boolean; description: string }> }>(url)
            .then(data => {
              if (data.total === 0) {
                toast.info(
                  'No skills found' +
                    (event.query ? ' matching "' + event.query + '"' : '') +
                    '.',
                );
                return;
              }
              const items = data.skills
                .slice(0, 20)
                .map((s: { name: string; category: string; enabled: boolean; description: string }) =>
                  '• **' +
                  s.name +
                  '** [' +
                  s.category +
                  ']' +
                  (s.enabled ? '' : ' ⚠️ inactive') +
                  '\n  ' +
                  s.description,
                );
              setInput(
                '**Skills (' +
                  data.total +
                  ' found)**\n\n' +
                  items.join('\n\n') +
                  '\n\nUse /load <skill-name> to inject a skill into your message.',
              );
              toast.success('Found ' + data.total + ' skill' + (data.total > 1 ? 's' : ''));
            })
            .catch(() => toast.error('Failed to fetch skills.'));
          break;
        }
        case 'open-exam': {
          const seed = event.topic;
          if (attachments.length > 0) {
            const filePaths = attachments
              .map(a => a.path || a.name)
              .filter(Boolean);
            setExamSeed({ topic: seed, files: filePaths });
          } else {
            setExamSeed({ topic: seed, files: [] });
          }
          setExamActive(true);
          setInput('');
          clearComposerDraft(sessionId);
          break;
        }
        case 'init-aug': {
          const ws = event.workspacePath || activeSession?.workspacePath || '';
          setInput('');
          clearComposerDraft(sessionId);
          // Decide create vs refine by checking whether an AUG.md already
          // exists for this workspace. /init should refine an existing file
          // rather than blindly overwrite it.
          const decideMode = api.get<{ exists: boolean }>(
            '/api/aug/context' + (ws ? `?workspacePath=${encodeURIComponent(ws)}` : ''),
          )
            .then(c => (c && c.exists ? 'refine' : 'create'))
            .catch(() => 'create');
          decideMode
            .then(mode =>
              api.post<{ draft: string; existing: boolean }>('/api/aug/init', {
                mode,
                workspacePath: ws || undefined,
              }),
            )
            .then(data => {
              setAugPreview({
                draft: data.draft || '',
                existing: Boolean(data.existing),
                workspacePath: ws || '',
              });
            })
            .catch((e: unknown) =>
              toast.error(e instanceof Error ? e.message : 'Failed to generate AUG.md'),
            );
          break;
        }
        case 'aug-preview': {
          setAugPreview({
            draft: event.draft,
            existing: event.existing,
            workspacePath: event.workspacePath,
          });
          break;
        }
        case 'aug-saved': {
          setAugPreview(null);
          toast.success('AUG.md saved');
          break;
        }
        case 'reset-session': {
          setInput('/reset');
          setTimeout(() => { void send(); }, 0);
          break;
        }
      }
    });
    return unsubscribe;
  }, [sessionId, attachments, send, activeSession?.workspacePath, setMessages]);

  useLayoutEffect(() => {
    if (!sessionId || loadedSessionId !== sessionId) return;
    // The chat thread no longer owns its own scrollbar — the scroll thumb
    // lives at the screen edge (or right-drawer left edge) in ChatLayout.
    // We still keep `scrollRef` for checkpoint positioning, but the actual
    // "scroll to bottom" needs to walk up to the nearest scrollable ancestor.
    scrollToBottomImmediate();
  }, [sessionId, loadedSessionId, messages, streaming, scrollToBottomImmediate]);

  useEffect(() => {
    setInput(loadComposerDraft(sessionId));
    setLoadedSessionId(sessionId);
    // Hydrate the per-session queue from the backend so a queued message
    // survives tab switches / page reloads. Clear local state first so
    // we don't briefly show stale entries from another session.
    if (sessionId) {
      clearQueuedMessages(sessionId);
      getQueuedWorkbenchMessages(sessionId)
        .then((entries) => setQueuedMessages(sessionId, entries))
        .catch((err) => {
           
          console.warn('[ChatThread] failed to hydrate queue', err);
        });
    }
  }, [sessionId]);

  // Persist messages to localStorage on every change
  useEffect(() => {
    persistMessages(sessionId, messages);
  }, [messages, sessionId]);

  useEffect(() => {
    persistComposerDraft(sessionId, input);
  }, [input, sessionId]);

  // Persist effort choice to localStorage on every change
  useEffect(() => {
    try { localStorage.setItem('august_last_effort', effort); } catch { /* silent */ }
  }, [effort]);

  useEffect(() => {
    try { localStorage.setItem('august_last_workbench_guard_mode', workbenchMode); } catch { /* silent */ }
  }, [workbenchMode]);

  // Model list + selection: useChatModels (filters by provider availability,
  // keeps selection scoped to the active session).

		  // On mount: fetch active config for initial model selection.
		  useEffect(() => {
		    void (async () => {
      // Phase 1: quick config fetch for initial model selection
      try {
          const config = await api.get<Record<string, unknown>>('/api/config/safe');
          const activeProvider = (config?.activeProvider as string) || '';
          const pConfig = (config?.[activeProvider] as Record<string, unknown>) || {};
          const activeModelId: string | null = (pConfig?.model as string) || (pConfig?._upstreamModel as string) || (pConfig?.currentModel as string) || null;
          if (activeModelId && activeProvider && !userSelectedRef.current) {
            const placeholder: ModelItem = {
              id: activeModelId,
              name: activeModelId,
              provider: activeProvider,
              contextWindow: 128000,
              supportsReasoning: isLikelyReasoningModel(activeModelId),
              supportsThinking: isLikelyReasoningModel(activeModelId),
            };
            setSelectedModel(prev => {
              if (prev && prev.id === activeModelId) return prev;
              return placeholder;
            });
          }
      } catch (e) {
        console.warn('[Models] Config fetch failed, using localStorage fallback:', e);
      }
    })();
  }, []);

  // Re-fetch models when session changes (provider availability is handled by
  // the useProviderAvailability hook above).
  useEffect(() => {
	    void refetchModels();
	  }, [sessionId, refetchModels]);

	  // Force a full refresh: bypass any backend cache, invalidate both the
  // aggregated-models and provider-availability react-query caches so every
  // subscriber refetches, then refetch this component's own models list.
  const handleRefreshModels = useCallback(async () => {
    await refreshProviderCatalog(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['provider-availability'] });
    void refetchModels();
  }, [queryClient, refetchModels]);

  // Reconcile selectedModel when the filtered model list changes (models were
  // refetched or provider availability changed). Preserve user's manual choice.
  const prevModelsRef = useRef<ModelItem[]>(models);
  useEffect(() => {
    if (models.length === 0 || models === prevModelsRef.current) return;
    prevModelsRef.current = models;
    setSelectedModel(prev => {
      const targetId = userSelectedRef.current || prev?.id || null;
      if (!targetId) return models[0];
      const matched = models.find(
        m => m.id === targetId || m.id.toLowerCase() === targetId.toLowerCase()
      );
      return matched || prev || models[0];
    });
  }, [models]);

  // Remove hardcoded fallback — rely on API only
  const currentModel = selectedModel || null;
  const modelForRequest = currentModel || modelFromSession(activeSession || null);


  const _updateAssistantMessage = useCallback((
    turnSessionId: string | null,
    assistantMsgId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[]
  ) => {
    const key = messagesStorageKey(turnSessionId);
    if (turnSessionId === sessionId && mountedRef.current) {
      setMessages(prev => {
        const next = updater(prev);
        persistMessages(turnSessionId, next);
        return next;
      });
      return;
    }
    if (!key) return;
    try {
      const saved = localStorage.getItem(key);
      const current = saved ? JSON.parse(saved) as ChatMessage[] : [];
      persistMessages(turnSessionId, updater(current));
    } catch {
      persistMessages(turnSessionId, updater([]));
    }
  }, [sessionId, setMessages]);

  const _createAssistantPlaceholder = (assistantMsgId: string): ChatMessage => ({
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString()
  });

  // Dynamic context usage tracker
  const maxContext = modelForRequest?.contextWindow || 128000;

  // Per-category breakdown for the ContextRing popup. The tool surface comes
  // from the backend capability endpoint; 30 is only a startup fallback.
  const toolCountForBreakdown = workbenchToolCount ?? 30;
  const toolTokenEstimate = workbenchToolTokens;

  // Ground-truth total: once at least one provider request has completed,
  // the backend reports the true current context fill as `contextTokens`
  // (the input_tokens of the most recent request — system prompt + tools +
  // messages, counted exactly once by the provider's tokenizer). Before the
  // first request we fall back to a minimal, non-inflated heuristic over the
  // composer input + active tools only (no flat 3000, no +15% thinking
  // double-count — those previously caused >50% inflation).
  const serverContextTokens = sessionUsage?.contextTokens ?? 0;
  const hasServerTruth = serverContextTokens > 0;
  // Tool definitions are a real context cost — but only once something is
  // actually being sent. On a fresh, empty session (no input, no messages, no
  // completed request) nothing is "used" yet, so the gauge reads ~0% instead
  // of pre-counting the tool-definition overhead. Once the user types input
  // or a request has run, the tool overhead is included (it's part of the
  // next/actual request's context).
  const hasContentToSend = input.length > 0 || messages.length > 0;
  const toolOverhead = (hasServerTruth || hasContentToSend)
    ? (toolTokenEstimate ?? Math.ceil(toolCountForBreakdown * 180))
    : 0;
  const fallbackEstimate =
    Math.ceil((input.length + messages.reduce((s, m) => s + m.content.length, 0)) / 4)
    + toolOverhead;
  const estTokens = hasServerTruth ? serverContextTokens : fallbackEstimate;
  const pct = Math.min(100, Math.round((estTokens / maxContext) * 100));

  // The per-category breakdown is informational. When we have a server ground
  // truth we scale the category estimates to sum exactly to `estTokens` so the
  // tooltip's breakdown rows always agree with the ring's numerator.
  const contextBreakdown: ContextBreakdown = useMemo(
    () => estimateContextBreakdown({
      messages,
      input,
      toolCount: toolCountForBreakdown,
      toolTokenEstimate: toolTokenEstimate ?? undefined,
      // Scale to the server ground truth when available. On a fresh empty
      // session (nothing to send, no request yet) anchor to 0 so the tooltip
      // breakdown matches the 0% ring instead of pre-counting tool overhead.
      // When the user has typed input, leave undefined (raw estimate includes
      // tool definitions — they're a real cost on the next request).
      scaleToTotal: hasServerTruth ? serverContextTokens : (hasContentToSend ? undefined : 0),
    }),
    [messages, input, toolCountForBreakdown, toolTokenEstimate, hasServerTruth, serverContextTokens, hasContentToSend]
  );

  // The Workbench chat uses the provider of the model the user selected in the
  // model dropdown (passed as `provider` / `modelProvider` below). There is no
  // hardcoded claude/codex engine fallback — the backend resolves the real
  // provider and routes by its apiMode.

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ensureWorkbenchSession = async () => {
    if (!sessionId) return null;
    const localTitle = useSessionsStore
      .getState()
      .sessions.find((s) => s.id === sessionId || s.workbenchSessionId === sessionId)
      ?.title;

    const syncTitleToBackend = (wbId: string, backendTitle?: string) => {
      // If the sidebar already has a real title and the workbench still has a
      // placeholder, push the good title so it sticks across reloads.
      if (localTitle && !isPlaceholderTitle(localTitle) && isPlaceholderTitle(backendTitle)) {
        void fetch(`/api/workbench/sessions/${encodeURIComponent(wbId)}/title`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: localTitle }),
        }).catch(() => { /* best-effort */ });
      }
    };

    const existingId = workbenchSession?.id || activeSession?.workbenchSessionId;
    if (existingId) {
      try {
        const loaded = await getWorkbenchSession(existingId);
        setWorkbenchSession(loaded);
        updateSessionWorkbenchMetadata(sessionId, {
          workbenchSessionId: loaded.id,
          workbenchAgentId: loaded.agentId,
          workbenchProvider: loaded.provider,
        });
        syncTitleToBackend(loaded.id, loaded.title);
        return loaded;
      } catch {
        // The backend may have been restarted; create a fresh Workbench session below.
      }
    }

    const created = await createWorkbenchSession({
      provider: modelForRequest?.provider,
      agentId: WORKBENCH_GUARD_MODES[workbenchMode].agentId,
      guardMode: workbenchMode,
    });
    setWorkbenchSession(created);
    updateSessionWorkbenchMetadata(sessionId, {
      workbenchSessionId: created.id,
      workbenchAgentId: created.agentId,
      workbenchProvider: created.provider,
    });
    syncTitleToBackend(created.id, created.title);
    return created;
  };

	  useEffect(() => {
	    void syncActiveStreams(ensureWorkbenchSession);
	    // Re-attach durable SSE + refresh active-stream map when the user
	    // returns to the tab or switches sessions so AUG does not go stale.
	    const handleVisibilityChange = () => {
	      if (document.visibilityState === 'visible') {
	        void syncActiveStreams(ensureWorkbenchSession);
	      }
	    };
	    const handleFocus = () => {
	      void syncActiveStreams(ensureWorkbenchSession);
	    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [ensureWorkbenchSession, sessionId]);

  /**
   * Helper for banner/panel click handlers. Wraps the streaming
   * infrastructure in one place so the four banner callbacks (and the
   * one panel callback) all share the exact same setup that the
   * composer uses in `generateAIResponse`. The `run` callback
   * receives the assembled handler bundle and is expected to start
   * the appropriate `stream*` call (e.g. `streamPlanDecision`).
   */
  const streamPlanTurn = async (
    run: (handlers: { onError?: (data: { message: string }) => void } & Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
    overrideMessages?: ChatMessage[],
    targetWorkbenchSessionId?: string
  ) => {
    if (!sessionId) return;
    setSessionStatus(sessionId, 'working');
    const assistantMsgId = `a${Date.now()}`;
    const turn = chatRuntime.startTurn({
      sessionId,
      assistantMsgId,
      transport: 'none',
    });
    const abortController = turn.controller;
    activeStreamControllers.set(sessionId, abortController);
    const initialMsgs = overrideMessages || (sessionId === loadedSessionId ? messages : loadMessagesForSession(sessionId));
    const { handlers, finalize } = makeStreamHandlers({
      sessionId,
      assistantMsgId,
      initialMessages: initialMsgs,
      setMessages,
      persistMessages,
      setSessionStatus,
      setWorkbenchSession,
      setSubagentPrompts,
      setToolProgress,
      setWorkbenchBtw,
      isTurnVisible,
      finishTurn,
      turn,
      gitApi,
      streamUpdateIntervalMs: STREAM_UPDATE_INTERVAL_MS,
      initialMutationCount: workbenchSession?.mutationCount,
      appendBlockEvent,
    });
    // Wrap the user's onError so the toast still fires alongside the
    // factory's stream-error handler (which writes the ⚠️ block).
    const wrappedHandlers = {
      ...handlers,
      onError: (data: { message: string }) => {
        toast.error('Could not notify the model', { description: data.message });
        handlers.onError?.(data);
      },
    };
    try {
      chatRuntime.setTransport(turn.turnId, 'http');
      const startResult = await run(wrappedHandlers, abortController.signal);
      const wbSessionId = targetWorkbenchSessionId || workbenchSession?.id || sessionId;
      const resultWithSeq = startResult as { sinceSeq?: number } | null;
      if (resultWithSeq && Number.isFinite(resultWithSeq.sinceSeq)) {
        await streamWorkbenchReconnect(
          wbSessionId,
          wrappedHandlers,
          abortController.signal,
          resultWithSeq.sinceSeq
        );
      }
      finalize(abortController.signal.aborted ? 'aborted' : 'done');
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        clearSessionStatus(sessionId);
        finalize('aborted');
        return;
      }
      console.error('[streamPlanTurn] error:', e);
      finalize('error');
    } finally {
      activeStreamControllers.delete(sessionId);
    }
  };

  const handlePlanRevision = async (feedback: string) => {
    if (!workbenchSession || !sessionId) return;
    const wbSessionId = workbenchSession.id;
    try {
      const userMsg: ChatMessage = {
        id: `m${Date.now()}`,
        role: 'user',
        content: feedback,
        timestamp: new Date().toISOString()
      };
      const currentMessages = sessionId === loadedSessionId ? messages : loadMessagesForSession(sessionId);
      const nextMessages = [...currentMessages, userMsg];
      setMessages(nextMessages);
      persistMessages(sessionId, nextMessages);

      // Clear/reject the current plan first so the banner goes away and shows the composer input / thinking status
      try {
        const updated = await rejectWorkbenchPlan(wbSessionId);
        setWorkbenchSession(updated);
      } catch (err) {
        console.warn('Failed to reject plan before revision:', err);
        // Fallback: clear the plan locally so the UI updates regardless
        setWorkbenchSession((prev: WorkbenchSession | null) => prev ? { ...prev, plan: null } : null);
      }

      await streamPlanTurn(
        (handlers, signal) => streamWorkbenchRevision(wbSessionId, feedback, handlers, signal),
        nextMessages,
        wbSessionId
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Could not send revision', { description: message });
    }
  };

  const generateAIResponse = async (chatHistory: ChatMessage[]) => {
    const turnSessionId = sessionId;
    if (!turnSessionId) return;
    if (!chatRuntime.canStartTurn(turnSessionId)) {
      // Stale runtime turn with no live controller — clear and proceed.
      if (!activeStreamControllers.has(turnSessionId)) {
        chatRuntime.abortSession(turnSessionId);
      } else {
        // Real in-flight stream: queue on backend instead of dropping.
        const lastUser = [...chatHistory].reverse().find((m) => m.role === 'user');
        const text = lastUser?.content?.trim() || '';
        if (text) {
          try {
            const wbId =
              workbenchSession?.id ||
              activeSession?.workbenchSessionId ||
              turnSessionId;
            const entry = await queueWorkbenchMessage(wbId, text);
            setQueuedMessages(turnSessionId, [
              ...($queuedMessagesBySession.get()[turnSessionId] ?? []),
              entry,
            ]);
            toast.message('Queued — will send when the current response finishes');
          } catch {
            toast.error('Could not start a new response — one is already running');
          }
        }
        return;
      }
    }

    // Backend session already holds history — only send the new user turn.
    // Sending the full transcript as one blob every time bloated context and
    // could make the model/provider look "stuck" or fail silently on large chats.
    const lastUser = [...chatHistory].reverse().find((m) => m.role === 'user');
    const latestText = (lastUser?.content ?? '').trim();
    if (!latestText) {
      toast.error('Nothing to send');
      return;
    }

    if (!modelForRequest?.id) {
      toast.error('Select a model first (e.g. a free OpenCode model)');
      return;
    }
    if (!modelForRequest.provider) {
      toast.error('Selected model has no provider — pick it again from the model list');
      return;
    }

    const result = await startChatStream(turnSessionId, {
      message: applyWorkbenchGuardMode(workbenchMode, latestText),
      chatHistory,
      workbenchMode,
      effort,
      model: modelForRequest.id,
      // Always pass the provider that owns this model (name or id). Without
      // it, free claude-like ids can resolve to bare Anthropic with no key.
      modelProvider: modelForRequest.provider,
      provider: modelForRequest.provider,
      agentId: WORKBENCH_GUARD_MODES[workbenchMode].agentId,
      guardMode: workbenchMode,
      ensureWorkbenchSession,
    });
    if (result === 'error') {
      toast.error('Chat failed — check backend and model provider');
    }
  };

  // Fallback drain: if the model never picked up the queued messages
  // (e.g. the user cancelled the response mid-stream), the queue still
  // holds entries when streaming ends. In that case we synthesize a
  // fresh user message from the queued text and start a new turn. The
  // backend already removes the entries when it drains them in-loop, so
  // the queue store should be empty in the normal flow.
  useEffect(() => {
    if (!sessionId || streaming) return;
    const leftover = queuedMessages;
    if (leftover.length === 0) return;
    // Defer so we don't race with the finalize() of the just-ended turn.
    const timer = setTimeout(() => {
      const stillQueued = ($queuedMessagesBySession.get()[sessionId] ?? []);
      if (stillQueued.length === 0) return;
      const first = stillQueued[0];
      const rest = stillQueued.slice(1);
      const userMsg: ChatMessage = {
        id: `m${Date.now()}`,
        role: 'user',
        content: first.text,
        timestamp: new Date().toISOString(),
        attachments: first.attachments,
        queued: true,
      };
      const remaining = rest.length > 0
        ? [...(messagesRef.current), userMsg]
        : [...(messagesRef.current), userMsg];
      setMessages(remaining);
      persistMessages(sessionId, remaining);
      // Drop the entry we just consumed locally; the backend will see an
      // empty queue when we POST the next /chat call.
      setQueuedMessages(sessionId, rest);
      setTimeout(() => { void generateAIResponse(remaining); }, 0);
    }, 0);
    return () => clearTimeout(timer);
  }, [streaming, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  async function send(textOverride?: string) {
    if (!sessionId) {
      toast.error('No active session');
      return;
    }
    if (loadedSessionId !== sessionId) {
      toast.error('Session is still loading — try again in a moment');
      return;
    }

    let text = composeText(textOverride ?? input);
    if (!text && attachments.length === 0) return;

    // Local slash command dispatch — handle purely client-side commands
    // before sending to the backend. The workbench backend intercepts
    // /btw and /goal at workbench.js:2334-2347 and answers them without
    // pushing a user message into the session, so we let those fall
    // through to the normal send path.
    //
    // Phase 1A: registry-driven dispatch. The handler is responsible for
    // mutating state (via the registry event bus) and for clearing the
    // composer / draft. Handlers that need data from the backend (e.g.
    // /load, /skills fetching /api/skills) emit a 'load-skill' / 'fetch-skills'
    // event that this component subscribes to.
    const slashMatch = text.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
    if (slashMatch) {
      const cmd = slashMatch[1].toLowerCase();
      const arg = String(slashMatch[2] || '').trim();

      const voiceCmd = voiceCommandRegistry.getBySlashCommand('/' + cmd);
      if (voiceCmd) {
        try {
          // Voice command handlers accept the lite `ChatMessageLite[]` view;
          // cast across the boundary since the full `ChatMessage[]` carries
          // every lite field plus extras (timestamp, attachments, blocks, …).
          const handlerResult = voiceCmd.handler({
            sessionId: sessionId ?? '',
            transcript: text,
            args: arg,
            messages: messages as unknown as ChatMessageLite[],
            setMessages: setMessages as unknown as Dispatch<SetStateAction<ChatMessageLite[]>>,
          });
          void Promise.resolve(handlerResult).catch(err => {
             
            console.error('[slash] handler threw', err);
            toast.error('Command failed');
          });
          setShowCommandsDropdown(false);
          setShowToolsDropdown(false);
          // Most handlers clear the composer themselves; the registry
          // contract is that they do so for client-only commands.
          // For commands that should fall through to the backend (e.g.
          // /btw with an arg), the handler should NOT clear the composer.
          return;
        } catch (err) {
           
          console.error('[slash] handler threw synchronously', err);
          toast.error('Command failed');
          return;
        }
      }
      // Unrecognized slash command — let the backend handle it (or no-op).
    }

    // While streaming: mid-run STEER (course correction) — applies at the
    // next tool/LLM boundary without cancelling the turn (Hermes-style /steer).
    if (streaming && sessionId) {
      try {
        const savedAttachments = attachments.length > 0 ? [...attachments] : undefined;
        // Backend queue is keyed by workbench session id, not the sidebar id.
        const wbId =
          workbenchSession?.id ||
          activeSession?.workbenchSessionId ||
          sessionId;
        const entry = await queueWorkbenchMessage(wbId, text, savedAttachments, 'steer');
        // Optimistic local update: the SSE event will also arrive and
        // upsert the same entry (idempotent), but write immediately so
        // the pill is visible without a round-trip.
        setQueuedMessages(sessionId, [...(queuedMessages), entry]);
        setInput('');
        clearAttachments();
        setShowToolsDropdown(false);
        setShowCommandsDropdown(false);
        clearComposerDraft(sessionId);
        toast.message('Direction queued', {
          description: 'August will apply this after the current tool step.',
        });
      } catch (err) {
         
        console.error('[send] steer failed', err);
        toast.error('Could not add direction');
      }
      return;
    }

    const currentMessages = sessionId === loadedSessionId ? messages : loadMessagesForSession(sessionId);

    // Auto-title when the sidebar still has a placeholder title (first real
    // user message, or after a failed earlier attempt). Backend also auto-titles
    // on stream start; this keeps local UI instant.
    const activeSess = useSessionsStore.getState().sessions.find(
      (s) => s.id === sessionId || s.workbenchSessionId === sessionId,
    );
    const needsTitle =
      !activeSess?.title ||
      /^(new chat|new session|untitled)$/i.test(activeSess.title.trim()) ||
      /^chat\s+\d{4}-\d{2}-\d{2}/i.test(activeSess.title.trim());
    if (sessionId && needsTitle) {
      const isCommand = /^\s*\/[a-zA-Z][\w-]*\b/.test(text);
      if (!isCommand) {
        const title = deriveSessionTitleFromMessage(text);
        if (title) renameSession(sessionId, title);
      }
    }

    // Save the selected model on this session only; do not change global defaults.
    if (sessionId && modelForRequest) {
      updateSessionModel(sessionId, modelForRequest.id, modelForRequest.provider);
    }

    setInput('');
    clearComposerDraft(sessionId);
    const savedAttachments = attachments.length > 0 ? [...attachments] : undefined;
    clearAttachments();
    setShowToolsDropdown(false);
    setShowCommandsDropdown(false);

    const userMsg: ChatMessage = {
      id: `m${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      attachments: savedAttachments,
    };

    const nextMessages = [...currentMessages, userMsg];
    setMessages(nextMessages);
    persistMessages(sessionId, nextMessages);
    // Pass the FULL message history — `generateAIResponse` builds the new
    // messages state from this argument, so passing only `[userMsg]` would
    // overwrite the existing list with just two entries and wipe the prior
    // conversation from view and from localStorage.
    await generateAIResponse(nextMessages);
  };

  const stop = () => {
	    if (sessionId) void stopChatStream(sessionId);
	  };

  // ── Revert: delete user message and all subsequent messages, put text back into chat input ──
  const handleRevert = (index: number) => {
    if (streaming) return;

    let userMsgIndex = -1;
    if (messages[index].role === 'user') {
      userMsgIndex = index;
    } else if (index > 0 && messages[index - 1].role === 'user') {
      userMsgIndex = index - 1;
    }

    if (userMsgIndex === -1) return;

    const userMsg = messages[userMsgIndex];
    const deleted = messages.length - userMsgIndex;

    const originalMessages = [...messages];
    const originalInput = input;
    setRevertingIndex(userMsgIndex);

    setTimeout(() => {
      setInput(userMsg.content);
      setMessages(prev => {
        const next = prev.slice(0, userMsgIndex);
        persistMessages(sessionId, next);
        return next;
      });
      setRevertingIndex(null);

      toast.success("Conversation reverted", {
        description: `Put prompt back into composer and removed ${deleted} message${deleted > 1 ? 's' : ''}`,
        duration: 5000,
        action: {
          label: "Undo",
          onClick: () => {
            setMessages(_prev => {
              persistMessages(sessionId, originalMessages);
              return originalMessages;
            });
            setInput(originalInput);
          }
        }
      });
    }, 300);
  };

  // ── Edit: replace message content, remove everything after ──
  const handleEdit = (index: number, newText: string) => {
    if (streaming) return;
    if (!newText.trim()) return;
    const msg = messages[index];
    if (!msg || msg.role !== 'user') return;
    const nextCount = messages.length - index - 1;
    if (nextCount > 0 && !confirm(`Editing this message will remove ${nextCount} follow-up message${nextCount > 1 ? 's' : ''}. Continue?`)) return;
    setMessages(prev => {
      const current = prev[index];
      if (!current || current.role !== 'user') return prev;
      const next = prev.slice(0, index).concat({ ...current, content: newText.trim() });
      persistMessages(sessionId, next);
      return next;
    });
  };

  // ── Regenerate: remove assistant response, re-send user message ──
  const handleRegenerate = async (index: number) => {
    if (streaming) return;
    // Find the user message before this assistant message
    let userIndex = index;
    for (let i = index; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userIndex = i;
        break;
      }
    }
    const msg = messages[userIndex];
    if (!msg || msg.role !== 'user') return;
    const trimmed = messages.slice(0, userIndex + 1);
    setMessages(trimmed);
    persistMessages(sessionId, trimmed);
    await generateAIResponse([msg]);
  };

  // ── Clarify: queue the user's answer to a clarifying question ──
  const handleClarifyAnswer = useCallback((msgId: string, answer: string) => {
    if (sessionId) {
      // Feed the answer back to the model as a queued user message; the
      // backend drains it and the model continues from there.
      void queueWorkbenchMessage(sessionId, answer);
    }
    // Mark the question answered locally so the ClarifyTool popup dismisses.
    setMessages(prev => prev.map(msg =>
      msg.id === msgId ? { ...msg, clarify: { ...(msg.clarify ?? {}), answer } } : msg
    ));
  }, [sessionId, setMessages]);

  const insertMention = (item: MentionItem) => {
    setMentionQuery(null);
    setShowToolsDropdown(false);
    // Skills: load full skill card into composer (same as /load <name>).
    if (item.kind === 'skill') {
      // Drop the partial @query token before the load handler rewrites input.
      const ta = taRef.current;
      const value = ta?.value ?? input;
      const cursor = ta?.selectionStart ?? value.length;
      const parsed = parseAtMention(value, cursor);
      if (parsed) {
        setInput(value.slice(0, parsed.start) + value.slice(cursor));
      }
      voiceCommandEvents.emit({ type: 'load-skill', skillName: item.name });
      return;
    }
    const ta = taRef.current;
    const value = ta?.value ?? input;
    const cursor = ta?.selectionStart ?? value.length;
    const parsed = parseAtMention(value, cursor);
    const start = parsed?.start ?? mentionStart;
    const end = cursor;
    const next = value.slice(0, start) + item.insert + value.slice(end);
    setInput(next);
    setTimeout(() => {
      if (!ta) return;
      ta.focus();
      const pos = start + item.insert.length;
      ta.selectionStart = ta.selectionEnd = pos;
    }, 50);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionsDropdown && mentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const item = mentionItems[highlightedMentionIndex] ?? mentionItems[0];
        if (item) insertMention(item);
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const item = mentionItems[highlightedMentionIndex] ?? mentionItems[0];
        if (item) insertMention(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (showCommandsDropdown) {
      const allCommands = getDisplayCommands();
      const visible = allCommands.filter(c => {
        const q = input.trim().toLowerCase();
        if (!q) return true;
        return c.name.toLowerCase().startsWith(q);
      });
      // highlightedCommandIndex = (i ± 1) % visible.length
      if (e.key === 'ArrowDown') { e.preventDefault(); /* highlightedCommandIndex = (i + 1) % visible.length */ setHighlightedCommandIndex(i => (i + 1) % Math.max(1, visible.length)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); /* highlightedCommandIndex = (i - 1 + visible.length) % visible.length */ setHighlightedCommandIndex(i => (i - 1 + Math.max(1, visible.length)) % Math.max(1, visible.length)); return; }
      if (e.key === 'Enter' && !e.shiftKey && visible.length > 0) { e.preventDefault(); const cmd = visible[highlightedCommandIndex] ?? visible[0]; insertCommand(cmd.name); setShowCommandsDropdown(false); return; }
      if (e.key === 'Escape') { e.preventDefault(); setShowCommandsDropdown(false); return; }
    }
	    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  // Detect slash commands and @ skill/tool mentions as user types
  const handleInputChange = (value: string) => {
    setInput(value);
    setHighlightedCommandIndex(0);
    setHighlightedMentionIndex(0);
    // Show commands dropdown when text starts with /
    if (value.startsWith('/')) {
      setShowCommandsDropdown(true);
      setShowToolsDropdown(false);
      setMentionQuery(null);
      return;
    }
    if (showCommandsDropdown && !value.startsWith('/')) {
      setShowCommandsDropdown(false);
    }
    const ta = taRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const at = parseAtMention(value, cursor);
    if (at) {
      setMentionQuery(at.query);
      setMentionStart(at.start);
      setShowToolsDropdown(false);
      setShowCommandsDropdown(false);
    } else if (mentionQuery !== null) {
      setMentionQuery(null);
    }
  };

  // Composer features handlers

  const startVoiceInput = () => {
    if (voiceActive) return;
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      toast.error('Speech recognition not supported in this browser');
      return;
    }
    setVoiceActive(true);
    const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognition) return; // redundant runtime guard
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';

    recognition.onresult = (event) => {
      let interim = '';
      const results = event.results;
      for (let i = event.resultIndex; i < results.length; i++) {
        if (results[i].isFinal) {
          finalTranscript += results[i][0].transcript;
        } else {
          interim += results[i][0].transcript;
        }
      }
      if (finalTranscript || interim) {
        setInput(prev => {
          const space = prev.length > 0 && !prev.endsWith(' ') ? ' ' : '';
          return prev + space + finalTranscript + interim;
        });
      }
    };

    recognition.onend = () => {
      setVoiceActive(false);
      if (!finalTranscript) {
        toast.info('No speech detected');
        return;
      }

      // Voice Command Registry (Phase 1A): unified match → handler.
      // The handler either mutates state via the registry-event bus
      // (subscribed in a useEffect above) or runs no-op. We treat
      // any match above the registry threshold as "handled" and
      // clear the appended transcript from the input.
      const matched = voiceCommandRegistry.matchCommand(finalTranscript);
      if (matched) {
        try {
          // Same boundary cast as the slash-command path — see comment there.
          const handlerResult = matched.handler({
            sessionId: sessionId ?? '',
            transcript: finalTranscript,
            messages: messages as unknown as ChatMessageLite[],
            setMessages: setMessages as unknown as Dispatch<SetStateAction<ChatMessageLite[]>>,
          });
          // Fire-and-forget async handlers.
          void Promise.resolve(handlerResult).catch(err => {
             
            console.error('[voice] handler threw', err);
            toast.error('Voice command failed');
          });
          toast.success(`Command: ${matched.description || matched.id}`);
          setInput(prev => prev.replace(finalTranscript, '').trim());
          return;
        } catch (err) {
           
          console.error('[voice] handler threw synchronously', err);
          toast.error('Voice command failed');
        }
      }
      // No match (or below threshold): transcript stays as dictation.
    };

    recognition.onerror = (event) => {
      setVoiceActive(false);
      if (event.error !== 'no-speech') {
        toast.error(`Speech error: ${event.error}`);
      }
    };

    recognition.start();
  };

  const insertText = (text: string) => {
    const ta = taRef.current;
    if (!ta) {
      setInput(prev => prev + text);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const nextText = ta.value.substring(0, start) + text + ta.value.substring(end);
    setInput(nextText);
    setTimeout(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + text.length;
    }, 50);
  };

  const insertCommand = (name: string) => {
    // Replace the leading /token (if any) so the typed `/` doesn't double up.
    const fullCmd = name + ' ';
    const ta = taRef.current;
    if (!ta) {
      setInput(_prev => {
        return '/' + name + ' ';
      });
      return;
    }
    const cursor = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, cursor);
    const match = before.match(/\/[\w-]*$/);
    const tokenStart = match ? cursor - match[0].length : cursor;
    const after = ta.value.slice(cursor);
    const nextText = ta.value.slice(0, tokenStart) + fullCmd + after;
    setInput(nextText);
    setTimeout(() => {
      ta.focus();
      const newCursor = tokenStart + fullCmd.length;
      ta.selectionStart = ta.selectionEnd = newCursor;
    }, 50);
  };

  useEffect(() => {
    const handleInsertText = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      if (customEvent.detail) {
        insertText(customEvent.detail);
      }
    };
    window.addEventListener('august-insert-composer-text', handleInsertText);

    // Handle model selection from ModelPickerCard (Phase 1C).
    const handleModelSelected = (e: Event) => {
      const { modelId, provider } = (e as CustomEvent<{ modelId?: string; provider?: string }>).detail ?? {};
      if (!modelId || !provider) return;
      const model = models.find(m => m.id === modelId);
      if (model) {
        setSelectedModel(model);
        userSelectedRef.current = model.id;
        try { localStorage.setItem('august_last_model', JSON.stringify(model)); } catch { /* silent */ }
        if (sessionId) updateSessionModel(sessionId, modelId, provider);
        toast.success(`Switched to ${model.name}`);
      }
    };
    window.addEventListener('august:model-selected', handleModelSelected);

    return () => {
      window.removeEventListener('august-insert-composer-text', handleInsertText);
      window.removeEventListener('august:model-selected', handleModelSelected);
    };
  }, [models, sessionId]);

  // Command palette / ui-action: undo, compact, branch, guard mode
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
            // Copy current UI messages into the new session storage
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
    activeSession?.workbenchSessionId,
    activeSession?.workspacePath,
  ]);
  const renderComposerContent = () => {
    return (
      <div className="relative" ref={composerRootRef}>
        {/* Tools / Skills @ mention dropdown — button open or typing @ */}
        {(showToolsDropdown || showMentionsDropdown) && toolsPos && createPortal(
          <div
            data-composer-popover
            data-testid="mention-picker"
            style={{ position: 'fixed', top: toolsPos.top, left: toolsPos.left, transform: 'translateY(-100%)' }}
            className="z-50 w-80 max-h-72 overflow-auto bg-card border border-border shadow-2xl rounded-xl p-1.5 space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150"
          >
            <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold flex items-center justify-between">
              <span>Skills &amp; tools</span>
              {skillsLoading && <Loader2 className="size-3 animate-spin" />}
            </div>
            {mentionQuery !== null && mentionItems.length === 0 && !skillsLoading && (
              <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                No skills match “{mentionQuery}”. Try another name or pick a tool.
              </div>
            )}
            {(mentionQuery !== null ? mentionItems : [
              ...skillMentions.slice(0, 12),
              ...TOOLS.map((t) => ({
                kind: 'tool' as const,
                name: t.name,
                desc: t.desc,
                insert: `${t.name} `,
              })),
            ]).map((item, idx) => (
              <button
                key={`${item.kind}-${item.name}`}
                type="button"
                onClick={() => {
                  if (mentionQuery !== null) {
                    insertMention(item);
                  } else if (item.kind === 'skill') {
                    insertMention(item);
                  } else {
                    insertText(item.insert.trimEnd());
                    setShowToolsDropdown(false);
                  }
                }}
                className={cn(
                  'w-full text-left rounded-md px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition flex items-center justify-between gap-2',
                  mentionQuery !== null && idx === highlightedMentionIndex && 'bg-muted',
                )}
              >
                <span className="font-mono font-medium text-primary truncate">
                  {item.kind === 'skill' ? `@${item.name}` : item.name}
                </span>
                <span className="text-[10px] text-muted-foreground truncate max-w-[50%]">
                  {item.kind === 'skill' ? `skill · ${item.desc}` : item.desc}
                </span>
              </button>
            ))}
            {mentionQuery === null && skillMentions.length === 0 && !skillsLoading && (
              <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
                Type <span className="font-mono text-foreground/80">@</span> to search skills, or pick a tool below.
              </div>
            )}
          </div>,
          document.body,
        )}

        {/* Commands Dropdown — triggered by typing /, portaled to body */}
        {showCommandsDropdown && commandsPos && createPortal(
          <div
            data-composer-popover
            style={{ position: 'fixed', top: commandsPos.top, left: commandsPos.left, transform: 'translateY(-100%)' }}
            className="z-50 w-72 bg-card border border-border shadow-2xl rounded-xl p-1.5 space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150"
          >
            <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold">Commands & Tools</div>
            {getDisplayCommands().filter(c => {
              const q = input.trim().toLowerCase().split(/\s+/)[0];
              if (!q) return true;
              return c.name.toLowerCase().startsWith(q);
            }).map((c, idx) => (
              <button
                key={c.name}
                onClick={() => {
                  insertCommand(c.name);
                  setShowCommandsDropdown(false);
                }}
                className={cn(
                  "w-full text-left rounded-md px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition flex items-center justify-between gap-2",
                  idx === highlightedCommandIndex && "bg-muted"
                )}
              >
                <span className="font-mono font-medium text-warning shrink-0">{c.name}</span>
                <span className="text-[10px] text-muted-foreground truncate">{c.desc}</span>
              </button>
            ))}
            {getDisplayCommands().filter(c => {
              const q = input.trim().toLowerCase().split(/\s+/)[0];
              if (!q) return false;
              return c.name.toLowerCase().startsWith(q);
            }).length === 0 && input.trim() && (
              <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground">No matching command. Press Enter to send as a normal message.</div>
            )}
          </div>,
          document.body,
        )}

        {/* Queued message pills — reorderable, editable, clear-all.
            Shown above the composer while follow-ups wait mid-response. */}
        {queuedMessages.length > 0 && sessionId && (
          <QueuePills
            sessionId={sessionId}
            workbenchSessionId={
              workbenchSession?.id ||
              activeSession?.workbenchSessionId ||
              sessionId
            }
            items={queuedMessages}
          />
        )}
        {/* Empty-state tip while tools run with an empty queue */}
        {streaming && queuedMessages.length === 0 && (
          <div className="mb-1.5 px-1 text-[10px] text-muted-foreground/80 animate-in fade-in duration-150">
            Tip: type a direction while August works — it applies after the next tool step without stopping.
          </div>
        )}

        <div className={cn(
          'w-full min-w-0 rounded-2xl border bg-card shadow-sm transition focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary overflow-visible',
          'border-border',
        )}>
          {/* Workspace selector row - only show in fresh sessions (no messages) */}
          {messages.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/50">
              <WorkspaceSelector
                sessionId={sessionId}
                onWorkspaceChange={(ws) => {
                  if (!sessionId || !ws) return;
                  void import('@/store/sessions').then(({ createSession, $sessions }) => {
                    // Check if any existing session already uses this workspace path
                    const existing = $sessions.get().find(s => s.workspacePath === ws.path);
                    if (existing) {
                      // Workspace already linked — just switch to that session
                      window.location.href = `/c/${existing.id}`;
                    } else {
                      // New workspace — create a fresh session for it and navigate
                      const newSess = createSession(null, ws.name || 'New Chat', ws.path);
                      window.location.href = `/c/${newSess.id}`;
                    }
                  });
                }}
              />
            </div>
          )}

          {voiceActive ? (
            <div className="h-[128px] w-full flex flex-col items-center justify-center bg-background/90 backdrop-blur-sm space-y-2 text-foreground">
              <div className="flex items-center gap-1">
                <span className="w-1 h-4 bg-primary rounded animate-pulse" />
                <span className="w-1 h-6 bg-primary rounded animate-pulse" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-8 bg-primary rounded animate-pulse" style={{ animationDelay: '300ms' }} />
                <span className="w-1 h-5 bg-primary rounded animate-pulse" style={{ animationDelay: '450ms' }} />
                <span className="w-1 h-3 bg-primary rounded animate-pulse" style={{ animationDelay: '600ms' }} />
              </div>
              <span className="text-xs font-semibold tracking-wide text-primary animate-pulse">August is listening…</span>
            </div>
          ) : (
            <>
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 p-2 bg-muted/20 border-b border-border">
                  {attachments.map((file, i) => {
                    const fileIcon = getFileIcon(file.name);
                    const IconComponent = fileIcon.Icon;
                    return (
                      <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-muted border border-border text-[10.5px]">
                        <IconComponent size={12} color={fileIcon.color} />
                        <span className="font-mono truncate max-w-[150px]">{file.name}</span>
                        <button
                          onClick={() => removeAttachment(i)}
                          className="p-0.5 hover:bg-background rounded text-muted-foreground hover:text-foreground transition"
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="size-2.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => {
                  handleInputChange(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 360) + 'px';
                }}
                onKeyDown={onKey}
                onPaste={handleComposerPaste}
                placeholder={
                  streaming
                    ? 'Add a direction while August works… (applied after the next tool step)'
                    : 'Enter message… (use / for commands)'
                }
                rows={1}
                className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-xs outline-none placeholder:text-muted-foreground"
                style={{ minHeight: '64px', maxHeight: '360px' }}
              />

              {/* Preview surface retained as dead code for a future keyboard shortcut.
                  Toolbar toggle removed — showPreview stays false until re-wired. */}
              {showPreview && input.trim() && (
                <div
                  className="border-t border-border bg-muted/5 max-h-[240px] overflow-y-auto px-4 py-2 text-foreground/90"
                  aria-label="Message preview"
                  data-testid="composer-preview"
                >
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1.5 font-semibold">
                    Preview
                  </div>
                  <Markdown content={input} />
                </div>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-1.5 pb-1.5">
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <ToolBtn
                  Icon={Plus}
                  label="Composer actions"
                  className="h-8 w-8"
                  buttonRef={composerActionsTriggerRef}
                  onClick={() => {
                    setShowComposerActionsDropdown((value) => !value);
                    setShowToolsDropdown(false);
                    setShowCommandsDropdown(false);
                  }}
                />
                {showComposerActionsDropdown && composerActionsPos && createPortal(
                  <div
                    data-composer-popover
                    style={{ position: 'fixed', top: composerActionsPos.top, left: composerActionsPos.left, transform: 'translateY(-100%)' }}
                    className="z-50 w-44 bg-card border border-border rounded-xl shadow-2xl p-1.5"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        fileInputRef.current?.click();
                        setShowComposerActionsDropdown(false);
                      }}
                      className="w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted transition flex items-center justify-between"
                    >
                      <span>Attach file</span>
                      <Paperclip className="size-3.5 text-muted-foreground" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowToolsDropdown(true);
                        setMentionQuery('');
                        setMentionStart(input.length);
                        setShowCommandsDropdown(false);
                        setShowComposerActionsDropdown(false);
                        // Prefetch skills list for the open picker
                        if (skillMentions.length === 0) {
                          api
                            .get<{ skills: Array<{ name: string; description?: string; category?: string }> }>('/api/skills')
                            .then((data) => {
                              setSkillMentions(
                                (data.skills ?? []).slice(0, 30).map((s) => ({
                                  kind: 'skill' as const,
                                  name: s.name,
                                  desc: s.description || s.category || 'Skill',
                                  insert: `@skill:${s.name} `,
                                })),
                              );
                            })
                            .catch(() => undefined);
                        }
                      }}
                      className="w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted transition flex items-center justify-between"
                    >
                      <span>Mention skill / tool</span>
                      <AtSign className="size-3.5 text-muted-foreground" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        startVoiceInput();
                        setShowComposerActionsDropdown(false);
                      }}
                      className="w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted transition flex items-center justify-between"
                    >
                      <span>Voice input</span>
                      <Mic className="size-3.5 text-muted-foreground" />
                    </button>
                  </div>,
                  document.body,
                )}
              </div>

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
              <ProjectRulesBadge workspacePath={activeSession?.workspacePath} />
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
                onRefresh={() => { void handleRefreshModels(); }}
                onEditModels={() => setShowModelVisibility(true)}
                onSelect={(m) => {
                  if (!m) return;
                  setSelectedModel(m);
                  // Remember the user's explicit choice so background full-list load doesn't override it
                  userSelectedRef.current = m.id;
                  // Persist for instant restore on next page load and fallback sessions
                  try { localStorage.setItem('august_last_model', JSON.stringify(m)); } catch { /* silent */ }
                  // Scope the model to this session. The request payload also carries
                  // model/provider, so normal selection must not rewrite global backend config.
                  if (sessionId) updateSessionModel(sessionId, m.id, m.provider);
                }}
              />
              <EffortDropdown
                value={effort}
                onChange={setEffort}
              />

              {streaming ? (
                <>
                  <Button
                    onClick={() => { void send(); }}
                    disabled={!sessionId || loadedSessionId !== sessionId || (!input.trim() && attachments.length === 0)}
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
                <Button onClick={() => { void send(); }} disabled={!sessionId || loadedSessionId !== sessionId || (!input.trim() && attachments.length === 0)} size="sm">
                  <Send className="size-3" />
                  Send
                  <kbd className="ml-1 rounded bg-muted/20 border border-border/20 px-1 text-[10px] font-mono">↵</kbd>
                </Button>
              )}
            </div>
          </div>
        </div>

      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 relative w-full">
      <ChatCheckpoints
        messages={messages}
        scrollRef={scrollRef}
      />
      <div className="flex-1 flex flex-col min-w-0 bg-background h-full overflow-hidden relative">
        <ApprovalBanner sessionId={workbenchSession?.id ?? null} />
        <SavePointBanner workbenchSessionId={workbenchSession?.id ?? null} />
        <CollaborationInsights />
        {examActive && (
          <ExamHost
            topic={examSeed.topic}
            files={examSeed.files}
            model={typeof modelForRequest === 'string' ? modelForRequest : modelForRequest?.id || ''}
            provider={typeof modelForRequest === 'string' ? '' : modelForRequest?.provider || ''}
            onDismiss={() => {
              setExamActive(false);
              setExamSeed({});
            }}
          />
        )}
        {augPreview && (
          <div className="px-4 pt-3">
            <InitAugCard
              draft={augPreview.draft}
              existing={augPreview.existing}
              workspacePath={augPreview.workspacePath}
              sessionId={sessionId ?? undefined}
            />
          </div>
        )}
        {workbenchBtw && (
          <WorkbenchBtwDrawer
            result={workbenchBtw}
            onSend={(question) => {
              if (!sessionId) return;
              void (async () => {
                const active = workbenchSession || (activeSession?.workbenchSessionId ? {
                  id: activeSession.workbenchSessionId,
                  provider: activeSession.workbenchProvider || "",
                  agentId: activeSession.workbenchAgentId || "build",
                  agentRole: activeSession.workbenchAgentId || "build",
                  agentMode: "assistant",
                  approved: false,
                  approvedAt: null,
                  plan: null,
                  goal: null,
                  lastGoal: null,
                  messageCount: 0,
                  mutationCount: 0,
                  lastMutationAt: null,
                  updatedAt: new Date().toISOString(),
                  todos: [],
                } : null);
                if (!active) return;
                // Server uses this session's chat model (from the last chat turn).
                const result = await answerWorkbenchBtw({
                  sessionId: active.id,
                  question,
                });
                setWorkbenchBtw(result);
              })();
            }}
            onClose={() => setWorkbenchBtw(null)}
          />
        )}
        <div className="flex-grow flex flex-col min-h-0 relative">
          <AnimatePresence initial={false} mode="wait">
            {messages.length === 0 ? (
              <motion.div
                key="centered-layout"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, y: 20 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="flex-1 flex flex-col items-center justify-center px-6"
              >
                <div className="w-full max-w-3xl px-4 flex flex-col items-center gap-8">
                  {/* Project-aware heading */}
                  <h1 className="text-2xl font-semibold tracking-tight text-center text-foreground/90 mb-2">
                    What should we build in{' '}
                    <span className="text-muted-foreground font-mono">
                      {activeSession?.workspacePath
                        ? workspaceBaseName(activeSession.workspacePath)
                        : 'august-proxy'}
                    </span>
                    ?
                  </h1>

                  <div className="w-full max-w-lg rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-left text-xs text-muted-foreground space-y-2">
                    <p className="font-semibold text-foreground/80 text-[11px] uppercase tracking-wide">
                      How August works
                    </p>
                    <ol className="list-decimal list-inside space-y-1.5 leading-relaxed">
                      <li>
                        Pick a mode next to the box:{' '}
                        <span className="text-foreground/80">Plan only</span>,{' '}
                        <span className="text-foreground/80">Ask before changes</span>, or{' '}
                        <span className="text-foreground/80">Make changes</span>.
                      </li>
                      <li>
                        In Plan only, August proposes a plan — Accept or revise before it edits files.
                      </li>
                      <li>
                        Open the right panel for <span className="text-foreground/80">Plan</span>,{' '}
                        <span className="text-foreground/80">Tasks</span>, and{' '}
                        <span className="text-foreground/80">Diffs</span>.
                      </li>
                      <li>
                        Press{' '}
                        <kbd className="rounded border border-border bg-background px-1 font-mono text-[10px]">
                          Ctrl+K
                        </kbd>{' '}
                        for undo, branch chat, free memory, and more.
                      </li>
                    </ol>
                  </div>

                  {/* Composer or plan banner */}
                  <div className="w-full">
                    {planPending ? (
                      <PlanProposalBanner
                        workbenchSession={workbenchSession}
                        modelName={selectedModel?.name}
                        sending={streaming}
                        onOpenPlan={() => {
                          addRightDrawerSection('plan');
                          window.dispatchEvent(new CustomEvent('august:open-right-sidebar'));
                        }}
                        onAccept={() => {
                          void (async () => {
                            if (!workbenchSession) return;
                            try {
                              const updated = await approveWorkbenchPlan(workbenchSession.id);
                              setWorkbenchSession(updated);
                              if (sessionId) {
                                updateSessionWorkbenchMetadata(sessionId, {
                                  workbenchSessionId: updated.id,
                                  workbenchAgentId: updated.agentId,
                                  workbenchProvider: updated.provider,
                                });
                              }
                              // Tell the model the plan was accepted but should NOT proceed.
                              // Use the full streaming bundle so the chat thread
                              // renders the model's reply (thinking, text, tool
                              // calls) the same way a normal composer message does.
                              await streamPlanTurn((handlers, signal) => streamPlanDecision(workbenchSession.id, 'accept', handlers, signal));
                            } catch (e) {
                              const message = e instanceof Error ? e.message : String(e);
                              toast.error('Could not approve Workbench plan', { description: message });
                            }
                          })();
                        }}
                        onAcceptAndImplement={() => {
                          void (async () => {
                            if (!workbenchSession) return;
                            try {
                              const updated = await approveWorkbenchPlan(workbenchSession.id);
                              setWorkbenchSession(updated);
                              if (sessionId) {
                                updateSessionWorkbenchMetadata(sessionId, {
                                  workbenchSessionId: updated.id,
                                  workbenchAgentId: updated.agentId,
                                  workbenchProvider: updated.provider,
                                });
                              }
                              // Switch the guard mode to Full access so the model
                              // can proceed with implementation.
                              setWorkbenchMode('full');
                              // Tell the model to proceed with implementation at Full access.
                              await streamPlanTurn((handlers, signal) => streamPlanDecision(workbenchSession.id, 'accept-and-implement', handlers, signal));
                            } catch (e) {
                              const message = e instanceof Error ? e.message : String(e);
                              toast.error('Could not approve Workbench plan', { description: message });
                            }
                          })();
                        }}
                        onReject={() => {
                          void (async () => {
                            if (!workbenchSession) return;
                            try {
                              const updated = await rejectWorkbenchPlan(workbenchSession.id);
                              setWorkbenchSession(updated);
                              // Notify the model the plan was rejected.
                              await streamPlanTurn((handlers, signal) => streamPlanDecision(workbenchSession.id, 'reject', handlers, signal));
                            } catch (e) {
                              const message = e instanceof Error ? e.message : String(e);
                              toast.error('Could not reject Workbench plan', { description: message });
                            }
                          })();
                        }}
                        onRevise={handlePlanRevision}
                      />
                    ) : (
                      renderComposerContent()
                    )}
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="thread-scroll-view"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex-1 flex flex-col min-h-0 relative"
              >
                <div
                  ref={scrollRef}
                  className="flex-1 overflow-y-auto chat-scroll"
                  style={{ overflowAnchor: 'none' }}
                >
                  {/* Long threads virtualize; short ones use a plain map. */}
                  <VirtualizedMessageList
                    messages={messages}
                    scrollParentRef={scrollRef}
                    renderMessage={(m, realIndex) => {
                      const isReverting = revertingIndex !== null && realIndex > revertingIndex;
                      return (
                        <div
                          className={cn(
                            'transition-all duration-300 transform',
                            isReverting
                              ? 'opacity-0 -translate-y-4 pointer-events-none'
                              : 'opacity-100 translate-y-0',
                          )}
                        >
                          <MessageBubble
                            message={m}
                            isLast={realIndex === messages.length - 1}
                            streaming={streaming}
                            sessionId={sessionId ?? undefined}
                            modelId={selectedModel?.id}
                            onRevert={() => handleRevert(realIndex)}
                            onEdit={(text) => handleEdit(realIndex, text)}
                            onRegenerate={() => {
                              void handleRegenerate(realIndex);
                            }}
                            onClarifyAnswer={(ans) => handleClarifyAnswer(m.id, ans)}
                            toolProgress={toolProgress}
                            subagentPrompts={subagentPrompts}
                            subagentBlocks={subagentBlocks}
                          />
                        </div>
                      );
                    }}
                    footer={
                      <>
                        {streaming && <WorkingIndicator key={`aug-${sessionId ?? 'none'}`} />}
                        {modelPickerActive && (
                          <ModelPickerCard
                            sessionId={sessionId ?? ''}
                            onDismiss={() => setModelPickerActive(false)}
                            context={{ currentModelId: selectedModel?.id }}
                          />
                        )}
                      </>
                    }
                  />

                  {/* Scroll-to-top / scroll-to-bottom stack at the right edge */}
                  <div className="sticky bottom-4 z-30 flex flex-col gap-2 items-end pointer-events-none">
                    <ScrollToTopButton
                      scrollParentRef={scrollRef}
                      visible={scrolledFromTop}
                    />
                    <AnimatePresence>
                      {scrolledFromBottom && (
                        <motion.button
                          type="button"
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                          transition={{ duration: 0.2 }}
                          onClick={scrollToBottomSmooth}
                          className="pointer-events-auto mr-3 w-9 h-9 flex items-center justify-center rounded-full bg-background/80 backdrop-blur-sm border border-border shadow-sm text-muted-foreground hover:text-foreground hover:bg-background/95 transition-colors cursor-pointer"
                          aria-label="Scroll to bottom"
                        >
                          <ChevronDown className="size-4" />
                        </motion.button>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* When a plan is pending, the PlanProposalBanner replaces the
                    composer entirely so the user can only act on the plan. */}
                {planPending ? (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                    className="shrink-0 z-10 w-full bg-background py-3"
                  >
                    <PlanProposalBanner
                      workbenchSession={workbenchSession}
                      modelName={selectedModel?.name}
                      sending={streaming}
                      onOpenPlan={() => {
                        addRightDrawerSection('plan');
                        window.dispatchEvent(new CustomEvent('august:open-right-sidebar'));
                      }}
                        onAccept={() => {
                          void (async () => {
                            if (!workbenchSession) return;
                            try {
                              const updated = await approveWorkbenchPlan(workbenchSession.id);
                              setWorkbenchSession(updated);
                              if (sessionId) {
                                updateSessionWorkbenchMetadata(sessionId, {
                                  workbenchSessionId: updated.id,
                                  workbenchAgentId: updated.agentId,
                                  workbenchProvider: updated.provider,
                                });
                              }
                              // Tell the model the plan was accepted but should NOT proceed.
                              // Use the full streaming bundle so the chat thread
                              // renders the model's reply (thinking, text, tool
                              // calls) the same way a normal composer message does.
                              await streamPlanTurn((handlers, signal) => streamPlanDecision(workbenchSession.id, 'accept', handlers, signal));
                            } catch (e) {
                              const message = e instanceof Error ? e.message : String(e);
                              toast.error('Could not approve Workbench plan', { description: message });
                            }
                          })();
                        }}
                        onAcceptAndImplement={() => {
                          void (async () => {
                            if (!workbenchSession) return;
                            try {
                              const updated = await approveWorkbenchPlan(workbenchSession.id);
                              setWorkbenchSession(updated);
                              if (sessionId) {
                                updateSessionWorkbenchMetadata(sessionId, {
                                  workbenchSessionId: updated.id,
                                  workbenchAgentId: updated.agentId,
                                  workbenchProvider: updated.provider,
                                });
                              }
                              // Switch the guard mode to Full access so the model
                              // can proceed with implementation.
                              setWorkbenchMode('full');
                              // Tell the model to proceed with implementation at Full access.
                              await streamPlanTurn((handlers, signal) => streamPlanDecision(workbenchSession.id, 'accept-and-implement', handlers, signal));
                            } catch (e) {
                              const message = e instanceof Error ? e.message : String(e);
                              toast.error('Could not approve Workbench plan', { description: message });
                            }
                          })();
                        }}
                        onReject={() => {
                          void (async () => {
                            if (!workbenchSession) return;
                            try {
                              const updated = await rejectWorkbenchPlan(workbenchSession.id);
                              setWorkbenchSession(updated);
                              // Notify the model the plan was rejected.
                              await streamPlanTurn((handlers, signal) => streamPlanDecision(workbenchSession.id, 'reject', handlers, signal));
                            } catch (e) {
                              const message = e instanceof Error ? e.message : String(e);
                              toast.error('Could not reject Workbench plan', { description: message });
                            }
                          })();
                        }}
                        onRevise={handlePlanRevision}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                    className="shrink-0 z-10 w-full bg-background py-3"
                  >
                    <div className="mx-auto w-full max-w-3xl px-4">
                      {renderComposerContent()}
                    </div>
                  </motion.div>
                )}

              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Hidden File Input */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={(e) => { void handleFileUpload(e); }}
          multiple
          className="hidden"
        />

        {/* Model Visibility Modal */}
        <ModelVisibilityModal
          open={showModelVisibility}
          onClose={() => setShowModelVisibility(false)}
          models={models}
          loading={modelsLoading}
          hiddenModels={hiddenModels}
          onToggleModel={toggleModelVisibility}
          onNavigate={(p) => {
            window.location.href = p;
          }}
          onRefreshModels={() => { void handleRefreshModels(); }}
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
// ThinkingDisclosure — auto-open while streaming
// ----------------------------------------------------

function buildDemoThread(sessionId: string | null): ChatMessage[] {
  if (sessionId !== 'demo') return [];
  return mockChatThread.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    thinking: m.role === 'assistant' && m.id === 'm2'
      ? 'The user wants a full React 19 + Tauri 2 refactor. I need to assess the current codebase size, identify key pain points (like the Providers tab bug), and plan a phased migration. Starting with codebase inspection...'
      : m.role === 'assistant' && m.id === 'm3'
      ? 'Found 12 vanilla JS sections, no build step, and a hoisting bug in the Providers tab. The bug is a ReferenceError in init.js caused by loadProviderList being hoisted incorrectly — easy fix but requires careful testing since there are no unit tests.'
      : undefined,
    thinkingDuration: m.role === 'assistant' && m.id === 'm2'
      ? 3.4
      : m.role === 'assistant' && m.id === 'm3'
      ? 1.2
      : undefined,
  }));
}

/* Long-message threshold used by the user bubble's collapse/expand toggle.
 * AI bubbles intentionally don't collapse — they always render in full. */

