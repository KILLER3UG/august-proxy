/* ── Chat thread — Hermes Desktop style ──────────────────────────────── */
/* The main view. User/assistant messages with proper avatars + bubbles.  */
/* Tool calls render as inline cards. Right rail optional.                  */

import { useState, useRef, useEffect, useMemo, useCallback, type KeyboardEvent } from 'react';
import { Send, Paperclip, Mic, AtSign, Sparkles, ChevronRight, Wrench, Check, AlertCircle, StopCircle, X } from 'lucide-react';
import { cn, formatTimeAgo } from '@/lib/utils';
import { mockChatThread } from '@/lib/mock';
import { Button } from '@/components/ui/button';
import { marked } from 'marked';
import { toast } from 'sonner';
import { useStore } from '@nanostores/react';
import { $sessions } from '@/store/sessions';
import { motion, AnimatePresence } from 'framer-motion';

// Configure marked to support GitHub Flavored Markdown and breaks
marked.use({
  gfm: true,
  breaks: true
});

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
  thinking?: string;
  thinkingDuration?: number;
}

interface ModelItem {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  isFree?: boolean;
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
  const [streaming, setStreaming] = useState(false);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selectedModel, setSelectedModel] = useState<ModelItem | null>(null);
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>('medium');
  const [revertingIndex, setRevertingIndex] = useState<number | null>(null);

  // Composer tools states
  const [attachments, setAttachments] = useState<{ name: string; size: string }[]>([]);
  const [voiceActive, setVoiceActive] = useState(false);
  const [showToolsDropdown, setShowToolsDropdown] = useState(false);
  const [showCommandsDropdown, setShowCommandsDropdown] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  // Load models and config on mount to sync selected model with backend
  useEffect(() => {
    let active = true;
    const loadModelsAndConfig = async () => {
      try {
        const [modelsRes, configRes] = await Promise.all([
          fetch('/api/models'),
          fetch('/ui/config/safe')
        ]);

        let loadedModels: ModelItem[] = [];
        let activeModelId: string | null = null;

        if (modelsRes.ok) {
          const data = await modelsRes.json();
          if (data?.models) {
            loadedModels = data.models;
          }
        }

        if (configRes.ok) {
          const config = await configRes.json();
          const activeProvider = config?.activeProvider || 'opencode-go';
          const pConfig = config?.[activeProvider] || {};
          activeModelId = pConfig.model || pConfig._upstreamModel || pConfig.currentModel || null;
        }

        if (active) {
          if (loadedModels.length > 0) {
            setModels(loadedModels);
            const matched = activeModelId
              ? loadedModels.find(m => m.id === activeModelId || m.id.toLowerCase() === activeModelId.toLowerCase())
              : null;
            setSelectedModel(matched || loadedModels[0]);
          }
        }
      } catch (e) {
        console.error('Failed to load models or config:', e);
      } finally {
        if (active) setModelsLoading(false);
      }
    };
    loadModelsAndConfig();
    return () => { active = false; };
  }, []);

  // Remove hardcoded fallback — rely on API only
  const currentModel = selectedModel || null;

  // Dynamic context usage tracker
  const maxContext = currentModel?.contextWindow || 128000;
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0) + input.length;
  const estTokens = Math.ceil(totalChars / 4) + 120;
  const pct = Math.min(100, Math.round((estTokens / maxContext) * 100));

  const generateAIResponse = async (chatHistory: ChatMessage[]) => {
    setStreaming(true);

    const assistantMsgId = `a${Date.now()}`;
    const abortController = new AbortController();
    abortRef.current = abortController;

    const thinkingStart = Date.now();
    let thinkingEnd: number | null = null;

    setMessages(m => [...m, {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString()
    }]);

    try {
      const res = await fetch('/api/chat', {
        signal: abortController.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: currentModel?.id,
          provider: currentModel?.provider,
          messages: chatHistory.map(m => ({ role: m.role, content: m.content })),
          effort: effort,
          workspacePath: workspacePath
        })
      });

      if (!res.ok) {
        const errMsg = await res.text();
        setMessages(prev => prev.map(msg =>
          msg.id === assistantMsgId ? {
            ...msg,
            content: `⚠️ Failed to get response${currentModel ? ` from ${currentModel.id}` : ''}: ${errMsg}`
          } : msg
        ));
        setStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) {
        setStreaming(false);
        return;
      }

      let assistantContent = '';
      let thinkingContent = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete newline-delimited lines from the buffer
        let lineStart = 0;
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n', lineStart)) >= 0) {
          const line = buffer.slice(lineStart, newlineIdx).trim();
          lineStart = newlineIdx + 1;
          if (!line || line.startsWith(':')) continue;

          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'thinking') {
                thinkingContent += parsed.content || '';
              } else if (parsed.type === 'text' || parsed.type === 'content') {
                if (!thinkingEnd && thinkingContent.trim()) {
                  thinkingEnd = Date.now();
                }
                assistantContent += parsed.content || '';
              } else if (parsed.thinking) {
                thinkingContent += parsed.thinking;
              } else if (parsed.reasoning_content) {
                thinkingContent += parsed.reasoning_content;
              } else if (parsed.choices && parsed.choices[0]?.delta?.reasoning_content) {
                thinkingContent += parsed.choices[0].delta.reasoning_content;
              } else {
                if (!thinkingEnd && thinkingContent.trim()) {
                  thinkingEnd = Date.now();
                }
                assistantContent += parsed.content || data;
              }
            } catch {
              if (!thinkingEnd && thinkingContent.trim()) {
                thinkingEnd = Date.now();
              }
              assistantContent += data;
            }
          } else {
            const thinkMatch = line.match(/<thinking>([\s\S]*?)<\/thinking>/);
            if (thinkMatch) {
              thinkingContent += thinkMatch[1];
              assistantContent += line.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
            } else {
              if (!thinkingEnd && thinkingContent.trim()) {
                thinkingEnd = Date.now();
              }
              assistantContent += line;
            }
          }
        }
        buffer = buffer.slice(lineStart);

        setMessages(prev => prev.map(msg =>
          msg.id === assistantMsgId ? {
            ...msg,
            content: assistantContent,
            thinking: thinkingContent || undefined
          } : msg
        ));
      }

      // Flush any remaining buffer content after stream ends
      if (buffer.trim()) {
        const thinkMatch = buffer.match(/<thinking>([\s\S]*?)<\/thinking>/);
        if (thinkMatch) {
          thinkingContent += thinkMatch[1];
          assistantContent += buffer.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
        } else if (buffer.startsWith('data: ')) {
          const data = buffer.slice(6);
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'thinking') {
              thinkingContent += parsed.content || '';
            } else if (parsed.thinking) {
              thinkingContent += parsed.thinking;
            } else if (parsed.reasoning_content) {
              thinkingContent += parsed.reasoning_content;
            } else {
              if (!thinkingEnd && thinkingContent.trim()) {
                thinkingEnd = Date.now();
              }
              assistantContent += parsed.content || data;
            }
          } catch {
            if (!thinkingEnd && thinkingContent.trim()) {
              thinkingEnd = Date.now();
            }
            assistantContent += data;
          }
        } else {
          if (!thinkingEnd && thinkingContent.trim()) {
            thinkingEnd = Date.now();
          }
          assistantContent += buffer;
        }
      }

      const finalDuration = thinkingEnd && thinkingStart 
        ? Math.round((thinkingEnd - thinkingStart) / 100) / 10 
        : thinkingContent.trim() 
          ? Math.round((Date.now() - thinkingStart) / 100) / 10
          : undefined;

      setMessages(prev => prev.map(msg =>
        msg.id === assistantMsgId ? {
          ...msg,
          content: assistantContent,
          thinking: thinkingContent || undefined,
          thinkingDuration: finalDuration
        } : msg
      ));
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      console.error(e);
      setMessages(prev => prev.map(msg =>
        msg.id === assistantMsgId ? {
          ...msg,
          content: `⚠️ Connection error: ${e.message}`
        } : msg
      ));
    } finally {
      setStreaming(false);
    }
  };

  const send = async () => {
    let text = input.trim();
    if (!text && attachments.length === 0) return;
    if (streaming) return;

    if (attachments.length > 0) {
      const attachInfo = attachments.map(a => `[File Attachment: ${a.name} (${a.size})]`).join('\n');
      text = `${text}\n\n${attachInfo}`;
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
    await generateAIResponse(nextMessages);
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  };

  // ── Revert: delete all messages after this index ──
  const handleRevert = (index: number) => {
    if (streaming) return;
    const deleted = messages.length - index - 1;
    if (deleted <= 0) return;

    const originalMessages = [...messages];
    setRevertingIndex(index);

    setTimeout(() => {
      setMessages(messages.slice(0, index + 1));
      setRevertingIndex(null);

      toast.success("Conversation reverted", {
        description: `Removed ${deleted} message${deleted > 1 ? 's' : ''}`,
        duration: 5000,
        action: {
          label: "Undo",
          onClick: () => {
            setMessages(originalMessages);
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
    const msg = messages[index];
    if (!msg || msg.role !== 'user') return;
    const trimmed = messages.slice(0, index + 1);
    setMessages(trimmed);
    await generateAIResponse(trimmed);
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
    setVoiceActive(true);
    setTimeout(() => {
      setInput(prev => {
        const space = prev.length > 0 && !prev.endsWith(' ') ? ' ' : '';
        return prev + space + "Let's inspect the system status.";
      });
      setVoiceActive(false);
    }, 2500);
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
                placeholder={streaming ? 'August is working…' : (currentModel ? `Message ${currentModel.id}…` : 'Type a message…')}
                rows={1}
                disabled={streaming}
                className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
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
                loading={modelsLoading}
                selected={selectedModel}
                onSelect={async (m) => {
                  if (!m) return;
                  setSelectedModel(m);
                  try {
                    await Promise.all([
                      fetch('/api/config/activeProvider', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ provider: m.provider })
                      }),
                      fetch('/api/config/provider-details', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          provider: m.provider,
                          config: { currentModel: m.id, _upstreamModel: m.id }
                        })
                      })
                    ]);
                  } catch (e) {
                    console.error('Failed to update backend model config:', e);
                  }
                }}
              />
              <EffortDropdown
                value={effort}
                onChange={setEffort}
              />

              {streaming ? (
                <Button onClick={stop} size="sm" variant="outline">
                  <StopCircle className="size-3" /> Stop
                </Button>
              ) : (
                <Button onClick={send} disabled={!input.trim() && attachments.length === 0} size="sm">
                  <Send className="size-3" />
                  Send
                  <kbd className="ml-1 rounded bg-primary-foreground/20 px-1 text-[10px] font-mono">↵</kbd>
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Usage tracker — minimal, no static hint text */}
        <div className="flex items-center justify-end mt-1 px-1">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono">
            <span className="relative w-16 h-1 rounded-full bg-muted overflow-hidden inline-block">
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
      <div className="flex-1 flex flex-col min-w-0 bg-background h-full overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {messages.length === 0 ? (
            // Centered layout for new session
            <motion.div
              key="centered-composer"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="flex-1 flex flex-col justify-center px-6 w-full"
            >
              <div className="w-full max-w-3xl mx-auto">
                {/* Brand / Logo or clean Welcome text */}
                <div className="text-center mb-8">
                  <h2 className="text-3xl font-semibold tracking-tight text-foreground/90 font-sans">August</h2>
                  <p className="text-xs text-muted-foreground/50 mt-1.5 font-sans">How can I help you code today?</p>
                </div>
                {renderComposerContent()}
              </div>
            </motion.div>
          ) : (
            // Regular layout with messages
            <motion.div
              key="thread-and-composer"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.15 }}
              className="flex-1 flex flex-col min-h-0 overflow-hidden"
            >
              {/* Thread */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto">
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
                    return !parsed.thinking ? <ThinkingIndicator /> : null;
                  })()}
                </div>
              </div>

              {/* Composer at the bottom */}
              <div className="bg-background px-4 py-3 shrink-0 border-t border-border/20">
                {renderComposerContent()}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Hidden File Input */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          multiple
          className="hidden"
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
// [NEW/REFACTORED] ReasoningBlock
// ----------------------------------------------------
function ReasoningBlock({ text, isGenerating, duration }: { text: string; isGenerating?: boolean; duration?: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    if (!isGenerating) return;
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed((Date.now() - start) / 1000);
    }, 100);
    return () => clearInterval(interval);
  }, [isGenerating]);

  const displayDuration = isGenerating
    ? elapsed.toFixed(1) + 's'
    : duration
      ? duration.toFixed(1) + 's'
      : null;

  return (
    <div
      className="text-xs my-2 select-none"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition py-1"
      >
        <span className="font-semibold flex items-center">
          <span className={cn("thinking-text flex items-center", isGenerating && "animating")}>
            <span className="thinking-label">
              <span className="thinking-char thinking-cap" style={{ animationDelay: '0ms' }}>T</span>
              <span className="thinking-char" style={{ animationDelay: '100ms' }}>h</span>
              <span className="thinking-char" style={{ animationDelay: '200ms' }}>i</span>
              <span className="thinking-char" style={{ animationDelay: '300ms' }}>n</span>
              <span className="thinking-char" style={{ animationDelay: '400ms' }}>k</span>
              <span className="thinking-char" style={{ animationDelay: '500ms' }}>i</span>
              <span className="thinking-char" style={{ animationDelay: '600ms' }}>n</span>
              <span className="thinking-char" style={{ animationDelay: '700ms' }}>g</span>
            </span>
            {isGenerating && (
              <span className="thinking-dots">
                <span className="dot" style={{ animationDelay: '0ms' }}>.</span>
                <span className="dot" style={{ animationDelay: '200ms' }}>.</span>
                <span className="dot" style={{ animationDelay: '400ms' }}>.</span>
              </span>
            )}
          </span>
        </span>
        {displayDuration && (
          <span className="text-muted-foreground/60 text-[10px] ml-1">
            {isHovered && '> '}{displayDuration}
          </span>
        )}
      </button>

      <div
        className={cn(
          "overflow-hidden transition-all duration-300 ease-in-out",
          isOpen ? "max-h-[5000px] opacity-100" : "max-h-0 opacity-0"
        )}
      >
        <div className={cn(
          "pl-3 border-l border-foreground/15 text-foreground/50 leading-relaxed py-1",
          isGenerating && "thinking-content-generating"
        )}>
          <Markdown content={text} />
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------
// [NEW/REFACTORED] MessageBubble
// ----------------------------------------------------
function MessageBubble({
  message,
  isLast,
  streaming,
  onRevert,
  onEdit,
  onRegenerate,
}: {
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  onRevert?: () => void;
  onEdit?: (text: string) => void;
  onRegenerate?: () => void;
}) {
  const [showActions, setShowActions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [copied, setCopied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

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

  const handleCopy = () => {
    const textToCopy = isUser ? message.content : parsed.content;
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

  if (message.role === 'tool') {
    return <ToolCallCard tool={message.tool!} timestamp={message.timestamp} />;
  }
  const isUser = message.role === 'user';

  const parsed = useMemo(() => {
    if (isUser) return { thinking: '', content: message.content };
    return parseThinkingAndContent(message.content, message.thinking);
  }, [message.content, message.thinking, isUser]);

  return (
    <div
      id={`msg-${message.id}`}
      className="w-full flex flex-col"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {!isUser && parsed.thinking && (
        <ReasoningBlock text={parsed.thinking} isGenerating={isLast && streaming && !parsed.content} duration={message.thinkingDuration} />
      )}
      {isUser ? (
        <>
          <div className="rounded-2xl border border-border/40 bg-muted/40 dark:bg-[#161618] px-4 py-2.5 text-sm leading-relaxed text-foreground shadow-sm max-w-[85%] ml-auto">
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
        <div className="text-sm leading-relaxed text-foreground/90 space-y-3 max-w-none group relative">
          <Markdown content={parsed.content} />
          {/* Copy button for assistant messages on hover */}
          <button
            onClick={handleCopy}
            className={cn(
              "absolute top-0 right-0 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-opacity duration-150",
              showActions ? "opacity-100" : "opacity-0"
            )}
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
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ tool, timestamp }: { tool: NonNullable<ChatMessage['tool']>; timestamp: string }) {
  return (
    <div className="group flex gap-3 my-2">
      <div className="shrink-0">
        <div className="size-8 rounded-full bg-muted text-muted-foreground grid place-items-center ring-1 ring-border">
          <Wrench className="size-4" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5 text-xs">
          <span className="font-mono font-semibold text-foreground">{tool.name}</span>
          {tool.status === 'running' && (
            <span className="text-[10px] text-amber-600 inline-flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" /> running
            </span>
          )}
          {tool.status === 'done' && (
            <span className="text-[10px] text-primary inline-flex items-center gap-1">
              <Check className="size-2.5" /> {tool.duration}ms
            </span>
          )}
          {tool.status === 'error' && (
            <span className="text-[10px] text-destructive inline-flex items-center gap-1">
              <AlertCircle className="size-2.5" /> error
            </span>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto">{formatTimeAgo(timestamp)}</span>
        </div>
        <div className="rounded-xl border border-border bg-muted/30 overflow-hidden text-xs">
          {tool.args && (
            <details className="border-b border-border" open>
              <summary className="px-3 py-1.5 bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground transition flex items-center gap-1 select-none">
                <ChevronRight className="size-3 transition group-open:rotate-90" /> arguments
              </summary>
              <pre className="px-3 py-2 font-mono whitespace-pre-wrap bg-background/60 text-[11px]">{tool.args}</pre>
            </details>
          )}
          {tool.result && (
            <div className="px-3 py-2 font-mono whitespace-pre-wrap text-[11px]">{tool.result}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex gap-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono pt-1">
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

/* ── Custom Model Dropdown ────────────────────────────────────────── */
function ModelDropdown({ models, loading, selected, onSelect }: {
  models: ModelItem[];
  loading?: boolean;
  selected: ModelItem | null;
  onSelect: (m: ModelItem | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollEnd, setScrollEnd] = useState(false);

  // Strip provider prefix from model IDs (e.g. "opencode-go/claude-opus-4-7" → "claude-opus-4-7")
  const displayName = (id: string) => {
    const slashIdx = id.indexOf('/');
    const colonIdx = id.indexOf(':');
    const sep = slashIdx >= 0 ? slashIdx : colonIdx >= 0 ? colonIdx : -1;
    return sep >= 0 ? id.slice(sep + 1) : id;
  };

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
    ? models.filter(m =>
        m.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        displayName(m.id).toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.provider.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : models;

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
      return displayName(a.id).localeCompare(displayName(b.id));
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
          'flex items-center gap-1 text-xs font-mono outline-none cursor-pointer truncate max-w-[150px]',
          'text-muted-foreground hover:text-foreground transition',
          'bg-muted/40 border border-border rounded-lg px-2 py-1',
        )}
        title={selected?.id || 'Select model'}
      >
        <span className="truncate">{selected ? displayName(selected.id) : 'model'}</span>
        <svg className="size-3 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full mb-1 right-0 z-50 min-w-[220px] max-w-[300px] bg-card border border-border rounded-lg shadow-2xl overflow-hidden">
          {/* Search bar */}
          <div className="px-1.5 pt-1.5 pb-0.5 bg-card">
            <div className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 border border-border/50">
              <svg className="size-2.5 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search…"
                className="bg-transparent text-xs font-mono outline-none w-full placeholder:text-muted-foreground/50 text-foreground py-0.5"
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
            </div>
          </div>

          <div className="relative">
            {/* Top fade indicator */}
            <div className={cn(
              'absolute top-0 left-0 right-0 h-5 z-10 pointer-events-none transition-opacity',
              'bg-gradient-to-b from-card to-transparent',
              scrollTop > 4 ? 'opacity-100' : 'opacity-0'
            )} />
            {/* Bottom fade indicator */}
            <div className={cn(
              'absolute bottom-0 left-0 right-0 h-5 z-10 pointer-events-none transition-opacity',
              'bg-gradient-to-t from-card to-transparent',
              scrollEnd ? 'opacity-0' : 'opacity-100'
            )} />

            <div
              ref={listRef}
              onScroll={onScroll}
              className="max-h-[240px] overflow-y-auto py-0.5"
            >
              {grouped.length === 0 && !loading ? (
                <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                  {searchQuery.trim() ? `No results for "${searchQuery.trim()}"` : 'no models loaded'}
                </div>
              ) : loading && grouped.length === 0 ? (
                <div className="px-3 py-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <svg className="size-3 animate-spin" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="31.4 31.4" />
                  </svg>
                  loading models…
                </div>
              ) : (
                grouped.map(({ provider, visible, isExpanded, total, showCollapse }) => (
                  <div key={provider}>
                    <div className="px-2 py-0.5 text-[10px] uppercase tracking-widest text-muted-foreground/50 font-semibold sticky top-0 bg-card/95 backdrop-blur z-20">
                      {provider}
                    </div>
                    {visible.map(m => (
                      <button
                        key={m.id}
                        onClick={() => { onSelect(m); setOpen(false); }}
                        className={cn(
                          'w-full text-left px-2 py-1 text-xs font-mono transition flex items-center gap-1.5',
                          selected?.id === m.id
                            ? 'text-primary bg-primary/10'
                            : 'text-foreground/80 hover:bg-muted hover:text-foreground'
                        )}
                      >
                        {m.isFree && (
                          <span className="text-[8px] text-green-500 font-semibold uppercase shrink-0">FREE</span>
                        )}
                        <span>{displayName(m.id)}</span>
                      </button>
                    ))}
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
                        className="w-full text-left px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition"
                      >
                        {isExpanded ? '▲ Show less' : '▼ Show ' + (total - 5) + ' more'}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
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

  const options: { value: 'low' | 'medium' | 'high' | 'max'; label: string }[] = [
    { value: 'low', label: 'low' },
    { value: 'medium', label: 'med' },
    { value: 'high', label: 'high' },
    { value: 'max', label: 'max' },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1 text-[10px] font-mono outline-none cursor-pointer',
          'text-muted-foreground hover:text-foreground transition',
          'bg-muted/40 border border-border rounded-lg px-2.5 py-1',
        )}
        title="Thinking Effort"
      >
        <span>{value === 'medium' ? 'med' : value}</span>
        <svg className="size-2.5 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full mb-1.5 right-0 z-50 min-w-[100px] bg-card border border-border rounded-xl shadow-2xl py-1">
          {options.map(opt => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={cn(
                'w-full text-left px-3 py-1.5 text-[11px] font-mono transition',
                value === opt.value
                  ? 'text-primary bg-primary/10'
                  : 'text-foreground/80 hover:bg-muted hover:text-foreground'
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
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

export function parseThinkingAndContent(rawContent: string, existingThinking?: string): { thinking: string; content: string } {
  let thinking = existingThinking || '';
  let content = rawContent || '';

  // Check for explicit markers
  const openMarkers = [
    { open: '<thinking>', close: '</thinking>' },
    { open: '<think>', close: '</think>' },
    { open: '[THINK]', close: '[/THINK]' },
    { open: '[REASONING]', close: '[/REASONING]' }
  ];

  for (const marker of openMarkers) {
    const openIdx = content.indexOf(marker.open);
    if (openIdx !== -1) {
      const closeIdx = content.indexOf(marker.close, openIdx + marker.open.length);
      if (closeIdx !== -1) {
        // Complete tag found
        const extractedThinking = content.slice(openIdx + marker.open.length, closeIdx);
        thinking += (thinking ? '\n' : '') + extractedThinking;
        content = content.slice(0, openIdx) + content.slice(closeIdx + marker.close.length);
      } else {
        // Incomplete tag (still streaming)
        const extractedThinking = content.slice(openIdx + marker.open.length);
        thinking += (thinking ? '\n' : '') + extractedThinking;
        content = content.slice(0, openIdx);
      }
    }
  }

  // Heuristic if no explicit thinking exists and no explicit markers were found
  if (!thinking.trim() && content.trim()) {
    const heuristicTriggers = ["Final Answer:", "Therefore,", "therefore,", "Thus,", "thus,"];
    let triggerIdx = -1;
    let selectedTrigger = "";
    for (const trigger of heuristicTriggers) {
      const idx = content.indexOf(trigger);
      if (idx !== -1 && (triggerIdx === -1 || idx < triggerIdx)) {
        triggerIdx = idx;
        selectedTrigger = trigger;
      }
    }

    if (triggerIdx !== -1) {
      thinking = content.slice(0, triggerIdx);
      content = content.slice(triggerIdx); // Include the trigger itself in the final content!
    } else {
      // Paragraph splitting fallback
      const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim());
      if (paragraphs.length > 1) {
        thinking = paragraphs.slice(0, -1).join('\n\n');
        content = paragraphs[paragraphs.length - 1];
      }
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
