/* ── Chat thread ─────────────────────────────────────────────────────── */
/* The main view. User/assistant messages with proper avatars + bubbles.  */
/* Tool calls render as inline cards. Right rail optional.                  */

import { useState, useRef, useEffect, useMemo, useCallback, type KeyboardEvent } from 'react';
import { Send, Paperclip, Mic, AtSign, Sparkles, ChevronRight, Wrench, Check, AlertCircle, StopCircle, X, Zap, HelpCircle, Loader2, Bug, Play, Pause, RefreshCw } from 'lucide-react';
import { cn, formatTimeAgo, fmtElapsed } from '@/lib/utils';
import { mockChatThread } from '@/lib/mock';
import { Button } from '@/components/ui/button';
import { marked } from 'marked';
import { toast } from 'sonner';
import { useStore } from '@nanostores/react';
import { $sessions, setSessionStatus, clearSessionStatus, renameSession, updateSessionModel, updateSessionWorkbenchMetadata, type Session } from '@/store/sessions';
import { motion, AnimatePresence } from 'framer-motion';
import { ThinkingDisclosure } from '@/components/chat/ThinkingDisclosure';
import { ToolCallItem as ToolCallItemComp, getToolIcon } from '@/components/chat/ToolCallItem';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { ClarifyTool } from '@/components/chat/ClarifyTool';
import { HoistedTodoPanel } from '@/components/chat/HoistedTodoPanel';
import { WorkingIndicator } from '@/components/chat/WorkingIndicator';
import { ModelVisibilityModal, loadHiddenModels, saveHiddenModels } from '@/components/overlays/ModelVisibilityModal';
import { Statusbar } from '@/components/shell/Statusbar';
import { createChatRuntime, type ChatTurnRecord } from './chat-runtime';
import {
  createWorkbenchSession,
  listWorkbenchAgents,
  streamWorkbenchChat,
  approveWorkbenchPlan,
  answerWorkbenchBtw,
  getWorkbenchSession,
} from '@/api/workbench';
import type { WorkbenchAgentRegistry, WorkbenchBtwResult, WorkbenchSession } from '@/types/workbench';
import { WorkbenchAgentSelector } from '@/components/chat/WorkbenchAgentSelector';
import { WorkbenchBtwDrawer } from '@/components/chat/WorkbenchBtwDrawer';
import { TodoSummary, WorkbenchPlanPanel, WorkbenchStatusPill } from '@/components/chat/WorkbenchPlanPanel';

export const chatRuntime = createChatRuntime();
let visibleSessionId: string | null = null;
let visibleGeneration = 0;

// Configure marked to support GitHub Flavored Markdown and breaks
marked.use({
  gfm: true,
  breaks: true
});

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
  };
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
  /** Inline clarify/question */
  clarify?: {
    question: string;
    choices?: string[];
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
  { name: '/reset', desc: 'Reset conversation history' },
  { name: '/clear', desc: 'Clear the chat display' },
  { name: '/debug', desc: 'Toggle diagnostics mode' },
  { name: '/model', desc: 'Switch model: /model <name>' },
  { name: '/provider', desc: 'Switch provider: /provider <name>' },
];

export function ChatThread({ sessionId }: { sessionId: string | null }) {
  const sessions = useStore($sessions);
  const activeSession = useMemo(() => sessions.find(s => s.id === sessionId), [sessions, sessionId]);
  const workspacePath = activeSession?.workspacePath || null;

  const storageKey = sessionId ? `chat_messages_${sessionId}` : null;
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (storageKey) {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) return JSON.parse(saved);
      } catch {}
    }
    return buildDemoThread(sessionId);
  });
  const [input, setInput] = useState('');
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const streaming = chatRuntime.isSessionStreaming(sessionId);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(loadHiddenModels);
  const [showModelVisibility, setShowModelVisibility] = useState(false);
  const [workbenchSession, setWorkbenchSession] = useState<WorkbenchSession | null>(() => {
    if (activeSession?.workbenchSessionId) {
      return {
        id: activeSession.workbenchSessionId,
        provider: activeSession.workbenchProvider || 'claude',
        agentId: activeSession.workbenchAgentId || 'build',
        agentRole: activeSession.workbenchAgentId || 'build',
        agentMode: 'assistant',
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
      };
    }
    return null;
  });
  const [workbenchAgents, setWorkbenchAgents] = useState<WorkbenchAgentRegistry | null>(null);
  const [workbenchAgentsLoading, setWorkbenchAgentsLoading] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState(activeSession?.workbenchAgentId || 'build');
  const [workbenchBtw, setWorkbenchBtw] = useState<WorkbenchBtwResult | null>(null);
  const [workbenchBusy, setWorkbenchBusy] = useState(false);

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
  const [showToolsDropdown, setShowToolsDropdown] = useState(false);
  const [showCommandsDropdown, setShowCommandsDropdown] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);

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

  useEffect(() => chatRuntime.subscribe(() => setRuntimeVersion((value) => value + 1)), []);

  useEffect(() => {
    visibleSessionId = sessionId;
  }, [sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  useEffect(() => {
    const key = sessionId ? `chat_messages_${sessionId}` : null;
    if (key) {
      try {
        const saved = localStorage.getItem(key);
        if (saved) { setMessages(JSON.parse(saved)); return; }
      } catch {}
    }
    setMessages(buildDemoThread(sessionId));
  }, [sessionId]);

  // Persist messages to localStorage on every change
  useEffect(() => {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify(messages)); } catch {}
  }, [messages, storageKey]);

  // Persist effort choice to localStorage on every change
  useEffect(() => {
    try { localStorage.setItem('august_last_effort', effort); } catch {}
  }, [effort]);

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

  useEffect(() => {
    if (activeSession?.workbenchAgentId) setSelectedAgentId(activeSession.workbenchAgentId);
  }, [activeSession?.workbenchAgentId]);

  useEffect(() => {
    let cancelled = false;
    setWorkbenchAgentsLoading(true);
    listWorkbenchAgents(selectedAgentId)
      .then((registry) => {
        if (!cancelled) setWorkbenchAgents(registry);
      })
      .catch((e) => console.warn('[Workbench] Agent registry failed:', e))
      .finally(() => {
        if (!cancelled) setWorkbenchAgentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAgentId]);

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
            // Build a lightweight placeholder so the button shows the correct label instantly
            const placeholder: ModelItem = {
              id: activeModelId,
              name: activeModelId,
              provider: activeProvider,
              contextWindow: 128000,
              supportsReasoning: isLikelyReasoningModel(activeModelId),
              supportsThinking: isLikelyReasoningModel(activeModelId),
            };
            setSelectedModel(prev => {
              // Only override localStorage value if the config model differs
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
        // Filter to only show models from providers with keys set
        const loadedModels = availableProviders.size > 0
          ? allModels.filter(m => availableProviders.has(m.provider))
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

  const storageKeyFor = (id: string | null) => id ? `chat_messages_${id}` : null;
  const persistMessages = (id: string | null, value: ChatMessage[]) => {
    const key = storageKeyFor(id);
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  };

  const updateAssistantMessage = useCallback((
    turnSessionId: string | null,
    assistantMsgId: string,
    updater: (messages: ChatMessage[]) => ChatMessage[]
  ) => {
    const key = storageKeyFor(turnSessionId);
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

  // ── Workbench chat client ─────────────────────────────────────────
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
      agentId: selectedAgentId || 'build',
    });
    setWorkbenchSession(created);
    updateSessionWorkbenchMetadata(sessionId, {
      workbenchSessionId: created.id,
      workbenchAgentId: created.agentId,
      workbenchProvider: created.provider,
    });
    return created;
  };

  const generateAIResponse = async (chatHistory: ChatMessage[]) => {
    const turnSessionId = sessionId;
    const isCurrentTurn = () => isTurnVisible(turnSessionId);
    if (!turnSessionId) return;
    if (!chatRuntime.canStartTurn(turnSessionId)) return;

    setSessionStatus(turnSessionId, 'working');
    setWorkbenchBusy(true);

    const assistantMsgId = `a${Date.now()}`;
    const turn = chatRuntime.startTurn({
      sessionId: turnSessionId,
      assistantMsgId,
      transport: 'none',
    });
    const abortController = turn.controller;

    const thinkingStart = Date.now();
    let thinkingEnd: number | null = null;
    let workbenchSessionId = workbenchSession?.id || activeSession?.workbenchSessionId || null;
    let assistantContent = '';
    let thinkingContent = '';
    let toolResults: ChatMessage['tools'] = [];
    let streamBlocks: MessageBlock[] = [];
    let finished = false;
    let hadError = false;

    const nextMessages = [...chatHistory, createAssistantPlaceholder(assistantMsgId)];
    setMessages(nextMessages);
    persistMessages(turnSessionId, nextMessages);

    const update = () => {
      updateAssistantMessage(turnSessionId, assistantMsgId, prev => prev.map(msg =>
        msg.id === assistantMsgId ? {
          ...msg,
          content: assistantContent,
          thinking: thinkingContent || undefined,
          tools: toolResults && toolResults.length > 0 ? toolResults : undefined,
          blocks: streamBlocks,
          todos: workbenchSession?.todos?.length ? workbenchSession.todos : undefined,
        } : msg
      ));
    };

    const finalize = (status: 'done' | 'error' | 'aborted') => {
      if (finished) return;
      finished = true;
      setWorkbenchBusy(false);
      updateAssistantMessage(turnSessionId, assistantMsgId, prev => prev.map(msg =>
        msg.id === assistantMsgId ? {
          ...msg,
          content: assistantContent,
          thinking: thinkingContent || undefined,
          thinkingDuration: thinkingEnd
            ? Math.round((thinkingEnd - thinkingStart) / 100) / 10
            : thinkingContent.trim()
              ? Math.round((Date.now() - thinkingStart) / 100) / 10
              : undefined,
          tools: toolResults && toolResults.length > 0 ? toolResults : undefined,
          blocks: streamBlocks,
          todos: workbenchSession?.todos?.length ? workbenchSession.todos : undefined,
        } : msg
      ));
      if (status === 'done' || status === 'error') {
        if (isCurrentTurn()) setSessionStatus(turnSessionId, status === 'done' ? 'done' : 'error');
      }
      finishTurn(turn, status);
    };

    try {
      const session = await ensureWorkbenchSession();
      if (!session) {
        updateAssistantMessage(turnSessionId, assistantMsgId, prev => prev.map(msg =>
          msg.id === assistantMsgId ? { ...msg, content: '⚠️ Could not initialize Workbench session.' } : msg
        ));
        finalize('error');
        return;
      }
      workbenchSessionId = session.id;
      chatRuntime.setTransport(turn.turnId, 'http');

      await streamWorkbenchChat({
        sessionId: workbenchSessionId,
        message: chatHistory.map(m => `${m.role}: ${m.content}`).join('\n\n') || ' ',
        provider: getWorkbenchProvider(),
        agentId: selectedAgentId || session.agentId,
      }, {
        onThinking: ({ content }) => {
          if (!thinkingEnd && content.trim()) {
            thinkingEnd = Date.now();
          }
          thinkingContent += content;
          streamBlocks = appendBlockEvent(streamBlocks, { type: 'thinking', content });
          update();
        },
        onText: ({ content }) => {
          if (!thinkingEnd && thinkingContent.trim()) {
            thinkingEnd = Date.now();
          }
          assistantContent += content;
          streamBlocks = appendBlockEvent(streamBlocks, { type: 'text', content });
          update();
        },
        onToolUse: ({ id, name, input }) => {
          toolResults = [...toolResults, {
            name,
            args: JSON.stringify(input, null, 2),
            id,
            status: 'running',
            summary: Object.keys(input || {}).join(', '),
            error: '',
            startedAt: Date.now(),
          }];
          streamBlocks = appendBlockEvent(streamBlocks, {
            type: name.startsWith('@run_command') || name.startsWith('run_command') ? 'command' : 'tool_call',
            name,
            id,
            context: JSON.stringify(input || {}, null, 2),
            status: 'running',
          });
          update();
        },
        onToolResult: ({ id, content, is_error }) => {
          const resultText = typeof content === 'string' ? content : JSON.stringify(content);
          toolResults = toolResults.map(t => t.id === id ? {
            ...t,
            status: is_error ? 'error' : 'done',
            result: resultText,
            error: is_error ? resultText : '',
            duration: undefined,
          } : t);
          streamBlocks = appendBlockEvent(streamBlocks, {
            type: 'tool_result',
            id,
            status: is_error ? 'error' : 'done',
            summary: resultText.slice(0, 240),
            error: is_error ? resultText.slice(0, 240) : '',
          });
          update();
        },
        onSession: (sessionState) => {
          setWorkbenchSession(sessionState);
          if (sessionState.agentId) setSelectedAgentId(sessionState.agentId);
          update();
        },
        onBtw: (result) => {
          setWorkbenchBtw(result);
        },
        onDone: () => {
          finalize('done');
        },
        onError: ({ message }) => {
          hadError = true;
          assistantContent += `\n\n⚠️ Workbench error: ${message}`;
          streamBlocks = appendBlockEvent(streamBlocks, { type: 'text', content: `\n\n⚠️ Workbench error: ${message}` });
          update();
          finalize('error');
        },
      }, abortController.signal);

      if (!finished) finalize(hadError ? 'error' : 'done');
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        clearSessionStatus(turnSessionId);
        finalize('aborted');
        return;
      }
      console.error(e);
      assistantContent += `\n\n⚠️ Connection error: ${e.message}`;
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'text', content: `\n\n⚠️ Connection error: ${e.message}` });
      update();
      finalize('error');
    }
  };

  function appendBlockEvent(
    prevBlocks: MessageBlock[],
    event: {
      type: 'thinking' | 'text' | 'content' | 'tool_call' | 'tool_progress' | 'tool_result';
      content?: string;
      name?: string;
      id?: string;
      context?: string;
      preview?: string;
      summary?: string;
      error?: string;
      status?: 'running' | 'done' | 'error';
      duration?: number;
    }
  ): MessageBlock[] {
    const blocks = [...prevBlocks];
    const lastBlock = blocks[blocks.length - 1];

    if (event.type === 'thinking') {
      const text = event.content || '';
      if (lastBlock && lastBlock.type === 'thinking') {
        lastBlock.content = (lastBlock.content || '') + text;
      } else {
        blocks.push({
          id: `b_think_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'thinking',
          content: text
        });
      }
    } else if (event.type === 'text' || event.type === 'content') {
      const text = event.content || '';
      if (lastBlock && lastBlock.type === 'final_output') {
        lastBlock.content = (lastBlock.content || '') + text;
      } else {
        blocks.push({
          id: `b_out_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'final_output',
          content: text
        });
      }
    } else if (event.type === 'tool_call') {
      const isCommand = event.name?.startsWith('@run_command') || event.name?.startsWith('run_command');
      blocks.push({
        id: `b_tool_${event.id || Date.now()}`,
        type: isCommand ? 'command' : 'tool_call',
        tool: {
          id: event.id || `tc_${Date.now()}`,
          name: event.name || 'tool',
          context: event.context || '',
          status: event.status || 'running',
          startedAt: Date.now()
        }
      });
    } else if (event.type === 'tool_progress') {
      const targetIdx = blocks.findIndex(b => b.tool && b.tool.id === event.id);
      if (targetIdx !== -1) {
        const target = { ...blocks[targetIdx] };
        if (target.tool) {
          target.tool = {
            ...target.tool,
            preview: (target.tool.preview || '') + (event.preview || '')
          };
        }
        blocks[targetIdx] = target;
      }
    } else if (event.type === 'tool_result') {
      const targetIdx = blocks.findIndex(b => b.tool && b.tool.id === event.id);
      if (targetIdx !== -1) {
        const target = { ...blocks[targetIdx] };
        if (target.tool) {
          target.tool = {
            ...target.tool,
            status: event.status || 'done',
            summary: event.summary || '',
            error: event.error || '',
            duration: event.duration
          };
        }
        blocks[targetIdx] = target;
      }
    }

    return blocks;
  }

  const send = async () => {
    let text = input.trim();
    if (!text && attachments.length === 0) return;
    if (streaming) return;

    if (attachments.length > 0) {
      const attachInfo = attachments.map(a => `[File Attachment: ${a.name} (${a.size})]`).join('\n');
      text = `${text}\n\n${attachInfo}`;
    }

    // Auto-generate title from first user message
    if (messages.length === 0 && sessionId) {
      const title = text.length > 50 ? text.slice(0, 50).trim() + '…' : text;
      renameSession(sessionId, title);
    }

    // Save the selected model on this session only; do not change global defaults.
    if (sessionId && modelForRequest) {
      updateSessionModel(sessionId, modelForRequest.id, modelForRequest.provider);
    }

    setInput('');
    setAttachments([]);
    setShowToolsDropdown(false);
    setShowCommandsDropdown(false);

    const userMsg: ChatMessage = {
      id: `m${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString()
    };

    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    persistMessages(sessionId, nextMessages);
    await generateAIResponse([userMsg]);
  };

  const stop = () => {
    const activeTurnId = chatRuntime.getLatestActiveTurnId(sessionId);
    const turn = activeTurnId ? chatRuntime.getTurn(activeTurnId) : null;
    if (turn) {
      abortTurn(turn);
      if (sessionId) clearSessionStatus(sessionId);
    }
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
      setMessages(messages.slice(0, userMsgIndex));
      setRevertingIndex(null);

      toast.success("Conversation reverted", {
        description: `Put prompt back into composer and removed ${deleted} message${deleted > 1 ? 's' : ''}`,
        duration: 5000,
        action: {
          label: "Undo",
          onClick: () => {
            setMessages(originalMessages);
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
    setMessages(messages.slice(0, index).concat({ ...msg, content: newText.trim() }));
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
      <div className="max-w-3xl mx-auto relative">
        {/* Tools Dropdown */}
        {showToolsDropdown && (
          <div className="absolute bottom-full mb-2 left-2 z-10 w-64 bg-card border border-border shadow-2xl rounded-xl p-1.5 space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150">
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
          </div>
        )}

        {/* Commands Dropdown — triggered by typing / */}
        {showCommandsDropdown && (
          <div className="absolute bottom-full mb-2 left-2 z-10 w-64 bg-card border border-border shadow-2xl rounded-xl p-1.5 space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150">
            <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold">Commands & Tools</div>
            {COMMANDS.filter(c => !input || c.name.startsWith(input)).map((c) => (
              <button
                key={c.name}
                onClick={() => {
                  insertText(c.name);
                  setShowCommandsDropdown(false);
                }}
                className="w-full text-left rounded-md px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition flex items-center justify-between"
              >
                <span className="font-mono font-medium text-amber-500">{c.name}</span>
                <span className="text-[10px] text-muted-foreground">{c.desc}</span>
              </button>
            ))}
          </div>
        )}

        <div className={cn(
          'rounded-2xl border bg-card shadow-sm transition focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary overflow-visible',
          'border-border',
        )}>
          {voiceActive ? (
            <div className="h-[96px] w-full flex flex-col items-center justify-center bg-background/90 backdrop-blur-sm space-y-2 text-foreground">
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
                  e.target.style.height = Math.min(e.target.scrollHeight, 240) + 'px';
                }}
                onKeyDown={onKey}
                placeholder={streaming ? 'August is working…' : (currentModel ? `Message ${modelDisplayParts(currentModel.id).name}…` : 'Type a message…')}
                rows={1}
                disabled={streaming}
                className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-xs outline-none placeholder:text-muted-foreground disabled:opacity-60"
                style={{ minHeight: '40px', maxHeight: '240px' }}
              />
            </>
          )}

          <div className="flex items-center justify-between px-1.5 pb-1.5">
            <div className="flex items-center text-muted-foreground">
              <ToolBtn Icon={Paperclip} label="Attach file" onClick={() => fileInputRef.current?.click()} />
              <ToolBtn Icon={AtSign}    label="Mention tool" onClick={() => { setShowToolsDropdown(!showToolsDropdown); setShowCommandsDropdown(false); }} />
              <ToolBtn Icon={Mic}       label="Voice input" onClick={startVoiceInput} />
            </div>
            <div className="flex items-center gap-2">
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
                <Button onClick={send} disabled={!input.trim() && attachments.length === 0} size="sm">
                  <Send className="size-3" />
                  Send
                  <kbd className="ml-1 rounded bg-muted/20 border border-border/20 px-1 text-[10px] font-mono">↵</kbd>
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Usage tracker — minimal, no static hint text */}
        <div className="flex items-center justify-end mt-1 px-1">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
            <span className="relative w-20 h-1.5 rounded-full bg-muted overflow-hidden inline-block">
              <span
                className={cn('absolute inset-y-0 left-0 rounded-full transition-all duration-300', pct > 80 ? 'bg-destructive' : pct > 60 ? 'bg-amber-500' : 'bg-primary')}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span>{pct}%</span>
            <span className="text-muted-foreground/50">·</span>
            <span className="text-muted-foreground/70">{estTokens.toLocaleString()} / {maxContext.toLocaleString()}</span>
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
                <div className="w-full max-w-3xl">
                  <h2 className="text-3xl font-semibold tracking-tight text-foreground/90 font-sans text-center mb-8">
                    August
                  </h2>
                  <div className="w-full">
                    {renderComposerContent()}
                  </div>
                  <p className="text-[10px] text-muted-foreground/40 text-center mt-3 font-sans">
                    How can I help you code today?
                  </p>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="thread-scroll-view"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex-1 flex flex-col min-h-0"
              >
                <div
                  ref={scrollRef}
                  className="flex-1 overflow-y-auto"
                  style={{ overflowAnchor: 'none' }}
                >
                  <div className="max-w-3xl mx-auto px-6 py-8 space-y-5 relative">
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
                          />
                        </div>
                      );
                    })}
                    {streaming && (() => {
                      const lastMsg = messages[messages.length - 1];
                      if (!lastMsg || lastMsg.role !== 'assistant') return <ThinkingIndicator />;
                      const parsed = parseThinkingAndContent(lastMsg.content, lastMsg.thinking);
                      return (!parsed.thinking && !parsed.content) ? <ThinkingIndicator /> : null;
                    })()}
                  </div>
                </div>

                {/* Composer at the bottom when there are messages */}
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                  className="shrink-0 z-10 w-full bg-background px-4 py-3"
                >
                  <div className="max-w-3xl mx-auto">
                    {renderComposerContent()}
                  </div>
                </motion.div>
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
  return (
    <div className="my-1" style={{ overflowAnchor: 'none' }}>
      <ThinkingDisclosure pending={isGenerating} duration={duration}>
        <div className="pl-3 border-l border-foreground/15 leading-relaxed py-1 thought-content text-xs">
          <Markdown content={text} />
        </div>
      </ThinkingDisclosure>
    </div>
  );
}

// ── Tool execution block ──
function ToolBlock({ tools }: { tools: NonNullable<ChatMessage['tools']> }) {
  return (
    <>
      {tools.map((tool) => (
        <ToolCallItemComp key={tool.id} tool={tool} />
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
}: {
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  onRevert?: () => void;
  onEdit?: (text: string) => void;
  onRegenerate?: () => void;
  onClarifyAnswer?: (answer: string) => void;
}) {
  const [showActions, setShowActions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [copied, setCopied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const [showRaw, setShowRaw] = useState(false);

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
    return <ToolCallCard tool={message.tool!} timestamp={message.timestamp} />;
  }
  const isUser = message.role === 'user';

  const displayBlocks = useMemo(() => {
    if (isUser) return [];
    return getDisplayBlocks(message.blocks, message.thinking, message.tools, message.content);
  }, [message.blocks, message.thinking, message.tools, message.content, isUser]);

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
          question={message.clarify.question}
          choices={message.clarify.choices}
          onSubmit={onClarifyAnswer}
        />
      )}
      {!isUser && message.todos && message.todos.length > 0 && (
        <HoistedTodoPanel todos={message.todos} />
      )}
      {isUser ? (
        <>
          <div className="rounded-2xl border border-border/40 bg-muted/40 dark:bg-[#161618] px-4 py-2.5 text-xs leading-relaxed text-foreground shadow-sm max-w-[85%] ml-auto">
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
                  <button onClick={cancelEdit} className="px-2 py-0.5 text-[10px] rounded-md hover:bg-muted text-muted-foreground transition">Cancel</button>
                  <button onClick={saveEdit} className="px-2 py-0.5 text-[10px] rounded-md bg-primary text-primary-foreground hover:opacity-90 transition">Save</button>
                </div>
              </div>
            ) : (
              <Markdown content={message.content} />
            )}
          </div>
          {/* Action buttons below user message */}
          <div className={cn(
            "flex items-center gap-0.5 mt-1 mr-1 transition-opacity duration-150",
            showActions ? "opacity-100" : "opacity-0"
          )}
            style={{ alignSelf: 'flex-end' }}>
            <button
              onClick={handleCopy}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition relative"
              title="Copy"
            >
              <div className={cn("transition-transform duration-200", copied ? "scale-110 text-green-500" : "scale-100")}>
                {copied ? (
                  <Check className="size-3" />
                ) : (
                  <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                )}
              </div>
            </button>
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
              displayBlocks.map((block, index) => {
                if (block.type === 'thinking') {
                  return (
                    <ReasoningBlock
                      key={block.id || `think_${index}`}
                      text={block.content || ''}
                      isGenerating={isLast && streaming && index === displayBlocks.length - 1}
                      duration={message.thinkingDuration}
                    />
                  );
                } else if (block.type === 'tool_call' || block.type === 'command') {
                  if (!block.tool) return null;
                  return (
                    <div key={block.id || `tool_${index}`} className="my-1">
                      <ToolCallItemComp tool={block.tool} />
                    </div>
                  );
                } else if (block.type === 'final_output') {
                  if (!block.content) return null;
                  return (
                    <div key={block.id || `out_${index}`} className="text-xs leading-relaxed text-foreground/90 space-y-3 max-w-none">
                      <Markdown content={block.content} />
                    </div>
                  );
                }
                return null;
              })
            )}
            {isLast && streaming && <WorkingIndicator className="mt-2" />}
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
              <div className={cn("transition-transform duration-200", copied ? "scale-110 text-green-500" : "scale-100")}>
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

function ToolCallCard({ tool, timestamp }: { tool: NonNullable<ChatMessage['tool']>; timestamp: string }) {
  const [open, setOpen] = useState(false);
  const hasBody = !!(tool.args || tool.result);
  const ToolIcon = getToolIcon(tool.name);
  return (
    <div className="text-sm text-muted-foreground w-full py-0.5" data-slot="tool-block">
      <DisclosureRow
        onToggle={hasBody ? () => setOpen(!open) : undefined}
        open={open}
        trailing={
          tool.duration !== undefined && (
            <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
              {tool.duration}ms
            </span>
          )
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <ToolIcon className="size-3.5 shrink-0 text-primary" />
          <span
            className={cn(
              'text-sm font-medium leading-5',
              tool.status === 'running' && 'shimmer text-foreground/55'
            )}
          >
            <span className={cn('thinking-text', tool.status === 'running' && 'animating')}>
              <span className="thinking-label">
                {Array.from(tool.name).map((ch, i) => (
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

function ThinkingIndicator() {
  return (
    <div className="flex gap-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono pt-1">
        <span className="thinking-text animating">
          <span className="thinking-label">
            <span className="thinking-char thinking-cap" style={{ animationDelay: '0ms' }}>A</span>
            <span className="thinking-char" style={{ animationDelay: '100ms' }}>u</span>
            <span className="thinking-char" style={{ animationDelay: '200ms' }}>g</span>
            <span className="thinking-char" style={{ animationDelay: '300ms' }}>u</span>
            <span className="thinking-char" style={{ animationDelay: '400ms' }}>s</span>
            <span className="thinking-char" style={{ animationDelay: '500ms' }}>t</span>
          </span>
          <span className="thinking-dots">
            <span className="dot" style={{ animationDelay: '0ms' }}>.</span>
            <span className="dot" style={{ animationDelay: '200ms' }}>.</span>
            <span className="dot" style={{ animationDelay: '400ms' }}>.</span>
          </span>
        </span>
      </div>
    </div>
  );
}

function EmptyState({ onPrompt }: { onPrompt: (p: string) => void }) {
  const examples = [
    { title: 'Refactor the localhost UI',           desc: 'Plan + implement a Tauri-based rewrite' },
    { title: 'Diagnose why Providers tab is empty', desc: 'Investigate the loadProviderList hoisting bug' },
    { title: 'Set up Tailwind v4 with @theme inline', desc: 'Migrate design tokens to the v4 way' },
    { title: 'Add a settings overlay (Cmd+,)',      desc: 'Replace 12 top-level routes with one panel' },
  ];
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <div className="text-center mb-10">
        <div className="inline-flex size-14 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-500 text-white items-center justify-center mb-4 shadow-lg">
          <Sparkles className="size-7" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">How can I help?</h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
          Ask August anything. Same tools, memory, and skills as the CLI.
          Press <kbd className="rounded border border-border bg-muted px-1 font-mono">⌘K</kbd> for commands.
        </p>
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        {examples.map((ex) => (
          <button
            key={ex.title}
            onClick={() => onPrompt(ex.title)}
            className="text-left rounded-xl border border-border bg-card hover:bg-accent/30 transition px-4 py-3 group"
          >
            <p className="text-sm font-medium flex items-center gap-1">
              {ex.title}
              <ChevronRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">{ex.desc}</p>
          </button>
        ))}
      </div>
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
    updatePositions();
    const onScroll = () => updatePositions();
    const onResize = () => updatePositions();
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
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

function ToolBtn({ Icon, label, onClick }: { Icon: any; label: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="p-2 hover:bg-accent rounded-md transition text-muted-foreground hover:text-foreground"
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
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollEnd, setScrollEnd] = useState(false);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setSearchQuery(''); setExpandedProviders(new Set()); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 50);
    else { setSearchQuery(''); setExpandedProviders(new Set()); }
  }, [open]);

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

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 text-sm font-sans outline-none cursor-pointer shrink-0',
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
        <span className="truncate max-w-[200px] font-medium text-foreground transition-all duration-200">{selected ? modelDisplayParts(selected.id || selected.name || '').name : 'model'}</span>
        <svg className={cn("size-3 shrink-0 opacity-60 ml-0.5 transition-transform duration-200", open && "rotate-180")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            className="absolute bottom-full mb-1 right-0 z-50 min-w-[240px] max-w-[320px] bg-popover rounded-lg shadow-2xl overflow-hidden origin-bottom-right"
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
                className="max-h-[240px] overflow-y-auto py-0.5"
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
    </div>
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
          'flex items-center gap-1.5 text-sm outline-none cursor-pointer',
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
          for (const sub of parsed) {
            result.push({
              id: `${block.id}_sub_${sub.type}_${Math.random().toString(36).slice(2, 6)}`,
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
        id: `fallback_think_${Date.now()}`,
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
      for (const sub of parsed) {
        resultFallback.push({
          id: `fallback_content_sub_${sub.type}_${Math.random().toString(36).slice(2, 6)}`,
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
    id: `fallback_raw_${Date.now()}`,
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

function Markdown({ content }: { content: string }) {
  if (!content) return null;
  const html = marked.parse(content) as string;

  return (
    <div 
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
