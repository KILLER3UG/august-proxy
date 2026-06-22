/* ── Chat thread ─────────────────────────────────────────────────────── */
/* The main view. User/assistant messages with proper avatars + bubbles.  */
/* Tool calls render as inline cards. Right rail optional.                  */

import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, type KeyboardEvent } from 'react';
import { Send, Paperclip, Mic, AtSign, Plus, Sparkles, ChevronRight, ChevronDown, Wrench, Check, AlertCircle, StopCircle, X, Zap, HelpCircle, Loader2, Bug, Play, Pause, RefreshCw } from 'lucide-react';
import { cn, formatClockTime } from '@/lib/utils';
import { mockChatThread } from '@/lib/mock';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useStore } from '@nanostores/react';
import { createPortal } from 'react-dom';
import { $sessions, setSessionStatus, clearSessionStatus, renameSession, updateSessionModel, updateSessionWorkbenchMetadata, type Session } from '@/store/sessions';
import { motion, AnimatePresence } from 'framer-motion';
import { ThinkingDisclosure } from '@/components/chat/ThinkingDisclosure';
import { ToolCallItem as ToolCallItemComp } from '@/components/chat/ToolCallItem';
import { ToolIcon as NewToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon as NewFileIcon } from '@/components/ui/FileIcon';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { ClarifyTool } from '@/components/chat/ClarifyTool';
import { PromptDisclosure } from '@/components/chat/PromptDisclosure';
import { applyToolProgress, visibleProgress, type ToolProgressEvent } from '@/lib/tool-progress';
import { getToolLabel } from '@/lib/tool-labels';
import { WorkingIndicator } from '@/components/chat/WorkingIndicator';
import { SubagentBlock } from '@/components/chat/SubagentBlock';
import { ModelVisibilityModal, loadHiddenModels, saveHiddenModels } from '@/components/overlays/ModelVisibilityModal';
import { ApprovalBanner } from '@/components/overlays/ApprovalBanner';
import { Statusbar } from '@/components/shell/Statusbar';
import { dispatchFocusComposer, dispatchInsertComposerText } from '@/api/ui-events';
import { chatRuntime, type ChatTurnRecord } from './chat-runtime';
import {
  $sessionStreamStates,
  getOrInitSessionStreamState,
  updateSessionStreamState,
  startChatStream,
  stopChatStream,
  syncActiveStreams,
  ensureSessionSubscriber,
  appendBlockEvent,
  applySubagentEvent,
  activeStreamControllers,
} from './chat-stream-manager';
import { Markdown } from './ChatMarkdown';
import { makeStreamHandlers } from './makeStreamHandlers';
import {
  createWorkbenchSession,
  streamWorkbenchChat,
  confirmWorkbenchMutation,
  approveWorkbenchPlan,
  rejectWorkbenchPlan,
  setWorkbenchGuardMode,
  streamPlanDecision,
  streamWorkbenchRevision,
  streamWorkbenchReconnect,
  answerWorkbenchBtw,
  getWorkbenchSession,
  listWorkbenchCapabilities,
} from '@/api/workbench';
import type { WorkbenchBtwResult, WorkbenchSession } from '@/types/workbench';
import { WorkbenchBtwDrawer } from '@/components/chat/WorkbenchBtwDrawer';
import { WorkbenchModeSelector, WORKBENCH_GUARD_MODES, applyWorkbenchGuardMode, type WorkbenchGuardMode } from '@/components/chat/WorkbenchModeSelector';
import { ContextRing, estimateContextBreakdown, type ContextBreakdown } from './ChatComposer';
import { PlanProposalBanner } from '@/components/shell/PlanProposalBanner';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';
import { ChangedFilesCard } from '@/components/chat/ChangedFilesCard';
import { gitApi, type GitDiffResult } from '@/api/git';

let visibleSessionId: string | null = null;
let visibleGeneration = 0;

const STREAM_UPDATE_INTERVAL_MS = 24;

export interface MessageBlock {
  id: string;
  type: 'thinking' | 'tool_call' | 'command' | 'final_output';
  content?: string;
  tool?: {
    id: string;
    name: string;
    context?: string;
    args?: string;
    preview?: string;
    summary?: string;
    error?: string;
    status: 'running' | 'done' | 'error';
    duration?: number;
    startedAt?: number;
    pendingApproval?: {
      message?: string;
      detail?: string;
      confirmationToken?: string;
    };
  };
  isRevisedPlan?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string;
  tool?: {
    name: string;
    args?: string;
    status: 'running' | 'done' | 'error';
    duration?: number;
    result?: string;
  };
  tools?: Array<{
    name: string;
    context?: string;
    id: string;
    status: 'running' | 'done' | 'error';
    summary?: string;
    error?: string;
    preview?: string;
    duration?: number;
    startedAt?: number;
  }>;
  thinking?: string;
  thinkingDuration?: number;
  /** Hoisted todo panel */
  todos?: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  }>;
  /** Inline Workbench mutation summary shown after the final response. */
  changedFiles?: GitDiffResult;
  /** Inline clarify/question */
  clarify?: {
    question?: string;
    choices?: string[];
    /** Multi-question flow; wins over the legacy `question`/`choices` when present. */
    questions?: Array<{ question: string; choices?: string[] }>;
    /** 0-indexed; managed by the popup. */
    currentIndex?: number;
    /** Header line above the question (e.g. "Synthesized user context to craft …"). */
    contextSummary?: string;
    answer?: string;
  };
  blocks?: MessageBlock[];
}

interface ModelItem {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  isFree?: boolean;
  supportsReasoning?: boolean;
  supportsThinking?: boolean;
}



export function modelFromSession(session: Pick<Session, 'model' | 'provider'> | null): ModelItem | null {
  if (!session?.model) return null;
  return {
    id: session.model,
    name: session.model,
    provider: session.provider || '',
    contextWindow: 128000,
    supportsReasoning: isLikelyReasoningModel(session.model),
    supportsThinking: isLikelyReasoningModel(session.model),
  };
}

function loadLastModel(): ModelItem | null {
  try {
    const saved = localStorage.getItem('august_last_model');
    return saved ? JSON.parse(saved) as ModelItem : null;
  } catch {
    return null;
  }
}

const VARIANT_TAGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-fast$/i, 'Fast'],
  [/-thinking$/i, 'Thinking'],
  [/-preview$/i, 'Preview'],
  [/-latest$/i, 'Latest'],
  [/-free$/i, 'Free'],
];

const titleCase = (text: string): string => text.replace(/\b\w/g, c => c.toUpperCase()).trim();

const prettifyBase = (base: string): string => {
  if (/^claude-/i.test(base)) return titleCase(base.replace(/^claude-/i, '').replace(/-/g, ' '));
  if (/^gpt-/i.test(base)) return base.replace(/^gpt-/i, 'GPT-');
  if (/^gemini-/i.test(base)) return base.replace(/^gemini-/i, 'Gemini ').replace(/-/g, ' ');
  if (/^deepseek-/i.test(base)) return titleCase(base.replace(/^deepseek-/i, 'DeepSeek '));
  if (/^llama-/i.test(base)) return titleCase(base.replace(/^llama-/i, 'Llama '));
  if (/^qwen-/i.test(base) || /^qwq-/i.test(base)) return titleCase(base.replace(/-/g, ' '));
  if (/^mistral-/i.test(base)) return titleCase(base.replace(/^mistral-/i, 'Mistral '));
  if (/^minimax-/i.test(base)) return titleCase(base.replace(/^minimax-/i, 'MiniMax '));
  return titleCase(base.replace(/-/g, ' '));
};

function stripProviderPrefix(id: string): string {
  const sepIdx = id.search(/[/:]/);
  return sepIdx >= 0 ? id.slice(sepIdx + 1) : id;
}

export function modelDisplayParts(id: string): { name: string; tag: string } {
  const sepIdx = id.search(/[/:]/);
  const base = stripProviderPrefix(id);
  let cleaned = base;

  for (const [pattern, label] of VARIANT_TAGS) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '');
      return { name: prettifyBase(cleaned) || id, tag: sepIdx >= 0 ? `${id.slice(0, sepIdx)}:${label}` : label };
    }
  }

  return { name: prettifyBase(cleaned) || id, tag: sepIdx >= 0 ? id.slice(0, sepIdx) : '' };
}

export function getModelDisplayName(id: string): string {
  return stripProviderPrefix(id);
}

export function isLikelyReasoningModel(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes('o1') ||
    lower.includes('o3') ||
    lower.includes('reasoner') ||
    lower.includes('thinking') ||
    lower.includes('claude-3-7') ||
    lower.includes('claude-sonnet-4') ||
    lower.includes('qwen3') ||
    lower.includes('qwq') ||
    lower.includes('minimax-m2')
  );
}

const TOOLS = [
  { name: '@web_search', desc: 'Search the web for context' },
  { name: '@read_file', desc: 'Read a local file contents' },
  { name: '@run_command', desc: 'Propose shell command execution' },
  { name: '@fetch_url', desc: 'Fetch web content' },
];

const COMMANDS = [
  { name: '/help', desc: 'Show available commands' },
  { name: '/btw', desc: 'Ask a by-the-way question: /btw <question>' },
  { name: '/goal', desc: 'Set a workbench goal: /goal <condition>' },
  { name: '/clear', desc: 'Clear the chat display' },
  { name: '/new', desc: 'Start a new chat session' },
  { name: '/reset', desc: 'Reset conversation history' },
  { name: '/debug', desc: 'Toggle diagnostics mode' },
  { name: '/model', desc: 'Switch model: /model <name>' },
  { name: '/provider', desc: 'Switch provider: /provider <name>' },
];

const MESSAGES_STORAGE_PREFIX = 'chat_messages_';
const COMPOSER_DRAFT_PREFIX = 'august_composer_draft_';

const messagesStorageKey = (sessionId: string | null) => sessionId ? `${MESSAGES_STORAGE_PREFIX}${sessionId}` : null;
const composerDraftStorageKey = (sessionId: string | null) => sessionId ? `${COMPOSER_DRAFT_PREFIX}${sessionId}` : null;

function loadMessagesForSession(sessionId: string | null): ChatMessage[] {
  const key = messagesStorageKey(sessionId);
  if (!key) return buildDemoThread(sessionId);

  try {
    const saved = localStorage.getItem(key);
    if (saved) return JSON.parse(saved);
  } catch {}

  return buildDemoThread(sessionId);
}

function loadComposerDraft(sessionId: string | null): string {
  const key = composerDraftStorageKey(sessionId);
  if (!key) return '';

  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function persistComposerDraft(sessionId: string | null, value: string) {
  const key = composerDraftStorageKey(sessionId);
  if (!key) return;

  try {
    localStorage.setItem(key, value);
  } catch {}
}

function clearComposerDraft(sessionId: string | null) {
  const key = composerDraftStorageKey(sessionId);
  if (!key) return;

  try {
    localStorage.removeItem(key);
  } catch {}
}

function persistMessages(sessionId: string | null, value: ChatMessage[]) {
  const key = messagesStorageKey(sessionId);
  if (!key) return;

  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function ChatThread({ sessionId }: { sessionId: string | null }) {
  const sessions = useStore($sessions);
  const activeSession = useMemo(() => sessions.find(s => s.id === sessionId), [sessions, sessionId]);
  const [streamState, setStreamState] = useState(() => getOrInitSessionStreamState(sessionId));

  useEffect(() => {
    const current = getOrInitSessionStreamState(sessionId);
    setStreamState(current);

    let lastState = current;
    const unsubscribe = $sessionStreamStates.subscribe((states) => {
      const next = states[sessionId || ''] || getOrInitSessionStreamState(sessionId);
      if (next !== lastState) {
        lastState = next;
        setStreamState(next);
      }
    });
    return unsubscribe;
  }, [sessionId]);

  const messages = streamState.messages;
  const setMessages = (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    if (!sessionId) return;
    updateSessionStreamState(sessionId, prev => {
      const next = typeof updater === 'function' ? updater(prev.messages) : updater;
      persistMessages(sessionId, next);
      return { messages: next };
    });
  };

  const [input, setInput] = useState(() => loadComposerDraft(sessionId));
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(sessionId);
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const streaming = chatRuntime.isSessionStreaming(sessionId);
  // Sub-agent prompt disclosures, keyed by the parent tool_use id. The
  // backend emits a `prompt` SSE event only for august__spawn_subagent /
  // august__run_team calls (and only for the sub-agents they spawn); we
  // store those payloads here so each one can be rendered directly under
  // the matching tool call block. Cleared on each new turn.
  const subagentPrompts = streamState.subagentPrompts;
  const setSubagentPrompts = (updater: any) => {
    if (!sessionId) return;
    updateSessionStreamState(sessionId, prev => {
      const next = typeof updater === 'function' ? updater(prev.subagentPrompts) : updater;
      return { subagentPrompts: next };
    });
  };
  // Live sub-agent containers (jobId → SubagentBlockState). Independent of
  // the per-turn reducer — driven by the per-session SSE subscriber so
  // background sub-agents surface in the chat thread even when no per-turn
  // handler is active.
  const subagentBlocks = streamState.subagentBlocks || new Map();
  // Live tool-progress state: per-tool-id list of { path, status: 'reading' | 'read' }
  // entries, used to render the "Reading X" / "Read X" sub-list under
  // in-flight tool calls. Reset on each new turn.
  const toolProgress = streamState.toolProgress;
  const setToolProgress = (updater: any) => {
    if (!sessionId) return;
    updateSessionStreamState(sessionId, prev => {
      const next = typeof updater === 'function' ? updater(prev.toolProgress) : updater;
      return { toolProgress: next };
    });
  };
  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(loadHiddenModels);
  const [showModelVisibility, setShowModelVisibility] = useState(false);
  const workbenchSession = streamState.workbenchSession;
  const setWorkbenchSession = (session: any) => {
    if (!sessionId) return;
    updateSessionStreamState(sessionId, () => ({ workbenchSession: session }));
  };

  // Whether a plan is awaiting the user's decision. When true, the composer
  // is replaced by the PlanProposalBanner so the user can only act on the
  // plan (reject / revise / accept) — no new chat message can be sent.
  const planPending = !!workbenchSession?.plan && !workbenchSession?.approved && !workbenchSession?.approvedAt;
  const [workbenchToolCount, setWorkbenchToolCount] = useState<number | null>(null);
  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchGuardMode>(() => {
    const saved = localStorage.getItem('august_last_workbench_guard_mode') as WorkbenchGuardMode | null;
    return saved && WORKBENCH_GUARD_MODES[saved] ? saved : 'plan';
  });
  const workbenchBtw = streamState.workbenchBtw;
  const setWorkbenchBtw = (btw: any) => {
    if (!sessionId) return;
    updateSessionStreamState(sessionId, () => ({ workbenchBtw: btw }));
  };

  const toggleModelVisibility = (modelId: string) => {
    setHiddenModels(prev => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      saveHiddenModels(next);
      return next;
    });
  };

  const visibleModels = useMemo(() => models.filter(m => !hiddenModels.has(m.id)), [models, hiddenModels]);
  // Initialise from the active session first so model state is scoped per chat.
  // localStorage is only a fallback for sessions without a saved model.
  const [selectedModel, setSelectedModel] = useState<ModelItem | null>(() => {
    return modelFromSession(activeSession || null) || loadLastModel();
  });
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>(() => {
    try {
      const saved = localStorage.getItem('august_last_effort');
      if (saved && ['low', 'medium', 'high', 'max'].includes(saved)) {
        return saved as 'low' | 'medium' | 'high' | 'max';
      }
    } catch {}
    return 'medium';
  });
  const [revertingIndex, setRevertingIndex] = useState<number | null>(null);

  // Composer tools states
  const [attachments, setAttachments] = useState<{ name: string; size: string }[]>([]);
  const [voiceActive, setVoiceActive] = useState(false);
  const [showComposerActionsDropdown, setShowComposerActionsDropdown] = useState(false);
  const [showToolsDropdown, setShowToolsDropdown] = useState(false);
  const [showCommandsDropdown, setShowCommandsDropdown] = useState(false);
  const [queuedMessage, setQueuedMessage] = useState<{ text: string; attachments: { name: string; size: string }[] } | null>(null);

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
    if (!showToolsDropdown) {
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
  }, [showToolsDropdown]);

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

  // Outside-click + Escape handlers for the three composer dropdowns.
  useEffect(() => {
    const anyOpen = showComposerActionsDropdown || showToolsDropdown || showCommandsDropdown;
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
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowComposerActionsDropdown(false);
        setShowToolsDropdown(false);
        setShowCommandsDropdown(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showComposerActionsDropdown, showToolsDropdown, showCommandsDropdown]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const [scrolledFromBottom, setScrolledFromBottom] = useState(false);

  const scrollToBottomSmooth = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollable = el.closest(".overflow-y-auto") as HTMLElement | null;
    const target = scrollable ?? el;
    target.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
  }, []);

  // Track whether the user has scrolled up from the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollable = el.closest(".overflow-y-auto") as HTMLElement | null ?? el;
    const check = () => {
      const atBottom = scrollable.scrollHeight - scrollable.scrollTop - scrollable.clientHeight < 1;
      setScrolledFromBottom(!atBottom);
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
    const scrollable = el.closest('.overflow-y-auto') as HTMLElement | null;
    const target = scrollable ?? el;
    target.scrollTop = target.scrollHeight;
  }, []);

  const isTurnVisible = (turnSessionId: string | null) => mountedRef.current && visibleSessionId === turnSessionId;

  const finishTurn = (turn: ChatTurnRecord, status: 'done' | 'error' | 'aborted' = 'done') => {
    chatRuntime.finishTurn(turn.turnId, status);
  };

  const abortTurn = (turn: ChatTurnRecord) => {
    chatRuntime.abortTurn(turn.turnId);
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
      return;
    }

    let cancelled = false;
    listWorkbenchCapabilities()
      .then(({ totalTools }) => {
        if (!cancelled && Number.isFinite(totalTools)) {
          setWorkbenchToolCount(totalTools);
        }
      })
      .catch(() => {
        if (!cancelled) setWorkbenchToolCount(null);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => chatRuntime.subscribe(() => setRuntimeVersion((value) => value + 1)), []);



  useEffect(() => {
    visibleSessionId = sessionId;
  }, [sessionId]);

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
    try { localStorage.setItem('august_last_effort', effort); } catch {}
  }, [effort]);

  useEffect(() => {
    try { localStorage.setItem('august_last_workbench_guard_mode', workbenchMode); } catch {}
  }, [workbenchMode]);

  // Track whether the user manually changed the model so we don't override it when the full list loads
  const userSelectedRef = useRef<string | null>(null);

  // Keep the dropdown anchored to the active session's saved model. This is the
  // per-session fix: model selection in session A must not be overwritten by the
  // global backend model when the user visits session B.
  useEffect(() => {
    if (!sessionId || !activeSession?.model) return;
    userSelectedRef.current = activeSession.model;
    setSelectedModel(prev => {
      if (prev?.id === activeSession.model && prev.provider === activeSession.provider) return prev;
      return modelFromSession(activeSession || null) || prev;
    });
  }, [sessionId, activeSession?.model, activeSession?.provider]);

  // ── Two-phase model loading ───────────────────────────────────────
  // Phase 1 (instant): read config only — fast, small payload.
  //   Sets selectedModel immediately so the button renders with the right label.
  // Phase 2 (background): fetch full model list — may be slow (5s per provider).
  //   Merges the list into state; only updates selectedModel if the user hasn't
  //   manually picked something in the meantime.
  const handleRefreshModels = useCallback(async (isRefresh = false) => {
    setModelsLoading(true);

    // ── Phase 1: quick config fetch ──
    if (!isRefresh) {
      try {
        const configRes = await fetch('/ui/config/safe');
        if (configRes.ok) {
          const config = await configRes.json();
          const activeProvider = config?.activeProvider || 'opencode-go';
          const pConfig = config?.[activeProvider] || {};
          const activeModelId: string | null = pConfig.model || pConfig._upstreamModel || pConfig.currentModel || null;
          if (activeModelId && !userSelectedRef.current) {
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
        }
      } catch (e) {
        console.warn('[Models] Config fetch failed, using localStorage fallback:', e);
      }
    }

    // ── Phase 2: full model list (background) ──
    try {
      // Fetch providers to know which ones have keys
      const providersRes = await fetch('/api/config/activeProvider');
      const availableProviders = new Set<string>();
      if (providersRes.ok) {
        const provData = await providersRes.json();
        (provData.providers || []).forEach((p: any) => {
          if (p.isAvailable) availableProviders.add(p.id);
        });
      }

      const modelsRes = await fetch('/api/models');
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        const allModels: ModelItem[] = data?.models || [];
        // Filter to only show models from providers with keys set,
        // but always include user-defined alias models.
        const loadedModels = availableProviders.size > 0
          ? allModels.filter(m => availableProviders.has(m.provider) || m.provider === 'Alias')
          : allModels;
        if (loadedModels.length > 0) {
          setModels(loadedModels);
          // Only update selected model if the user hasn't manually chosen one
          setSelectedModel(prev => {
            const targetId = userSelectedRef.current || prev?.id || null;
            if (!targetId) return loadedModels[0];
            const matched = loadedModels.find(
              m => m.id === targetId || m.id.toLowerCase() === targetId.toLowerCase()
            );
            return matched || prev || loadedModels[0];
          });
        }
      }
    } catch (e) {
      console.error('[Models] Full list fetch failed:', e);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    handleRefreshModels();
  }, [handleRefreshModels]);

  // Remove hardcoded fallback — rely on API only
  const currentModel = selectedModel || null;
  const modelForRequest = currentModel || modelFromSession(activeSession || null);


  const updateAssistantMessage = useCallback((
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
  }, [sessionId]);

  const createAssistantPlaceholder = (assistantMsgId: string): ChatMessage => ({
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString()
  });

  // Dynamic context usage tracker
  const maxContext = modelForRequest?.contextWindow || 128000;
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0) + input.length;
  const estTokens = Math.ceil(totalChars / 4) + 120;
  const pct = Math.min(100, Math.round((estTokens / maxContext) * 100));

  // Per-category breakdown for the ContextRing popup. The tool surface comes
  // from the backend capability endpoint; 30 is only a startup fallback.
  const toolCountForBreakdown = workbenchToolCount ?? 30;
  const contextBreakdown: ContextBreakdown = useMemo(
    () => estimateContextBreakdown({
      messages,
      input,
      toolCount: toolCountForBreakdown,
    }),
    [messages, input, toolCountForBreakdown]
  );

  // ── Workbench chat client ─────────────────────────────────────────
  // Workbench only accepts claude/codex engine ids. The normal provider/model
  // selector still controls regular model display, but Workbench routes codex
  // requests to codex and everything else to claude.
  const getWorkbenchProvider = () => modelForRequest?.provider === 'codex' ? 'codex' as const : 'claude' as const;

  const ensureWorkbenchSession = async () => {
    if (!sessionId) return null;
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
        return loaded;
      } catch {
        // The backend may have been restarted; create a fresh Workbench session below.
      }
    }

    const created = await createWorkbenchSession({
      provider: getWorkbenchProvider(),
      agentId: WORKBENCH_GUARD_MODES[workbenchMode].agentId,
      guardMode: workbenchMode,
    });
    setWorkbenchSession(created);
    updateSessionWorkbenchMetadata(sessionId, {
      workbenchSessionId: created.id,
      workbenchAgentId: created.agentId,
      workbenchProvider: created.provider,
    });
    return created;
  };

  useEffect(() => {
    syncActiveStreams(ensureWorkbenchSession);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncActiveStreams(ensureWorkbenchSession);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  /**
   * Helper for banner/panel click handlers. Wraps the streaming
   * infrastructure in one place so the four banner callbacks (and the
   * one panel callback) all share the exact same setup that the
   * composer uses in `generateAIResponse`. The `run` callback
   * receives the assembled handler bundle and is expected to start
   * the appropriate `stream*` call (e.g. `streamPlanDecision`).
   */
  const streamPlanTurn = async (
    run: (handlers: { onError?: (data: { message: string }) => void } & Record<string, any>, signal: AbortSignal) => Promise<any>,
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
      queuedMessage: null, // banner actions never queue
      setQueuedMessage,
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
      const startResult = await run(wrappedHandlers as any, abortController.signal);
      const wbSessionId = targetWorkbenchSessionId || workbenchSession?.id || sessionId;
      if (startResult && Number.isFinite((startResult as any).sinceSeq)) {
        await streamWorkbenchReconnect(
          wbSessionId,
          wrappedHandlers as any,
          abortController.signal,
          (startResult as any).sinceSeq
        );
      }
      finalize(abortController.signal.aborted ? 'aborted' : 'done');
    } catch (e: any) {
      if (e?.name === 'AbortError') {
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
    } catch (e: any) {
      toast.error('Could not send revision', { description: e.message });
    }
  };

  const generateAIResponse = async (chatHistory: ChatMessage[]) => {
    const turnSessionId = sessionId;
    if (!turnSessionId) return;
    if (!chatRuntime.canStartTurn(turnSessionId)) return;

    await startChatStream(turnSessionId, {
      message: applyWorkbenchGuardMode(workbenchMode, chatHistory.map(m => `${m.role}: ${m.content}`).join('\n\n') || ' '),
      chatHistory,
      workbenchMode,
      effort,
      model: modelForRequest?.id,
      modelProvider: modelForRequest?.provider,
      getWorkbenchProvider,
      ensureWorkbenchSession,
    });
  };

  // Click handler for the example-prompt cards in the empty state.
  // Inserts the prompt into the composer and focuses it.
  const handleExamplePrompt = (text: string) => {
    dispatchInsertComposerText(text);
    dispatchFocusComposer();
  };

  const send = async () => {
    if (!sessionId || loadedSessionId !== sessionId) return;

    let text = input.trim();
    if (!text && attachments.length === 0) return;

    if (attachments.length > 0) {
      const attachInfo = attachments.map(a => `[File Attachment: ${a.name} (${a.size})]`).join('\n');
      text = `${text}\n\n${attachInfo}`;
    }

    // Local slash command dispatch — handle purely client-side commands
    // before sending to the backend. The workbench backend intercepts
    // /btw and /goal at workbench.js:2334-2347 and answers them without
    // pushing a user message into the session, so we let those fall
    // through to the normal send path.
    const slashMatch = text.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
    if (slashMatch) {
      const cmd = slashMatch[1].toLowerCase();
      const arg = String(slashMatch[2] || '').trim();
      if (cmd === 'help') {
        const helpText = COMMANDS.map(c => `${c.name}  —  ${c.desc}`).join('\n');
        toast.info(`Available commands:\n\n${helpText}`, { duration: 12000 });
        return;
      }
      if (cmd === 'clear') {
        setMessages([]);
        persistMessages(sessionId, []);
        setInput('');
        setAttachments([]);
        setShowToolsDropdown(false);
        setShowCommandsDropdown(false);
        clearComposerDraft(sessionId);
        return;
      }
      if (cmd === 'new') {
        // Defer to the parent (App) to create a fresh chat session.
        // No listener wires this up yet, so just tell the user how.
        toast.info('Use the sidebar to start a new session.');
        return;
      }
      if (cmd === 'btw' && !arg) {
        toast.error('/btw needs a question. Try: /btw What does this codebase do?');
        return;
      }
      // /btw, /goal, /reset, /debug, /model, /provider, /unknown — fall
      // through and let the backend (or the workbench parser) handle it.
    }

    // Queue when streaming instead of dropping the message. The next turn
    // starts automatically from `finalize()` once the current turn ends.
    if (streaming) {
      setQueuedMessage({ text, attachments: [...attachments] });
      setInput('');
      setAttachments([]);
      setShowToolsDropdown(false);
      setShowCommandsDropdown(false);
      return;
    }

    const currentMessages = sessionId === loadedSessionId ? messages : loadMessagesForSession(sessionId);

    // Auto-generate title from the first user request. Skip slash commands
    // (e.g. "/debug …", "/model …") so the session isn't named after a
    // command, and collapse whitespace/newlines for a clean single-line title.
    if (currentMessages.length === 0 && sessionId) {
      const isCommand = /^\s*\/[a-zA-Z][\w-]*\b/.test(text);
      if (!isCommand) {
        const cleaned = text.replace(/\s+/g, ' ').trim();
        const title = cleaned.length > 50 ? cleaned.slice(0, 50).trim() + '…' : cleaned;
        if (title) renameSession(sessionId, title);
      }
    }

    // Save the selected model on this session only; do not change global defaults.
    if (sessionId && modelForRequest) {
      updateSessionModel(sessionId, modelForRequest.id, modelForRequest.provider);
    }

    setInput('');
    clearComposerDraft(sessionId);
    setAttachments([]);
    setShowToolsDropdown(false);
    setShowCommandsDropdown(false);

    const userMsg: ChatMessage = {
      id: `m${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString()
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
    if (sessionId) stopChatStream(sessionId);
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
            setMessages(prev => {
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

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // Detect slash commands as user types
  const handleInputChange = (value: string) => {
    setInput(value);
    // Show commands dropdown when text starts with /
    if (value.startsWith('/')) {
      setShowCommandsDropdown(true);
      setShowToolsDropdown(false);
    } else if (showCommandsDropdown && !value.startsWith('/')) {
      setShowCommandsDropdown(false);
    }
  };

  // Composer features handlers
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newAttachments = [...attachments];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const sizeStr = f.size > 1024 * 1024 
        ? `${(f.size / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.round(f.size / 1024)} KB`;
      newAttachments.push({ name: f.name, size: sizeStr });
    }
    setAttachments(newAttachments);
    if (e.target) e.target.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments(attachments.filter((_, i) => i !== index));
  };

  const startVoiceInput = () => {
    if (voiceActive) return;
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      toast.error('Speech recognition not supported in this browser');
      return;
    }
    setVoiceActive(true);
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
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
      }
    };

    recognition.onerror = (event: any) => {
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

  useEffect(() => {
    const handleInsertText = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail) {
        insertText(customEvent.detail);
      }
    };
    window.addEventListener('august-insert-composer-text', handleInsertText);
    return () => window.removeEventListener('august-insert-composer-text', handleInsertText);
  }, []);
  const renderComposerContent = () => {
    return (
      <div className="relative" ref={composerRootRef}>
        {/* Tools Dropdown — portaled to body to escape overflow:hidden chain */}
        {showToolsDropdown && toolsPos && createPortal(
          <div
            data-composer-popover
            style={{ position: 'fixed', top: toolsPos.top, left: toolsPos.left, transform: 'translateY(-100%)' }}
            className="z-50 w-64 bg-card border border-border shadow-2xl rounded-xl p-1.5 space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150"
          >
            <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold">Mention Tool</div>
            {TOOLS.map((t) => (
              <button
                key={t.name}
                onClick={() => {
                  insertText(t.name);
                  setShowToolsDropdown(false);
                }}
                className="w-full text-left rounded-md px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition flex items-center justify-between"
              >
                <span className="font-mono font-medium text-primary">{t.name}</span>
                <span className="text-[10px] text-muted-foreground">{t.desc}</span>
              </button>
            ))}
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
            {COMMANDS.filter(c => {
              const q = input.trim().toLowerCase();
              if (!q) return true;
              return c.name.toLowerCase().startsWith(q);
            }).map((c) => (
              <button
                key={c.name}
                onClick={() => {
                  insertText(c.name + ' ');
                  setShowCommandsDropdown(false);
                }}
                className="w-full text-left rounded-md px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition flex items-center justify-between gap-2"
              >
                <span className="font-mono font-medium text-warning shrink-0">{c.name}</span>
                <span className="text-[10px] text-muted-foreground truncate">{c.desc}</span>
              </button>
            ))}
            {COMMANDS.filter(c => {
              const q = input.trim().toLowerCase();
              if (!q) return false;
              return c.name.toLowerCase().startsWith(q);
            }).length === 0 && input.trim() && (
              <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground">No matching command. Press Enter to send as a normal message.</div>
            )}
          </div>,
          document.body,
        )}

        {/* Queued message pill — shown above the composer when a follow-up
            message is waiting for the current turn to finish. */}
        {queuedMessage && (
          <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-xl border border-warning/30 bg-warning/5 text-[11px] animate-in fade-in slide-in-from-bottom-1 duration-150">
            <span className="text-warning font-semibold uppercase tracking-wider">Queued</span>
            <span className="truncate text-muted-foreground flex-1 min-w-0">
              {queuedMessage.text.length > 120 ? queuedMessage.text.slice(0, 120).trim() + '…' : queuedMessage.text}
            </span>
            <button
              type="button"
              onClick={() => setQueuedMessage(null)}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition shrink-0"
              title="Cancel queued message"
              aria-label="Cancel queued message"
            >
              <X className="size-3" />
            </button>
          </div>
        )}

        <div className={cn(
          'w-full min-w-0 rounded-2xl border bg-card shadow-sm transition focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary overflow-visible',
          'border-border',
        )}>
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
                  {attachments.map((file, i) => (
                    <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-muted border border-border text-[10.5px] font-mono">
                      <span className="truncate max-w-[150px]">{file.name}</span>
                      <span className="text-[9px] text-muted-foreground">({file.size})</span>
                      <button
                        onClick={() => removeAttachment(i)}
                        className="p-0.5 hover:bg-background rounded text-muted-foreground hover:text-foreground transition"
                      >
                        <X className="size-2.5" />
                      </button>
                    </div>
                  ))}
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
                placeholder={streaming ? 'Type to queue your next message…' : (currentModel ? `Message ${modelDisplayParts(currentModel.id).name}…` : 'Type a message…')}
                rows={1}
                className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-xs outline-none placeholder:text-muted-foreground"
                style={{ minHeight: '64px', maxHeight: '360px' }}
              />
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
                        setShowCommandsDropdown(false);
                        setShowComposerActionsDropdown(false);
                      }}
                      className="w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted transition flex items-center justify-between"
                    >
                      <span>Mention tool</span>
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
                onChange={async (mode) => {
                  setWorkbenchMode(mode);
                  localStorage.setItem('august_last_workbench_guard_mode', mode);
                  if (workbenchSession?.id) {
                    setWorkbenchGuardMode(workbenchSession.id, mode).catch((error) => {
                      console.warn('[ChatThread] Failed to persist guard mode:', error);
                    });
                  }
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              <ContextRing
                pct={pct}
                estTokens={estTokens}
                maxContext={maxContext}
                modelName={modelForRequest?.name}
                size={18}
                breakdown={contextBreakdown}
              />
              <ModelDropdown
                models={models}
                visibleModels={visibleModels}
                loading={modelsLoading}
                selected={selectedModel}
                onRefresh={() => handleRefreshModels(true)}
                onEditModels={() => setShowModelVisibility(true)}
                onSelect={async (m) => {
                  if (!m) return;
                  setSelectedModel(m);
                  // Remember the user's explicit choice so background full-list load doesn't override it
                  userSelectedRef.current = m.id;
                  // Persist for instant restore on next page load and fallback sessions
                  try { localStorage.setItem('august_last_model', JSON.stringify(m)); } catch {}
                  // Scope the model to this session. The request payload also carries
                  // model/provider, so normal selection must not rewrite global backend config.
                  if (sessionId) updateSessionModel(sessionId, m.id, m.provider);
                }}
              />
              {selectedModel?.supportsReasoning && (
                <EffortDropdown
                  value={effort}
                  onChange={setEffort}
                />
              )}

              {streaming ? (
                <Button onClick={stop} size="sm" variant="outline">
                  <StopCircle className="size-3" /> Stop
                </Button>
              ) : (
                <Button onClick={send} disabled={!sessionId || loadedSessionId !== sessionId || (!input.trim() && attachments.length === 0)} size="sm">
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
        scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
      />
      <div className="flex-1 flex flex-col min-w-0 bg-background h-full overflow-hidden relative">
        <ApprovalBanner sessionId={workbenchSession?.id ?? null} />
        {workbenchBtw && (
          <WorkbenchBtwDrawer
            result={workbenchBtw}
            onSend={async (question) => {
              if (!sessionId) return;
              const active = workbenchSession || (activeSession?.workbenchSessionId ? {
                id: activeSession.workbenchSessionId,
                provider: activeSession.workbenchProvider || "claude",
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
              const result = await answerWorkbenchBtw({
                sessionId: active.id,
                question,
                provider: active.provider === "codex" ? "codex" : "claude",
                agentId: active.agentId,
              });
              setWorkbenchBtw(result);
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
                  {/* Hero wordmark + subtitle (Phase 3.1 design tokens) */}
                  <div
                    className="inline-flex size-16 rounded-2xl items-center justify-center mb-2 shadow-lg ring-1 ring-white/10"
                    style={{
                      backgroundImage:
                        'linear-gradient(135deg, var(--dt-brand-grad-from) 0%, var(--dt-brand-grad-to) 100%)',
                    }}
                  >
                    <Sparkles className="size-8 text-white" />
                  </div>
                  <h1 className="hero-display font-light text-foreground text-center">
                    August
                  </h1>
                  <p className="hero-subtitle text-muted-foreground max-w-md text-center">
                    Ask August anything. Same tools, memory, and skills as the CLI.
                    Press <kbd className="font-mono">⌘K</kbd> for commands.
                  </p>

                  {/* Example prompt cards */}
                  <div className="grid sm:grid-cols-2 gap-2 w-full">
                    {[
                      { title: 'Refactor the localhost UI', desc: 'Plan + implement a Tauri-based rewrite' },
                      { title: 'Diagnose why Providers tab is empty', desc: 'Investigate the loadProviderList hoisting bug' },
                      { title: 'Set up Tailwind v4 with @theme inline', desc: 'Migrate design tokens to the v4 way' },
                      { title: 'Add a settings overlay (Cmd+,)', desc: 'Replace 12 top-level routes with one panel' },
                    ].map((ex) => (
                      <button
                        key={ex.title}
                        onClick={() => handleExamplePrompt(ex.title)}
                        className="text-left rounded-lg border border-border/60 bg-card hover:bg-accent/30 hover:border-border transition px-4 py-3 group"
                      >
                        <p className="text-sm font-medium flex items-center gap-1 text-foreground">
                          {ex.title}
                          <ChevronRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">{ex.desc}</p>
                      </button>
                    ))}
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
                        onAccept={async () => {
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
                          } catch (e: any) {
                            toast.error('Could not approve Workbench plan', { description: e.message });
                          }
                        }}
                        onAcceptAndImplement={async () => {
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
                          } catch (e: any) {
                            toast.error('Could not approve Workbench plan', { description: e.message });
                          }
                        }}
                        onReject={async () => {
                          if (!workbenchSession) return;
                          try {
                            const updated = await rejectWorkbenchPlan(workbenchSession.id);
                            setWorkbenchSession(updated);
                            // Notify the model the plan was rejected.
                            await streamPlanTurn((handlers, signal) => streamPlanDecision(workbenchSession.id, 'reject', handlers, signal));
                          } catch (e: any) {
                            toast.error('Could not reject Workbench plan', { description: e.message });
                          }
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
                  className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none] [-ms-overflow-style:none]"
                  style={{ overflowAnchor: 'none' }}
                >
                  <div className="mx-auto w-full max-w-3xl px-4 py-8 space-y-5 relative">
                    {messages.map((m, i) => {
                      const isReverting = revertingIndex !== null && i > revertingIndex;
                      return (
                        <div
                          key={m.id}
                          className={cn(
                            "transition-all duration-300 transform",
                            isReverting ? "opacity-0 -translate-y-4 pointer-events-none" : "opacity-100 translate-y-0"
                          )}
                        >
                          <MessageBubble
                            message={m}
                            isLast={i === messages.length - 1}
                            streaming={streaming}
                            onRevert={() => handleRevert(i)}
                            onEdit={(text) => handleEdit(i, text)}
                            onRegenerate={() => handleRegenerate(i)}
                            toolProgress={toolProgress}
                            subagentPrompts={subagentPrompts}
                            subagentBlocks={subagentBlocks}
                          />
                        </div>
                      );
                    })}
                  </div>

                  {/* Scroll-to-bottom chevron at the right edge */}
                  <div className="sticky bottom-4 z-30 flex justify-end pointer-events-none">
                    <AnimatePresence>
                      {scrolledFromBottom && (
                        <motion.button
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
                        onAccept={async () => {
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
                          } catch (e: any) {
                            toast.error('Could not approve Workbench plan', { description: e.message });
                          }
                        }}
                        onAcceptAndImplement={async () => {
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
                          } catch (e: any) {
                            toast.error('Could not approve Workbench plan', { description: e.message });
                          }
                        }}
                        onReject={async () => {
                          if (!workbenchSession) return;
                          try {
                            const updated = await rejectWorkbenchPlan(workbenchSession.id);
                            setWorkbenchSession(updated);
                            // Notify the model the plan was rejected.
                            await streamPlanTurn((handlers, signal) => streamPlanDecision(workbenchSession.id, 'reject', handlers, signal));
                          } catch (e: any) {
                            toast.error('Could not reject Workbench plan', { description: e.message });
                          }
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
          onChange={handleFileUpload}
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
          onRefreshModels={() => handleRefreshModels(true)}
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
// ThinkingDisclosure — auto-open while streaming
// ----------------------------------------------------
function ReasoningBlock({ text, isGenerating, duration }: { text: string; isGenerating?: boolean; duration?: number }) {
  // Live-tick the elapsed time in the Thinking label while the model is
  // thinking. The interval stops as soon as this thinking section is done.
  const [elapsed, setElapsed] = useState<number>(0);
  useEffect(() => {
    if (!isGenerating) return;
    const startedAt = Date.now();
    const tick = () => setElapsed((Date.now() - startedAt) / 1000);
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [isGenerating]);

  return (
    <div className="my-1" style={{ overflowAnchor: 'none' }}>
      <ThinkingDisclosure
        pending={isGenerating}
        duration={duration}
        elapsed={isGenerating ? elapsed : undefined}
      >
        <div className="pl-3 border-l border-foreground/15 py-1 thought-content chat-thought-text">
          <Markdown content={text} />
        </div>
      </ThinkingDisclosure>
    </div>
  );
}

// ── Tool execution block ──
function ToolBlock({
  tools,
  toolProgress,
}: {
  tools: NonNullable<ChatMessage['tools']>;
  toolProgress: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
}) {
  return (
    <>
      {tools.map((tool) => (
        <ToolCallItemComp
          key={tool.id}
          tool={tool}
          progress={toolProgress.get(tool.id)}
        />
      ))}
    </>
  );
}

// ----------------------------------------------------
// MessageBubble
// ----------------------------------------------------
function MessageBubble({
  message,
  isLast,
  streaming,
  onRevert,
  onEdit,
  onRegenerate,
  onClarifyAnswer,
  toolProgress,
  subagentPrompts,
  subagentBlocks,
}: {
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  onRevert?: () => void;
  onEdit?: (text: string) => void;
  onRegenerate?: () => void;
  onClarifyAnswer?: (answer: string) => void;
  toolProgress?: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
  /** Sub-agent prompt disclosures keyed by the parent tool_use id. Only
   *  present for blocks whose tool name is august__spawn_subagent or
   *  august__run_team (and the team-run agents they spawn). The bubble
   *  renders each disclosure directly under its matching tool call. */
  subagentPrompts?: Map<string, {
    content: string;
    systemPrompt: string;
    userMessage: string;
    tokens: number;
    subagentId?: string;
    jobId?: string;
  }>;
  /** Live sub-agent containers keyed by jobId. Each container has the
   *  sub-agent's own blocks (thinking/text/tool_call/tool_result) and is
   *  rendered as a nested block under the matching parent tool_call.
   *  Independent of `subagentPrompts` so it survives tab switches and
   *  backend reconnects. */
  subagentBlocks?: Map<string, import('./chat-stream-manager').SubagentBlockState>;
}) {
  const [showActions, setShowActions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [copied, setCopied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const [showRaw, setShowRaw] = useState(false);
  const [userMsgExpanded, setUserMsgExpanded] = useState(false);

  const startEdit = () => {
    setEditText(message.content);
    setEditing(true);
  };

  const saveEdit = () => {
    if (editText.trim() && onEdit) onEdit(editText);
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditText('');
  };

  if (message.role === 'tool') {
    const toolKey = message.tool?.name ?? 'legacy';
    return (
      <ToolCallCard
        tool={message.tool!}
        timestamp={message.timestamp}
        progress={toolProgress?.get(toolKey)}
      />
    );
  }

  const isUser = message.role === 'user';

  const displayBlocks = useMemo(() => {
    if (isUser) return [];
    return getDisplayBlocks(message.blocks, message.thinking, message.tools, message.content);
  }, [message.blocks, message.thinking, message.tools, message.content, isUser]);
  const showPendingThinking = !isUser && isLast && streaming && !showRaw && displayBlocks.length === 0;

  const handleCopy = () => {
    const textToCopy = message.content;
    navigator.clipboard.writeText(textToCopy)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const handleRegenClick = async () => {
    if (onRegenerate) {
      setIsRegenerating(true);
      try {
        await onRegenerate();
      } finally {
        setIsRegenerating(false);
      }
    }
  };

  const handleSpeak = () => {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const text = message.content;
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  };

  return (
    <div
      id={`msg-${message.id}`}
      className="w-full flex flex-col"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {!isUser && message.clarify && !message.clarify.answer && onClarifyAnswer && (
        <ClarifyTool
          payload={message.clarify}
          onSubmit={onClarifyAnswer}
        />
      )}
      {/* todos are rendered in the layout-level Workbench sidebar */}
	      {isUser ? (
	        <>
	          <div className="group rounded-xl border border-border/60 bg-card px-3.5 py-2 max-w-[80%] ml-auto shadow-xs hover:border-border/90 hover:shadow-soft transition-[border-color,box-shadow] duration-150">
	            {editing ? (
	              <div className="flex flex-col gap-2">
	                <textarea
	                  value={editText}
	                  onChange={(e) => setEditText(e.target.value)}
	                  className="w-full resize-none bg-transparent text-sm outline-none text-foreground"
	                  rows={3}
	                  autoFocus
	                />
	                <div className="flex items-center gap-1.5 justify-end">
	                  <button onClick={cancelEdit} className="px-2.5 py-0.5 text-[11px] rounded-md hover:bg-muted text-muted-foreground transition">Cancel</button>
	                  <button onClick={saveEdit} className="px-2.5 py-0.5 text-[11px] rounded-md bg-primary text-primary-foreground hover:opacity-90 transition">Save</button>
	                </div>
	              </div>
	            ) : (
	              <div className={cn(
	                "relative",
	                !userMsgExpanded && message.content.length > LONG_MSG_THRESHOLD && "max-h-[160px] overflow-hidden"
	              )}>
	                <Markdown content={message.content} />
		                {!userMsgExpanded && message.content.length > LONG_MSG_THRESHOLD && (
		                  <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-card to-transparent pointer-events-none" />
		                )}
	              </div>
	            )}
	            {!editing && (
	              /* In-bubble footer: timestamp + copy button. */
	              <div className="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-border/30">
	                <span className="bubble-footer-text text-muted-foreground/70 font-medium">
	                  {message.timestamp ? formatClockTime(message.timestamp) : ''}
	                </span>
	                <button
	                  onClick={handleCopy}
	                  className="p-0.5 rounded text-muted-foreground/70 hover:text-foreground transition-colors duration-150"
	                  title="Copy message"
	                  aria-label="Copy message"
	                >
	                  {copied ? (
	                    <Check className="size-3 text-success" />
	                  ) : (
	                    <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
	                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
	                    </svg>
	                  )}
	                </button>
	              </div>
	            )}
	          </div>
	          <div
	            className="flex items-center gap-1 mt-1 mr-1 transition-opacity duration-150 self-end opacity-0 group-hover:opacity-100 focus-within:opacity-100"
	          >
	            {message.content.length > LONG_MSG_THRESHOLD && !editing && (
	              <button
	                type="button"
	                onClick={() => setUserMsgExpanded(!userMsgExpanded)}
	                className="text-[11px] font-semibold uppercase tracking-caps text-primary hover:underline mr-1"
	              >
	                {userMsgExpanded ? 'Show less' : 'Show more'}
	              </button>
	            )}
	            <button
	              onClick={startEdit}
	              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition"
	              title="Edit message"
	            >
	              <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
	                <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>
	              </svg>
	            </button>
	            <button
	              onClick={onRevert}
	              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition font-mono text-[11px] leading-none"
	              title="Revert changes after this message"
	            >
	              &larr;
	            </button>
	            {isLast && (
	              <button
	                onClick={handleRegenClick}
	                disabled={streaming || isRegenerating}
	                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-50"
	                title="Regenerate response"
	              >
	                <svg
	                  className={cn("size-3", isRegenerating && "animate-spin")}
	                  viewBox="0 0 24 24"
	                  fill="none"
	                  stroke="currentColor"
	                  strokeWidth="2"
	                  strokeLinecap="round"
	                  strokeLinejoin="round"
	                >
	                  <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
	                </svg>
	              </button>
	            )}
	          </div>
	        </>
      ) : (
        <>
          <div className="flex flex-col w-full gap-2">
            {showRaw ? (
              <div className="p-3 bg-muted/40 rounded-xl border border-border/50 text-xs font-mono text-muted-foreground whitespace-pre-wrap overflow-x-auto leading-relaxed">
                {JSON.stringify(message, null, 2)}
              </div>
            ) : (
              <AnimatePresence initial={false} mode="wait">
                {showPendingThinking && (
                  <motion.div
                    key="pending-thinking"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12, ease: 'easeOut' }}
                    className="chat-streaming-block"
                  >
                    <ReasoningBlock text="" isGenerating />
                  </motion.div>
                )}
                {(() => {
                  // Pre-process blocks: group consecutive tool_call/command
                  // entries into a single "tool_group" so they share one
                  // parent timeline rail instead of each rendering their own.
                  type ToolEntry = typeof displayBlocks[number] & { tool: NonNullable<typeof displayBlocks[number]['tool']> };
                  type RenderUnit =
                    | { kind: 'single'; block: typeof displayBlocks[number]; index: number }
                    | { kind: 'tool_group'; entries: Array<{ block: ToolEntry; index: number }> };

                  const units: RenderUnit[] = [];
                  let i = 0;
                  while (i < displayBlocks.length) {
                    const block = displayBlocks[i];
                    if ((block.type === 'tool_call' || block.type === 'command') && block.tool) {
                      const entries: Array<{ block: ToolEntry; index: number }> = [];
                      while (
                        i < displayBlocks.length &&
                        (displayBlocks[i].type === 'tool_call' || displayBlocks[i].type === 'command') &&
                        displayBlocks[i].tool
                      ) {
                        entries.push({ block: displayBlocks[i] as ToolEntry, index: i });
                        i++;
                      }
                      units.push({ kind: 'tool_group', entries });
                    } else {
                      units.push({ kind: 'single', block, index: i });
                      i++;
                    }
                  }

                  return units.map((unit) => {
                    if (unit.kind === 'tool_group') {
                      const renderToolEntry = ({ block, index }: { block: ToolEntry; index: number }) => {
                        const isSubagentCall =
                          block.tool.name === 'august__spawn_subagent' ||
                          block.tool.name === 'workbench_spawn_subagent' ||
                          block.tool.name === 'august__run_team' ||
                          block.tool.name === 'workbench_run_team';
                        const promptEntries = isSubagentCall && block.tool.id && subagentPrompts
                          ? Array.from(subagentPrompts.entries())
                              .filter(([k]) => k === block.tool!.id)
                              .map(([, v]) => v)
                          : [];
                        const subagentContainers = isSubagentCall && block.tool.id && subagentBlocks
                          ? Array.from(subagentBlocks.values())
                              .filter((s) => s.parentToolId === block.tool!.id)
                              .sort((a, b) => a.startedAt - b.startedAt)
                          : [];
                        return (
                          <div key={block.tool.id || `tool_${index}`}>
                            <ToolCallItemComp
                              tool={block.tool}
                              progress={block.tool.id ? toolProgress?.get(block.tool.id) : undefined}
                              agentIdOverride={promptEntries[0]?.subagentId}
                            />
                            {promptEntries.length > 0 && (
                              <div className="ml-3 mt-1 flex flex-col gap-1">
                                {promptEntries.map((p, pi) => (
                                  <PromptDisclosure
                                    key={`${block.tool.id}-prompt-${pi}`}
                                    content={p.content}
                                    tokens={p.tokens}
                                    label={p.subagentId
                                      ? `SUB-AGENT PROMPT · ${p.subagentId}`
                                      : 'SUB-AGENT PROMPT'}
                                  />
                                ))}
                              </div>
                            )}
                            {subagentContainers.length > 0 && (
                              <div className="ml-3 mt-1 flex flex-col gap-1">
                                {subagentContainers.map((s) => (
                                  <SubagentBlock
                                    key={s.jobId}
                                    state={s}
                                    subBlocks={subagentBlocks}
                                    subPrompts={subagentPrompts}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      };

                      return (
                        <motion.div
                          key={`tool_group_${unit.entries[0]?.index ?? 0}`}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.12, ease: 'easeOut' }}
                          className="chat-streaming-block ml-3 pl-3 border-l-2 border-foreground/15 space-y-1.5"
                        >
                          {unit.entries.map(renderToolEntry)}
                        </motion.div>
                      );
                    }

                    // Single block (thinking, final_output)
                    const block = unit.block;
                    const index = unit.index;
                    const key = block.id || `${block.type}_${index}`;
                    const renderBlock = () => {
                      if (block.type === 'thinking') {
                        return (
                          <ReasoningBlock
                            text={block.content || ''}
                            isGenerating={isLast && streaming && index === displayBlocks.length - 1}
                            duration={message.thinkingDuration}
                          />
                        );
                      } else if (block.type === 'final_output') {
                        if (!block.content) return null;
                        const isFinalStreaming = !!(isLast && streaming);
                        return (
                          <div className={cn(
                            "chat-message-text text-foreground/90 space-y-3 max-w-none",
                            isFinalStreaming && "streaming-markdown-content"
                          )}>
                            <Markdown content={block.content} />
                          </div>
                        );
                      }
                      return null;
                    };
                    return (
                      <motion.div
                        key={key}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.12, ease: 'easeOut' }}
                        className="chat-streaming-block"
                      >
                        {renderBlock()}
                      </motion.div>
                    );
                  });
                })()}
              </AnimatePresence>
            )}
            {!isUser && message.changedFiles && message.changedFiles.files.length > 0 && (
              <ChangedFilesCard changes={message.changedFiles} />
            )}
            {isLast && streaming && !showRaw && <WorkingIndicator className="mt-1" />}
          </div>
          {/* Action buttons below assistant message */}
          <div className={cn(
            "flex items-center gap-0.5 mt-1 transition-opacity duration-150 self-start",
            showActions ? "opacity-100" : "opacity-0"
          )}>
            <button
              onClick={handleSpeak}
              className={cn(
                "p-1 rounded transition",
                speaking
                  ? "bg-primary/10 text-primary hover:bg-primary/20"
                  : "hover:bg-muted text-muted-foreground hover:text-foreground"
              )}
              title={speaking ? "Pause reading" : "Read aloud"}
            >
              {speaking ? (
                <Pause className="size-3" />
              ) : (
                <Play className="size-3" />
              )}
            </button>
            <button
              onClick={handleCopy}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition relative"
              title="Copy"
            >
              <div className={cn("transition-transform duration-200", copied ? "scale-110 text-success" : "scale-100")}>
                {copied ? (
                  <Check className="size-3" />
                ) : (
                  <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                )}
              </div>
            </button>
            {isLast && (
              <button
                onClick={handleRegenClick}
                disabled={streaming || isRegenerating}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-50"
                title="Retry / Regenerate"
              >
                <RefreshCw
                  className={cn("size-3", isRegenerating && "animate-spin")}
                />
              </button>
            )}
            <button
              onClick={() => setShowRaw(!showRaw)}
              className={cn("p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition", showRaw && "text-primary")}
              title="Toggle raw data"
            >
              <Bug className="size-3" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ToolCallCard({
  tool,
  timestamp,
  progress,
}: {
  tool: NonNullable<ChatMessage['tool']>;
  timestamp: string;
  progress?: ReadonlyArray<{ path: string; status: 'reading' | 'read' }>;
}) {
  const [open, setOpen] = useState(false);
  const hasBody = !!(tool.args || tool.result);
  const toolNameForIcon = tool.name.replace(/^@/, '');
  const isCommand = toolNameForIcon === 'run_command' || tool.name.startsWith('@run_command');
  // Try to extract a filename hint from the args JSON for a brand-aware file icon.
  let legacyFilename: string | null = null;
  if (!isCommand && tool.args) {
    try {
      const parsed = JSON.parse(tool.args);
      for (const key of ['file_path', 'path', 'filename', 'file', 'filepath']) {
        const v = parsed?.[key];
        if (typeof v === 'string' && v.length > 0) { legacyFilename = v; break; }
      }
    } catch { /* not JSON — ignore */ }
  }
  return (
    <div className="text-sm text-muted-foreground w-full py-0.5" data-slot="tool-block">
      <DisclosureRow
        onToggle={hasBody ? () => setOpen(!open) : undefined}
        open={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          {legacyFilename ? (
            <NewFileIcon name={legacyFilename} size={14} className="shrink-0" />
          ) : (
            <NewToolIcon name={toolNameForIcon} kind={isCommand ? 'command' : 'tool'} size={14} className="shrink-0" />
          )}
          <span
            className={cn(
              'text-sm font-medium leading-5',
              tool.status === 'running' && 'shimmer text-foreground/55'
            )}
          >
            <span className={cn('thinking-text', tool.status === 'running' && 'animating')}>
              <span className="thinking-label">
                {Array.from(getToolLabel(tool.name)).map((ch, i) => (
                  <span
                    key={i}
                    className={cn('thinking-char', i === 0 && 'thinking-cap')}
                    style={{ animationDelay: `${i * 100}ms` }}
                  >
                    {ch}
                  </span>
                ))}
              </span>
              {tool.status === 'running' && (
                <span className="thinking-dots">
                  <span className="dot" style={{ animationDelay: '0ms' }}>.</span>
                  <span className="dot" style={{ animationDelay: '200ms' }}>.</span>
                  <span className="dot" style={{ animationDelay: '400ms' }}>.</span>
                </span>
              )}
            </span>
          </span>
          {tool.status === 'done' && <span className="text-primary/80 text-[12px]">done</span>}
          {tool.status === 'error' && <span className="text-destructive text-[12px]">error</span>}
        </span>
      </DisclosureRow>
      {(() => {
        const visible = progress ? visibleProgress(progress) : [];
        const total = progress?.length ?? 0;
        const overflow = Math.max(0, total - visible.length);
        if (visible.length === 0) return null;
        return (
          <div className="ml-3 mt-0.5 mb-1 space-y-0.5 border-l border-border/30 pl-2" aria-label="Tool progress" data-tool-progress>
            {visible.map((entry) => (
              <div key={entry.path} className="flex items-center gap-1.5 text-[11.5px] truncate" title={entry.path}>
                <span className="w-2.5 shrink-0 inline-flex justify-center">
                  {entry.status === 'reading' ? (
                    <Loader2 size={10} className="animate-spin text-info" />
                  ) : (
                    <Check size={10} className="text-muted-foreground/50" />
                  )}
                </span>
                <span
                  className={cn(
                    'truncate font-mono',
                    entry.status === 'reading' ? 'text-info italic' : 'text-muted-foreground/60 line-through'
                  )}
                >
                  {entry.status === 'reading' ? 'Reading ' : 'Read '}
                  {entry.path}
                </span>
              </div>
            ))}
            {overflow > 0 && (
              <div className="text-[10px] text-muted-foreground/50 italic pl-4">+ {overflow} more</div>
            )}
          </div>
        );
      })()}
      {open && hasBody && (
        <div className="mt-0.5 w-full min-w-0 max-w-full overflow-hidden wrap-anywhere pb-1">
          {tool.args && (
            <pre className="px-2 py-1.5 font-mono whitespace-pre-wrap text-[13px] text-muted-foreground/70 break-words leading-relaxed border-l border-border/30 ml-2.5">
              {tool.args}
            </pre>
          )}
          {tool.result && (
            <div className="px-2 py-1.5 font-mono whitespace-pre-wrap text-[13px] text-foreground/80 break-words leading-relaxed border-l border-border/30 ml-2.5">
              {tool.result}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChatCheckpoints({ messages, scrollRef }: {
  messages: ChatMessage[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [positions, setPositions] = useState<Record<string, { top: number; visible: boolean }>>({});
  const userMessages = useMemo(() => messages.filter(m => m.role === 'user'), [messages]);

  // Calculate pill positions based on message element offsets relative to middle 50% zone
  const updatePositions = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const newPositions: Record<string, { top: number; visible: boolean }> = {};
    const containerRect = container.getBoundingClientRect();
    const containerHeight = containerRect.height;
    
    const zoneMin = containerHeight * 0.25;
    const zoneMax = containerHeight * 0.75;
    
    for (const msg of userMessages) {
      const el = document.getElementById(`msg-${msg.id}`);
      if (el) {
        const elRect = el.getBoundingClientRect();
        const relativeCenter = (elRect.top + elRect.height / 2) - containerRect.top;
        
        // Only visible if relativeCenter is within the middle 50% zone
        const visible = relativeCenter >= zoneMin && relativeCenter <= zoneMax;
        
        // Position top relative to the 50% zone (starts at zoneMin)
        const topInZone = relativeCenter - zoneMin;
        
        newPositions[msg.id] = { top: topInZone, visible };
      }
    }
    setPositions(newPositions);
  }, [userMessages, scrollRef]);

  // Update on scroll, resize, and messages change
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || userMessages.length === 0) return;
    // The scrollable ancestor is the screen-edge scroll container in
    // ChatLayout, not the ref'd div (which is no longer scrollable).
    const scrollable = container.closest('.overflow-y-auto') as HTMLElement | null ?? container;
    updatePositions();
    const onScroll = () => updatePositions();
    const onResize = () => updatePositions();
    scrollable.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      scrollable.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [updatePositions, userMessages, scrollRef]);

  // IntersectionObserver to track which user message is in view
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || userMessages.length === 0) return;

    const visible = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          visible.set(entry.target.id, entry.intersectionRatio);
        } else {
          visible.delete(entry.target.id);
        }
      }
      let best: string | null = null;
      let bestRatio = 0;
      for (const [id, ratio] of visible) {
        if (ratio > bestRatio) { bestRatio = ratio; best = id; }
      }
      setActiveId(best);
    }, { root: container, rootMargin: '-80px 0px -40% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] });

    for (const msg of userMessages) {
      const el = document.getElementById(`msg-${msg.id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [userMessages, scrollRef]);

  const scrollTo = (msgId: string) => {
    const el = document.getElementById(`msg-${msgId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-primary/30', 'rounded-lg');
    setTimeout(() => el.classList.remove('ring-2', 'ring-primary/30', 'rounded-lg'), 1200);
  };

  if (userMessages.length === 0) return null;

  return (
    <div
      className="absolute right-0 top-[25%] bottom-[25%] w-10 z-20 pointer-events-none"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="relative w-full h-full">
        {userMessages.map((msg) => {
          const isActive = activeId === `msg-${msg.id}`;
          const pos = positions[msg.id];
          if (!pos) return null;

          return (
            <button
              key={msg.id}
              onClick={() => scrollTo(msg.id)}
              aria-label={`Go to message`}
              style={{ 
                top: `${pos.top}px`,
                opacity: pos.visible ? (hovered ? 1 : 0.4) : 0,
                pointerEvents: pos.visible ? 'auto' : 'none'
              }}
              className={cn(
                'checkpoint-pill pill-appear',
                isActive ? 'active' : 'inactive'
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

function ToolBtn({ Icon, label, onClick, className, buttonRef }: { Icon: any; label: string; onClick?: () => void; className?: string; buttonRef?: React.RefObject<HTMLButtonElement | null> }) {
  return (
    <button
      ref={buttonRef ?? undefined}
      onClick={onClick}
      className={cn('h-8 w-8 p-0 rounded-lg hover:bg-muted hover:text-foreground transition text-muted-foreground', className)}
      title={label}
      aria-label={label}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/* ── Context Window Formatter Helper ────────────────────────────── */
export function formatContextWindow(num?: number): string {
  if (!num) return '128k';
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(0)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(0)}k`;
  }
  return String(num);
}

/* ── Custom Model Dropdown ────────────────────────────────────────── */
/* Renders the trigger inline and the dropdown panel via React portal to
 * `document.body` with `position: fixed`. This escapes the
 * `overflow: hidden` chain on the chat-thread column and the chat-layout
 * main column — without this, the dropdown was clipped at the chat-thread
 * boundary when opened in the empty/centered composer state. */

function ModelDropdown({ models, visibleModels, loading, selected, onSelect, onRefresh, onEditModels }: {
  models: ModelItem[];
  visibleModels: ModelItem[];
  loading?: boolean;
  selected: ModelItem | null;
  onSelect: (m: ModelItem | null) => void;
  onRefresh?: () => void;
  onEditModels?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollEnd, setScrollEnd] = useState(false);
  // Position of the dropdown panel in viewport coordinates. Recomputed
  // each time the dropdown opens and on scroll/resize while open.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  const computePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const width = Math.max(240, Math.min(320, r.width + 80));
    // Estimate the panel height so the initial position sits ABOVE the
    // trigger (panel's bottom edge near r.top), not on top of it. Refined
    // to the real height on the next frame once the panel has mounted.
    const estHeight = 320;
    const desiredTop = r.top - estHeight - 4;
    const top = Math.max(8, desiredTop);
    const right = Math.max(8, window.innerWidth - r.right);
    return { top, right, width };
  }, []);

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    const panel = listRef.current?.parentElement?.parentElement;
    if (!el || !panel) return;
    const r = el.getBoundingClientRect();
    const panelHeight = panel.offsetHeight || 320;
    const desiredTop = r.top - panelHeight - 4;
    const top = Math.max(8, desiredTop);
    const right = Math.max(8, window.innerWidth - r.right);
    setPos({ top, right });
  }, []);

  // Close on outside click. Use the triggerRef as the inclusion point.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (listRef.current?.parentElement?.parentElement?.contains(target)) return;
      setOpen(false);
      setSearchQuery('');
      setExpandedProviders(new Set());
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setSearchQuery('');
        setExpandedProviders(new Set());
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Recompute position on scroll/resize while open (handles the composer
  // being in a scrollable column or the window being resized).
  useEffect(() => {
    if (!open) return;
    // Set a viewport-relative position from the trigger alone, *before* the
    // panel is mounted. Without this, the panel never renders because it
    // gates on `pos` being truthy and `updatePosition` needs the panel
    // already in the DOM to measure its height.
    const initial = computePos();
    if (initial) setPos(initial);
    // Defer one frame so the panel mounts, then refine using its real height.
    requestAnimationFrame(() => updatePosition());
    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, computePos, updatePosition]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      // Defer one frame so the panel is mounted before we measure.
      requestAnimationFrame(() => {
        updatePosition();
        setTimeout(() => searchRef.current?.focus(), 0);
      });
    } else {
      setSearchQuery('');
      setExpandedProviders(new Set());
    }
  }, [open, updatePosition]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setScrollEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  };

  const filtered = searchQuery.trim()
    ? visibleModels.filter(m =>
        m.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        getModelDisplayName(m.id).toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.provider.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : visibleModels;

  const grouped = Object.entries(
    filtered.reduce((acc, m) => {
      if (!acc[m.provider]) acc[m.provider] = [];
      acc[m.provider].push(m);
      return acc;
    }, {} as Record<string, ModelItem[]>)
  ).map(([provider, list]) => {
    const sorted = [...list].sort((a, b) => {
      if (a.isFree && !b.isFree) return -1;
      if (!a.isFree && b.isFree) return 1;
      return getModelDisplayName(a.id).localeCompare(getModelDisplayName(b.id));
    });
    const isSearching = searchQuery.trim().length > 0;
    const isExpanded = expandedProviders.has(provider);
    const visible = isSearching || isExpanded ? sorted : sorted.slice(0, 5);
    const showCollapse = sorted.length > 5 && !isSearching;
    return { provider, models: sorted, visible, isExpanded, total: sorted.length, showCollapse };
  });

  const dropdownContent = (
    <AnimatePresence>
      {open && pos && (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.97 }}
          transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="fixed z-50 min-w-[240px] max-w-[320px] bg-popover rounded-lg shadow-2xl overflow-hidden origin-bottom-right"
          style={{ top: pos.top, right: pos.right }}
        >
          {/* Search bar */}
          <div className="px-1.5 pt-1.5 pb-0.5 bg-popover">
            <div className="flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1">
              <svg className="size-2.5 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search…"
                className="bg-transparent text-sm font-mono outline-none w-full placeholder:text-muted-foreground/50 text-foreground py-0.5"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="p-0.5 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition"
                >
                  <svg className="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
              {onRefresh && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await onRefresh();
                  }}
                  className={cn(
                    "p-0.5 rounded hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition",
                    loading && "animate-spin"
                  )}
                  title="Refresh models list"
                  disabled={loading}
                >
                  <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className="relative">
            {/* Top fade indicator */}
            <div className={cn(
              'absolute top-0 left-0 right-0 h-5 z-10 pointer-events-none transition-opacity',
              'bg-gradient-to-b from-popover to-transparent',
              scrollTop > 4 ? 'opacity-100' : 'opacity-0'
            )} />
            {/* Bottom fade indicator */}
            <div className={cn(
              'absolute bottom-0 left-0 right-0 h-5 z-10 pointer-events-none transition-opacity',
              'bg-gradient-to-t from-popover to-transparent',
              scrollEnd ? 'opacity-0' : 'opacity-100'
            )} />

            <div
              ref={listRef}
              onScroll={onScroll}
              className="model-dropdown-list max-h-[240px] overflow-x-hidden overflow-y-auto py-0.5"
            >
              {loading && grouped.length === 0 ? (
                <div className="px-2 py-1 space-y-1">
                  <div className="skeleton-row h-4 w-20 rounded my-1" />
                  <div className="skeleton-row h-7 w-full rounded" />
                  <div className="skeleton-row h-7 w-full rounded" />
                  <div className="skeleton-row h-7 w-full rounded" />
                  <div className="skeleton-row h-4 w-24 rounded my-1" />
                  <div className="skeleton-row h-7 w-full rounded" />
                  <div className="skeleton-row h-7 w-full rounded" />
                </div>
              ) : grouped.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {searchQuery.trim() ? `No results for "${searchQuery.trim()}"` : 'no models loaded'}
                </div>
              ) : (
                grouped.map(({ provider, visible, isExpanded, total, showCollapse }) => (
                  <div key={provider}>
                    <div className="px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold sticky top-0 bg-popover/95 backdrop-blur z-20 flex justify-between items-center">
                      <span>{provider}</span>
                      <span className="text-[10px] lowercase font-mono text-muted-foreground/60">({total})</span>
                    </div>
                    {visible.map(m => {
                      const { name, tag } = modelDisplayParts(m.id);
                      return (
                        <button
                          key={m.id}
                          onClick={() => { onSelect(m); setOpen(false); }}
                          className={cn(
                            'w-full text-left px-2.5 py-1.5 text-sm transition-all duration-150 flex items-center gap-2 rounded-md mx-1',
                            selected?.id === m.id
                              ? 'text-primary bg-primary/10 font-semibold'
                              : 'text-foreground/80 hover:bg-white/5 hover:text-foreground'
                          )}
                        >
                          <span className="truncate flex-1 font-sans">
                            {name}
                            {tag && (
                              <span className="ml-1.5 text-[10px] text-muted-foreground/50 font-normal">{tag}</span>
                            )}
                          </span>
                          <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
                            {formatContextWindow(m.contextWindow)}
                          </span>
                        </button>
                      );
                    })}
                    {showCollapse && (
                      <button
                        onClick={() => {
                          setExpandedProviders(prev => {
                            const next = new Set(prev);
                            if (isExpanded) next.delete(provider);
                            else next.add(provider);
                            return next;
                          });
                        }}
                        className="w-full text-left px-2.5 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/5 transition"
                      >
                        {isExpanded ? '▲ Show less' : '▼ Show ' + (total - 5) + ' more'}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Edit models link */}
            {onEditModels && (
              <div className="px-2 py-1.5 border-t border-border/20">
                <button
                  onClick={() => { onEditModels(); setOpen(false); }}
                  className="w-full text-left px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-white/5 rounded-md transition"
                >
                  Edit models
                </button>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v: boolean) => !v)}
        className={cn(
          'relative flex items-center gap-1.5 text-xs font-sans outline-none cursor-pointer shrink-0 h-8',
          'text-muted-foreground hover:text-foreground transition-all duration-200',
          'bg-muted/30 hover:bg-muted/50 rounded-md px-2 py-1',
        )}
        title={selected ? getModelDisplayName(selected.id || selected.name || '') : 'Select model'}
      >
        {selected && (
          <span className="text-[10px] bg-primary/10 text-primary px-1 py-0.5 rounded uppercase font-semibold tracking-wider scale-90 origin-left shrink-0">
            {selected.provider === 'openai-api' ? 'openai' : selected.provider}
          </span>
        )}
        <span className="truncate max-w-[140px] font-medium text-foreground transition-all duration-200">{selected ? modelDisplayParts(selected.id || selected.name || '').name : 'model'}</span>
        <svg className={cn("size-3 shrink-0 opacity-60 ml-0.5 transition-transform duration-200", open && "rotate-180")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {typeof document !== 'undefined' && createPortal(dropdownContent, document.body)}
    </>
  );
}

/* ── Custom Effort Dropdown ──────────────────────────────────────── */
function EffortDropdown({ value, onChange }: {
  value: 'low' | 'medium' | 'high' | 'max';
  onChange: (v: 'low' | 'medium' | 'high' | 'max') => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const options: { value: 'low' | 'medium' | 'high' | 'max'; label: string; desc: string }[] = [
    { value: 'low', label: 'Low', desc: 'Short thinking, fast response' },
    { value: 'medium', label: 'Medium', desc: 'Balanced thinking & speed' },
    { value: 'high', label: 'High', desc: 'Thorough reasoning' },
    { value: 'max', label: 'Max', desc: 'Full depth, maximum reasoning' },
  ];

  const currentOpt = options.find(o => o.value === value) || options[1];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 text-xs outline-none cursor-pointer h-8',
          'text-muted-foreground hover:text-foreground transition-all duration-200',
          'bg-muted/30 hover:bg-muted/50 rounded-md px-2 py-1',
        )}
        title="Thinking Effort"
      >
<span className="text-sm font-medium text-foreground transition-all duration-200">
          {currentOpt.label}
        </span>
        <svg className={cn("size-2.5 shrink-0 opacity-60 transition-transform duration-200", open && "rotate-180")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="absolute bottom-full mb-1.5 right-0 z-50 min-w-[200px] bg-popover rounded-lg shadow-2xl py-1 origin-bottom-right"
          >
            <div className="px-2.5 py-1 text-[10px] text-muted-foreground/50 uppercase tracking-widest font-semibold mb-0.5">
              Reasoning Effort
            </div>
            {options.map(opt => (
              <button
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className={cn(
                  'w-full text-left px-2.5 py-1.5 text-[13px] transition-all duration-150 flex flex-col gap-0.5 rounded-md mx-1',
                  value === opt.value
                    ? 'text-primary bg-primary/10 font-semibold'
                    : 'text-foreground/80 hover:bg-white/5 hover:text-foreground'
                )}
              >
                <span className="font-sans font-medium">{opt.label}</span>
                <span className="text-[12px] text-muted-foreground/50">{opt.desc}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

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

/* ── Custom Markdown & Inline Style Renderer ───────────────────────── */

export function parseSequentialText(text: string): { type: 'thinking' | 'final_output'; content: string }[] {
  const blocks: { type: 'thinking' | 'final_output'; content: string }[] = [];
  let currentIndex = 0;

  const markers = [
    { open: '<thinking>', close: '</thinking>' },
    { open: '<think>', close: '</think>' },
    { open: '[THINK]', close: '[/THINK]' },
    { open: '[REASONING]', close: '[/REASONING]' }
  ];

  while (currentIndex < text.length) {
    let earliestOpenIdx = -1;
    let selectedMarker = null;

    for (const marker of markers) {
      const idx = text.indexOf(marker.open, currentIndex);
      if (idx !== -1 && (earliestOpenIdx === -1 || idx < earliestOpenIdx)) {
        earliestOpenIdx = idx;
        selectedMarker = marker;
      }
    }

    if (earliestOpenIdx === -1) {
      const remaining = text.slice(currentIndex);
      if (remaining) {
        blocks.push({ type: 'final_output', content: remaining });
      }
      break;
    }

    if (earliestOpenIdx > currentIndex) {
      const preceding = text.slice(currentIndex, earliestOpenIdx);
      if (preceding) {
        blocks.push({ type: 'final_output', content: preceding });
      }
    }

    const openMarkerLength = selectedMarker!.open.length;
    const contentStartIdx = earliestOpenIdx + openMarkerLength;
    const closeIdx = text.indexOf(selectedMarker!.close, contentStartIdx);

    if (closeIdx !== -1) {
      const thinkingContent = text.slice(contentStartIdx, closeIdx);
      blocks.push({ type: 'thinking', content: thinkingContent });
      currentIndex = closeIdx + selectedMarker!.close.length;
    } else {
      const thinkingContent = text.slice(contentStartIdx);
      blocks.push({ type: 'thinking', content: thinkingContent });
      currentIndex = text.length;
    }
  }

  return blocks;
}

export function getDisplayBlocks(
  blocks?: MessageBlock[],
  thinking?: string,
  tools?: ChatMessage['tools'],
  content?: string
): MessageBlock[] {
  try {
    const result: MessageBlock[] = [];
    if (blocks && blocks.length > 0) {
      for (const block of blocks) {
        if (block.type === 'final_output' && block.content) {
          const parsed = parseSequentialText(block.content);
          for (const [subIndex, sub] of parsed.entries()) {
            result.push({
              id: `${block.id}_sub_${subIndex}_${sub.type}`,
              type: sub.type,
              content: sub.content
            });
          }
        } else {
          result.push(block);
        }
      }
      if (result.length > 0) return result;
    }

    // Fallback: build blocks from thinking, tools, and content
    const resultFallback: MessageBlock[] = [];
    if (thinking && thinking.trim()) {
      resultFallback.push({
        id: 'fallback_thinking',
        type: 'thinking',
        content: thinking.trim()
      });
    }

    if (tools && tools.length > 0) {
      for (const tool of tools) {
        const isCommand = tool.name.startsWith('@run_command') || tool.name.startsWith('run_command');
        resultFallback.push({
          id: `fallback_tool_${tool.id}`,
          type: isCommand ? 'command' : 'tool_call',
          tool: tool
        });
      }
    }

    if (content && content.trim()) {
      const parsed = parseSequentialText(content);
      for (const [subIndex, sub] of parsed.entries()) {
        resultFallback.push({
          id: `fallback_content_sub_${subIndex}_${sub.type}`,
          type: sub.type,
          content: sub.content
        });
      }
    }

    if (resultFallback.length > 0) return resultFallback;
  } catch (err) {
    console.error('Failed to parse blocks, falling back:', err);
  }

  return [{
    id: 'fallback_raw',
    type: 'final_output',
    content: content || ''
  }];
}

export function parseThinkingAndContent(rawContent: string, existingThinking?: string): { thinking: string; content: string } {
  const blocks = parseSequentialText(rawContent);
  let thinking = existingThinking || '';
  let content = '';

  for (const block of blocks) {
    if (block.type === 'thinking') {
      thinking += (thinking ? '\n' : '') + block.content;
    } else {
      content += block.content;
    }
  }

  return { thinking: thinking.trim(), content: content.trim() };
}

/* Long-message threshold used by the user bubble's collapse/expand toggle.
 * AI bubbles intentionally don't collapse — they always render in full. */
const LONG_MSG_THRESHOLD = 1000;
