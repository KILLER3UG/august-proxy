/* ── ChatThreadComposer ───────────────────────────────────────────────── */
/* Message box: attachments, @skills/tools, /commands, queue pills, mode,   */
/* model/effort, context ring, send / mid-run steer, stop.                 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { Send, Paperclip, Mic, AtSign, Plus, StopCircle, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';
import { updateSessionModel } from '@/store/sessions';
import { voiceCommandEvents } from '@/api/voice/registry-events';
import { getDisplayCommands } from '@/api/voice/registry';
import { setWorkbenchGuardMode } from '@/api/workbench';
import type { WorkbenchSession } from '@/types/workbench';
import type { ChatMessage, FileAttachment } from '@/types/chat';
import {
  WorkbenchModeSelector,
  type WorkbenchGuardMode,
} from '@/components/chat/WorkbenchModeSelector';
import { ProjectRulesBadge } from '@/components/chat/ProjectRulesBadge';
import { WorkspaceSelector } from '@/components/workspace/WorkspaceSelector';
import { getFileIcon } from '@/lib/file-icon';
import { QueuePills } from './QueuePills';
import type { QueuedUserMessage } from './queue-store';
import { ModelDropdown, EffortDropdown, ToolBtn } from './ComposerControls';
import { ContextRing, type ContextBreakdown } from './ChatComposer';
import { Markdown } from './ChatMarkdown';
import { COMPOSER_TOOLS as TOOLS, parseAtMention, type MentionItem } from './composer-mentions';
import type { ModelItem } from './model-display';
import type { SessionUsageState } from './hooks/useChatUsage';
import type { EffortLevel } from './hooks/useChatSend';

/** Closers useChatSend calls after a send so open popovers dismiss. */
export type ComposerDropdownApi = {
  setShowToolsDropdown: (open: boolean) => void;
  setShowCommandsDropdown: (open: boolean) => void;
};

export interface ChatThreadComposerProps {
  sessionId: string | null;
  loadedSessionId: string | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  attachments: FileAttachment[];
  removeAttachment: (index: number) => void;
  handleComposerPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  messages: ChatMessage[];
  streaming: boolean;
  send: (textOverride?: string) => Promise<void>;
  stop: () => void;
  queuedMessages: QueuedUserMessage[];
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
  activeWorkbenchSessionId?: string | null;
  /** Context ring inputs */
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
  voiceActive: boolean;
  startVoiceInput: () => void;
  /** Optional: parent registers send-path popover closers. */
  dropdownApiRef?: MutableRefObject<ComposerDropdownApi | null>;
}

/**
 * Bottom (or empty-state) message composer: textarea, popovers, toolbar.
 */
export function ChatThreadComposer(props: ChatThreadComposerProps) {
  const {
    sessionId,
    loadedSessionId,
    input,
    setInput,
    attachments,
    removeAttachment,
    handleComposerPaste,
    handleFileUpload,
    messages,
    streaming,
    send,
    stop,
    queuedMessages,
    workbenchSession,
    setWorkbenchSession,
    workbenchMode,
    setWorkbenchMode,
    workspacePath,
    activeWorkbenchSessionId,
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
    voiceActive,
    startVoiceInput,
    dropdownApiRef,
  } = props;

  const [showComposerActionsDropdown, setShowComposerActionsDropdown] = useState(false);
  const [showToolsDropdown, setShowToolsDropdown] = useState(false);
  const [showCommandsDropdown, setShowCommandsDropdown] = useState(false);
  const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(0);
  const [skillMentions, setSkillMentions] = useState<MentionItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);
  // Live markdown preview is opt-in; toolbar toggle removed for now.
  // TODO: re-enable via keyboard shortcut (e.g. Ctrl/Cmd+Shift+P)
  const [showPreview, setShowPreview] = useState(false);
  void setShowPreview;

  const composerActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const composerRootRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [composerActionsPos, setComposerActionsPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [toolsPos, setToolsPos] = useState<{ top: number; left: number } | null>(null);
  const [commandsPos, setCommandsPos] = useState<{ top: number; left: number } | null>(null);

  // Expose popover closers to useChatSend (dismiss after message send).
  useEffect(() => {
    if (!dropdownApiRef) return;
    dropdownApiRef.current = {
      setShowToolsDropdown,
      setShowCommandsDropdown,
    };
    return () => {
      dropdownApiRef.current = null;
    };
  }, [dropdownApiRef]);

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

  useEffect(() => {
    if (mentionQuery === null) return;
    let cancelled = false;
    setSkillsLoading(true);
    const q = mentionQuery.trim();
    const url = '/api/skills' + (q ? `?q=${encodeURIComponent(q)}` : '');
    api
      .get<{ total: number; skills: Array<{ name: string; description?: string; category?: string }> }>(
        url,
      )
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

  useEffect(() => {
    const anyOpen =
      showComposerActionsDropdown ||
      showToolsDropdown ||
      showCommandsDropdown ||
      showMentionsDropdown;
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
  }, [
    showComposerActionsDropdown,
    showToolsDropdown,
    showCommandsDropdown,
    showMentionsDropdown,
  ]);

  const insertText = useCallback(
    (text: string) => {
      const ta = taRef.current;
      if (!ta) {
        setInput((prev) => prev + text);
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
    },
    [setInput],
  );

  const insertCommand = useCallback(
    (name: string) => {
      const fullCmd = name + ' ';
      const ta = taRef.current;
      if (!ta) {
        setInput(() => '/' + name + ' ');
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
    },
    [setInput],
  );

  const insertMention = useCallback(
    (item: MentionItem) => {
      setMentionQuery(null);
      setShowToolsDropdown(false);
      if (item.kind === 'skill') {
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
    },
    [input, mentionStart, setInput],
  );

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionsDropdown && mentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedMentionIndex(
          (i) => (i - 1 + mentionItems.length) % mentionItems.length,
        );
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
      const visible = allCommands.filter((c) => {
        const q = input.trim().toLowerCase();
        if (!q) return true;
        return c.name.toLowerCase().startsWith(q);
      });
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedCommandIndex((i) => (i + 1) % Math.max(1, visible.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedCommandIndex(
          (i) => (i - 1 + Math.max(1, visible.length)) % Math.max(1, visible.length),
        );
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && visible.length > 0) {
        e.preventDefault();
        const cmd = visible[highlightedCommandIndex] ?? visible[0];
        insertCommand(cmd.name);
        setShowCommandsDropdown(false);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowCommandsDropdown(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const handleInputChange = (value: string) => {
    setInput(value);
    setHighlightedCommandIndex(0);
    setHighlightedMentionIndex(0);
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

  // Insert-text custom event from other UI (e.g. cards) into the composer.
  useEffect(() => {
    const handleInsertText = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      if (customEvent.detail) {
        insertText(customEvent.detail);
      }
    };
    window.addEventListener('august-insert-composer-text', handleInsertText);
    return () => {
      window.removeEventListener('august-insert-composer-text', handleInsertText);
    };
  }, [insertText]);

  return (
    <div className="relative" ref={composerRootRef}>
      <input
        type="file"
        ref={fileInputRef}
        onChange={(e) => {
          void handleFileUpload(e);
        }}
        multiple
        className="hidden"
      />

      {(showToolsDropdown || showMentionsDropdown) &&
        toolsPos &&
        createPortal(
          <div
            data-composer-popover
            data-testid="mention-picker"
            style={{
              position: 'fixed',
              top: toolsPos.top,
              left: toolsPos.left,
              transform: 'translateY(-100%)',
            }}
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
            {(mentionQuery !== null
              ? mentionItems
              : [
                  ...skillMentions.slice(0, 12),
                  ...TOOLS.map((t) => ({
                    kind: 'tool' as const,
                    name: t.name,
                    desc: t.desc,
                    insert: `${t.name} `,
                  })),
                ]
            ).map((item, idx) => (
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
                  mentionQuery !== null &&
                    idx === highlightedMentionIndex &&
                    'bg-muted',
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
                Type <span className="font-mono text-foreground/80">@</span> to search
                skills, or pick a tool below.
              </div>
            )}
          </div>,
          document.body,
        )}

      {showCommandsDropdown &&
        commandsPos &&
        createPortal(
          <div
            data-composer-popover
            style={{
              position: 'fixed',
              top: commandsPos.top,
              left: commandsPos.left,
              transform: 'translateY(-100%)',
            }}
            className="z-50 w-72 bg-card border border-border shadow-2xl rounded-xl p-1.5 space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150"
          >
            <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase font-semibold">
              Commands & Tools
            </div>
            {getDisplayCommands()
              .filter((c) => {
                const q = input.trim().toLowerCase().split(/\s+/)[0];
                if (!q) return true;
                return c.name.toLowerCase().startsWith(q);
              })
              .map((c, idx) => (
                <button
                  key={c.name}
                  onClick={() => {
                    insertCommand(c.name);
                    setShowCommandsDropdown(false);
                  }}
                  className={cn(
                    'w-full text-left rounded-md px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition flex items-center justify-between gap-2',
                    idx === highlightedCommandIndex && 'bg-muted',
                  )}
                >
                  <span className="font-mono font-medium text-warning shrink-0">{c.name}</span>
                  <span className="text-[10px] text-muted-foreground truncate">{c.desc}</span>
                </button>
              ))}
            {getDisplayCommands().filter((c) => {
              const q = input.trim().toLowerCase().split(/\s+/)[0];
              if (!q) return false;
              return c.name.toLowerCase().startsWith(q);
            }).length === 0 &&
              input.trim() && (
                <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
                  No matching command. Press Enter to send as a normal message.
                </div>
              )}
          </div>,
          document.body,
        )}

      {queuedMessages.length > 0 && sessionId && (
        <QueuePills
          sessionId={sessionId}
          workbenchSessionId={
            workbenchSession?.id || activeWorkbenchSessionId || sessionId
          }
          items={queuedMessages}
        />
      )}
      {streaming && queuedMessages.length === 0 && (
        <div className="mb-1.5 px-1 text-[10px] text-muted-foreground/80 animate-in fade-in duration-150">
          Tip: type a direction while August works — it applies after the next tool step
          without stopping.
        </div>
      )}

      <div
        className={cn(
          'w-full min-w-0 rounded-2xl border bg-card shadow-sm transition focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary overflow-visible',
          'border-border',
        )}
      >
        {messages.length === 0 && (
          <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/50">
            <WorkspaceSelector
              sessionId={sessionId}
              onWorkspaceChange={(ws) => {
                if (!sessionId || !ws) return;
                void import('@/store/sessions').then(({ createSession, $sessions }) => {
                  const existing = $sessions.get().find((s) => s.workspacePath === ws.path);
                  if (existing) {
                    window.location.href = `/c/${existing.id}`;
                  } else {
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
              <span
                className="w-1 h-6 bg-primary rounded animate-pulse"
                style={{ animationDelay: '150ms' }}
              />
              <span
                className="w-1 h-8 bg-primary rounded animate-pulse"
                style={{ animationDelay: '300ms' }}
              />
              <span
                className="w-1 h-5 bg-primary rounded animate-pulse"
                style={{ animationDelay: '450ms' }}
              />
              <span
                className="w-1 h-3 bg-primary rounded animate-pulse"
                style={{ animationDelay: '600ms' }}
              />
            </div>
            <span className="text-xs font-semibold tracking-wide text-primary animate-pulse">
              August is listening…
            </span>
          </div>
        ) : (
          <>
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 p-2 bg-muted/20 border-b border-border">
                {attachments.map((file, i) => {
                  const fileIcon = getFileIcon(file.name);
                  const IconComponent = fileIcon.Icon;
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-muted border border-border text-[10.5px]"
                    >
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
              {showComposerActionsDropdown &&
                composerActionsPos &&
                createPortal(
                  <div
                    data-composer-popover
                    style={{
                      position: 'fixed',
                      top: composerActionsPos.top,
                      left: composerActionsPos.left,
                      transform: 'translateY(-100%)',
                    }}
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
                        if (skillMentions.length === 0) {
                          api
                            .get<{
                              skills: Array<{
                                name: string;
                                description?: string;
                                category?: string;
                              }>;
                            }>('/api/skills')
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
                  disabled={
                    !sessionId ||
                    loadedSessionId !== sessionId ||
                    (!input.trim() && attachments.length === 0)
                  }
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
                disabled={
                  !sessionId ||
                  loadedSessionId !== sessionId ||
                  (!input.trim() && attachments.length === 0)
                }
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
      </div>
    </div>
  );
}
