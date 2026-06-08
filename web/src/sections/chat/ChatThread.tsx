/* ── Chat thread — Hermes Desktop style ──────────────────────────────── */
/* The main view. User/assistant messages with proper avatars + bubbles.  */
/* Tool calls render as inline cards. Right rail optional.                  */

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Send, Paperclip, Mic, AtSign, Sparkles, ChevronRight, Wrench, Check, AlertCircle, StopCircle, X, File } from 'lucide-react';
import { cn, formatTimeAgo } from '@/lib/utils';
import { mockChatThread } from '@/lib/mock';
import { Button } from '@/components/ui/button';

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
}

interface ModelItem {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
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
  const [messages, setMessages] = useState<ChatMessage[]>(() => buildDemoThread(sessionId));
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelItem | null>(null);
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>('medium');

  // Composer tools states
  const [attachments, setAttachments] = useState<{ name: string; size: string }[]>([]);
  const [voiceActive, setVoiceActive] = useState(false);
  const [showToolsDropdown, setShowToolsDropdown] = useState(false);
  const [showCommandsDropdown, setShowCommandsDropdown] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  useEffect(() => { setMessages(buildDemoThread(sessionId)); }, [sessionId]);

  // Load models on mount
  useEffect(() => {
    let active = true;
    const loadModels = async () => {
      try {
        const res = await fetch('/api/models');
        if (res.ok) {
          const data = await res.json();
          if (active && data?.models && data.models.length > 0) {
            setModels(data.models);
            setSelectedModel(data.models[0]);
          }
        }
      } catch (e) {
        console.error('Failed to load models:', e);
      }
    };
    loadModels();
    return () => { active = false; };
  }, []);

  // Remove hardcoded fallback — rely on API only
  const currentModel = selectedModel || null;

  // Dynamic context usage tracker
  const maxContext = currentModel?.contextWindow || 128000;
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0) + input.length;
  const estTokens = Math.ceil(totalChars / 4) + 120;
  const pct = Math.min(100, Math.round((estTokens / maxContext) * 100));

  const send = async () => {
    let text = input.trim();
    if (!text && attachments.length === 0) return;
    if (streaming) return;

    if (attachments.length > 0) {
      const attachInfo = attachments.map(a => `[File Attachment: ${a.name} (${a.size})]`).join('\\n');
      text = `${text}\\n\\n${attachInfo}`;
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
    setStreaming(true);

    const assistantMsgId = `a${Date.now()}`;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: currentModel?.id,
          messages: nextMessages.map(m => ({ role: m.role, content: m.content })),
          effort: effort
        })
      });

      if (!res.ok) {
        const errMsg = await res.text();
        setMessages(m => [...m, {
          id: assistantMsgId,
          role: 'assistant',
          content: `⚠️ Failed to get response${currentModel ? ` from ${currentModel.id}` : ''}: ${errMsg}`,
          timestamp: new Date().toISOString()
        }]);
        setStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) {
        setStreaming(false);
        return;
      }

      setMessages(m => [...m, {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString()
      }]);

      let assistantContent = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        assistantContent += chunk;
        setMessages(prev => prev.map(msg => 
          msg.id === assistantMsgId ? { ...msg, content: assistantContent } : msg
        ));
      }
    } catch (e: any) {
      console.error(e);
      setMessages(m => [...m, {
        id: assistantMsgId,
        role: 'assistant',
        content: `⚠️ Connection error: ${e.message}`,
        timestamp: new Date().toISOString()
      }]);
    } finally {
      setStreaming(false);
    }
  };

  const stop = () => setStreaming(false);

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
    const nextText = input.substring(0, start) + text + input.substring(end);
    setInput(nextText);
    setTimeout(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + text.length;
    }, 50);
  };

  const [showActionsBubbleId, setShowActionsBubbleId] = useState<string | null>(null);

  const copyMessage = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };

  const editAndResend = (text: string) => {
    setInput(text);
    taRef.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 relative">
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {/* Thread */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <EmptyState onPrompt={(p) => setInput(p)} />
          ) : (
            <div className="max-w-3xl mx-auto px-6 py-8 space-y-5">
              {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
              {streaming && <ThinkingIndicator />}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="bg-background px-4 py-3 shrink-0 border-t border-transparent">
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
              'rounded-2xl border bg-card shadow-sm transition focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary relative overflow-hidden',
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
                  <div className="flex items-center gap-1.5 border border-border bg-muted/40 rounded-lg px-2.5 py-1">
                    <select
                      value={currentModel?.id || ''}
                      onChange={(e) => {
                        const m = models.find(x => x.id === e.target.value);
                        if (m) setSelectedModel(m);
                      }}
                      className="bg-transparent text-muted-foreground hover:text-foreground text-[10px] font-mono outline-none cursor-pointer max-w-[130px] truncate"
                    >
                      {models.length === 0 ? (
                        <option value="" disabled>no models loaded</option>
                      ) : (
                        Object.entries(
                          models.reduce((acc, m) => {
                            if (!acc[m.provider]) acc[m.provider] = [];
                            acc[m.provider].push(m);
                            return acc;
                          }, {} as Record<string, ModelItem[]>)
                        ).map(([provider, list]) => (
                          <optgroup key={provider} label={provider.toUpperCase()} className="bg-card text-foreground">
                            {list.map(m => (
                              <option key={m.id} value={m.id}>
                                {m.id}
                              </option>
                            ))}
                          </optgroup>
                        ))
                      )}
                    </select>
                    {/* Effort inline dropdown — replaces modal */}
                    <select
                      value={effort}
                      onChange={(e) => setEffort(e.target.value as 'low' | 'medium' | 'high' | 'max')}
                      className="bg-transparent text-muted-foreground hover:text-foreground text-[10px] font-mono outline-none cursor-pointer max-w-[70px] truncate border-l border-border/40 pl-1.5"
                      title="Thinking Effort"
                    >
                      <option value="low">low</option>
                      <option value="medium">med</option>
                      <option value="high">high</option>
                      <option value="max">max</option>
                    </select>
                  </div>

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
              </div>
            </div>
          </div>
        </div>

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

function MessageBubble({ message }: { message: ChatMessage }) {
  const [showActions, setShowActions] = useState(false);

  if (message.role === 'tool') {
    return <ToolCallCard tool={message.tool!} timestamp={message.timestamp} />;
  }
  const isUser = message.role === 'user';
  return (
    <div
      className="w-full flex flex-col"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {message.thinking && <ReasoningBlock text={message.thinking} />}
      {isUser ? (
        <>
          <div className="rounded-2xl border border-border/40 bg-muted/40 dark:bg-[#161618] px-4 py-2.5 text-sm leading-relaxed text-foreground shadow-sm max-w-[85%] ml-auto">
            <Markdown content={message.content} />
          </div>
          {/* Action buttons below user message */}
          <div className={`flex items-center gap-0.5 mt-1 mr-1 transition-opacity duration-150 ${showActions ? 'opacity-100' : 'opacity-0'}`}
            style={{ alignSelf: 'flex-end' }}>
            <button
              onClick={() => navigator.clipboard.writeText(message.content)}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition"
              title="Copy"
            >
              <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
          </div>
        </>
      ) : (
        <div className="text-sm leading-relaxed text-foreground/90 space-y-3 max-w-none group relative">
          <Markdown content={message.content} />
          {/* Copy button for assistant messages on hover */}
          <button
            onClick={() => navigator.clipboard.writeText(message.content)}
            className={`absolute top-0 right-0 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-opacity duration-150 ${showActions ? 'opacity-100' : 'opacity-0'}`}
            title="Copy"
          >
            <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

function ReasoningBlock({ text }: { text: string }) {
  return (
    <details className="mb-2 group" open>
      <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground transition list-none flex items-center gap-1.5 select-none mb-1">
        <Sparkles className="size-3 text-amber-500" />
        <span className="font-medium">Reasoning</span>
        <ChevronRight className="size-3 transition group-open:rotate-90" />
      </summary>
      <div className="text-[11px] text-muted-foreground italic pl-4 border-l-2 border-amber-500/30 py-1">
        {text}
      </div>
    </details>
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
      <div className="shrink-0">
        <div className="size-8 rounded-full bg-gradient-to-br from-amber-500 to-orange-500 text-white grid place-items-center ring-1 ring-amber-300/50">
          <Sparkles className="size-4 animate-pulse" />
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono pt-2">
        <span className="flex gap-0.5">
          <span className="size-1 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="size-1 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="size-1 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: '300ms' }} />
        </span>
        thinking…
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

function buildDemoThread(sessionId: string | null): ChatMessage[] {
  if (sessionId && sessionId !== 'demo' && !sessionId.startsWith('sess_')) return [];
  return mockChatThread.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
  }));
}

/* ── Custom Markdown & Inline Style Renderer ───────────────────────── */

interface Block {
  type: 'paragraph' | 'code' | 'list' | 'table';
  content: string;
  items: string[];
  headers?: string[];
  rows?: string[][];
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      i++; // Skip opening fence
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // Skip closing fence
      blocks.push({
        type: 'code',
        content: codeLines.join('\\n'),
        items: []
      });
      continue;
    }

    // Table block
    if (line.trim().startsWith('|')) {
      const headers = line.split('|').map(s => s.trim()).filter(Boolean);
      i++;
      // Skip separator line (e.g. |---|---|)
      if (i < lines.length && lines[i].includes('-')) {
        i++;
      }
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].split('|').map(s => s.trim()).filter(Boolean));
        i++;
      }
      blocks.push({
        type: 'table',
        content: '',
        items: [],
        headers,
        rows
      });
      continue;
    }

    // List block
    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].trim().startsWith('- ') || lines[i].trim().startsWith('* '))) {
        items.push(lines[i].trim().slice(2));
        i++;
      }
      blocks.push({
        type: 'list',
        content: '',
        items
      });
      continue;
    }

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith('```') && !lines[i].trim().startsWith('|') && !lines[i].trim().startsWith('- ') && !lines[i].trim().startsWith('* ')) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({
      type: 'paragraph',
      content: paraLines.join('\\n'),
      items: []
    });
  }

  return blocks;
}

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let current = text;
  let keyIdx = 0;

  while (current) {
    const codeMatch = current.match(/`([^`]+)`/);
    const boldMatch = current.match(/\\*\\*([^*]+)\\*\\*/);

    if (codeMatch && (!boldMatch || (codeMatch.index !== undefined && boldMatch.index !== undefined && codeMatch.index < boldMatch.index))) {
      const idx = codeMatch.index!;
      if (idx > 0) {
        parts.push(current.slice(0, idx));
      }
      parts.push(
        <code key={keyIdx++} className="bg-muted px-1.5 py-0.5 rounded font-mono text-xs border border-border/30 text-amber-500 font-semibold">
          {codeMatch[1]}
        </code>
      );
      current = current.slice(idx + codeMatch[0].length);
    } else if (boldMatch) {
      const idx = boldMatch.index!;
      if (idx > 0) {
        parts.push(current.slice(0, idx));
      }
      parts.push(
        <strong key={keyIdx++} className="font-semibold text-foreground">
          {boldMatch[1]}
        </strong>
      );
      current = current.slice(idx + boldMatch[0].length);
    } else {
      parts.push(current);
      break;
    }
  }

  return <>{parts.length > 0 ? parts : text}</>;
}

function MarkdownTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="my-4 overflow-x-auto rounded-lg border border-border/40">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="bg-[#161618] border-b border-border/40 text-muted-foreground font-semibold">
          <tr>
            {headers.map((h, i) => (
              <th key={i} className="px-4 py-2.5 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          {rows.map((row, rIdx) => (
            <tr key={rIdx} className="hover:bg-muted/10 transition">
              {row.map((cell, cIdx) => (
                <td key={cIdx} className="px-4 py-2.5 font-mono text-xs">{renderInline(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Markdown({ content }: { content: string }) {
  if (!content) return null;
  const blocks = splitBlocks(content);

  return (
    <div className="space-y-3">
      {blocks.map((block, idx) => {
        if (block.type === 'code') {
          return (
            <pre key={idx} className="bg-[#161618] border border-border/40 px-4 py-3 rounded-lg font-mono text-xs my-3 overflow-x-auto text-foreground/90">
              <code>{block.content}</code>
            </pre>
          );
        }
        if (block.type === 'table') {
          return <MarkdownTable key={idx} headers={block.headers || []} rows={block.rows || []} />;
        }
        if (block.type === 'list') {
          return (
            <ul key={idx} className="list-disc pl-5 space-y-1.5 my-2">
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx} className="text-sm text-foreground/90">
                  {renderInline(item)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={idx} className="text-sm leading-relaxed my-2 text-foreground/90">
            {renderInline(block.content)}
          </p>
        );
      })}
    </div>
  );
}
