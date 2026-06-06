/* ── Chat thread — Hermes Desktop style ──────────────────────────────── */
/* The main view. User/assistant messages with proper avatars + bubbles.  */
/* Tool calls render as inline cards. Right rail optional.                  */

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Send, Paperclip, Mic, AtSign, Hash, Sparkles, ChevronRight, Wrench, Check, AlertCircle, StopCircle } from 'lucide-react';
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

const MODEL_NAME = 'claude-opus-4-7';

export function ChatThread({ sessionId }: { sessionId: string | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => buildDemoThread(sessionId));
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  useEffect(() => { setMessages(buildDemoThread(sessionId)); }, [sessionId]);

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setMessages((m) => [...m, { id: `m${Date.now()}`, role: 'user', content: text, timestamp: new Date().toISOString() }]);
    setStreaming(true);

    const callId = `t${Date.now()}`;
    setTimeout(() => {
      setMessages((m) => [...m, {
        id: callId,
        role: 'tool',
        content: '',
        timestamp: new Date().toISOString(),
        tool: { name: 'web_search', args: JSON.stringify({ query: text.slice(0, 60) }, null, 2), status: 'running' },
      }]);
    }, 400);

    setTimeout(() => {
      setMessages((m) => m.map((x) => x.id === callId
        ? { ...x, tool: { ...x.tool!, status: 'done', duration: 1240, result: 'Found 3 results about "' + text.slice(0, 40) + '".' } }
        : x));
    }, 1500);

    setTimeout(() => {
      setMessages((m) => [...m, {
        id: `a${Date.now()}`,
        role: 'assistant',
        content: `I searched the web for "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}" and found relevant context. The most useful result is from the official docs. Want me to summarize the top three findings, or drill into one specifically?`,
        timestamp: new Date().toISOString(),
        thinking: 'User asked a question. Need to: 1) search web for context, 2) summarize findings, 3) present options. The search took 1.2s and returned 3 results. I should keep my response concise.',
      }]);
      setStreaming(false);
    }, 2500);
  };

  const stop = () => setStreaming(false);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex h-full min-h-0">
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
        <div className="border-t border-border bg-background px-4 py-3 shrink-0">
          <div className="max-w-3xl mx-auto">
            <div className={cn(
              'rounded-2xl border bg-card shadow-sm transition focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary',
              'border-border',
            )}>
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  // auto-grow
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 240) + 'px';
                }}
                onKeyDown={onKey}
                placeholder={streaming ? 'August is working…' : `Message ${MODEL_NAME}…`}
                rows={1}
                disabled={streaming}
                className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
                style={{ minHeight: '40px', maxHeight: '240px' }}
              />
              <div className="flex items-center justify-between px-1.5 pb-1.5">
                <div className="flex items-center text-muted-foreground">
                  <ToolBtn Icon={Paperclip} label="Attach file" />
                  <ToolBtn Icon={AtSign}      label="Mention tool" />
                  <ToolBtn Icon={Hash}        label="Insert command" />
                  <ToolBtn Icon={Mic}         label="Voice input" />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground font-mono hidden sm:inline">
                    {MODEL_NAME}
                  </span>
                  {streaming ? (
                    <Button onClick={stop} size="sm" variant="outline">
                      <StopCircle className="size-3" /> Stop
                    </Button>
                  ) : (
                    <Button onClick={send} disabled={!input.trim()} size="sm">
                      <Send className="size-3" />
                      Send
                      <kbd className="ml-1 rounded bg-primary-foreground/20 px-1 text-[10px] font-mono">↵</kbd>
                    </Button>
                  )}
                </div>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5 text-center font-mono">
              {MODEL_NAME} · can make mistakes · ⌘K for commands
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'tool') {
    return <ToolCallCard tool={message.tool!} timestamp={message.timestamp} />;
  }
  const isUser = message.role === 'user';
  return (
    <div className="w-full">
      {message.thinking && <ReasoningBlock text={message.thinking} />}
      {isUser ? (
        <div className="rounded-xl border border-border/40 bg-[#161618] px-4 py-3 text-sm leading-relaxed text-foreground shadow-sm">
          <Markdown content={message.content} />
        </div>
      ) : (
        <div className="text-sm leading-relaxed text-foreground/90 space-y-3 max-w-none">
          <Markdown content={message.content} />
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

function ToolBtn({ Icon, label }: { Icon: typeof Send; label: string }) {
  return (
    <button aria-label={label} className="p-2 hover:bg-accent rounded-md transition text-muted-foreground hover:text-foreground">
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
  const lines = text.split('\n');
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
        content: codeLines.join('\n'),
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
      content: paraLines.join('\n'),
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
    const boldMatch = current.match(/\*\*([^*]+)\*\*/);

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
