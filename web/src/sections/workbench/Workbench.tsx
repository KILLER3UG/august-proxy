import { useState, useRef, type KeyboardEvent } from 'react';
import { Send, Paperclip, Mic, AtSign, Hash } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { mockChatThread } from '@/lib/mock';
import { cn, formatTimeAgo } from '@/lib/utils';

export function Workbench() {
  const [messages, setMessages] = useState(mockChatThread);
  const [input, setInput] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setMessages((m) => [...m, {
      id: `m${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    }]);
    setInput('');
    // In the real app, this hits the agent loop; for mock, echo a reply after a beat
    setTimeout(() => {
      setMessages((m) => [...m, {
        id: `m${Date.now()}_reply`,
        role: 'assistant',
        content: `Working on: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`,
        timestamp: new Date().toISOString(),
      }]);
    }, 600);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6">
        <SectionHeader
          title="Workbench"
          subtitle="Chat with the agent. Same tools, memory, and skills as the CLI."
          actions={
            <span className="text-[10px] text-muted-foreground font-mono">
              model: claude-opus-4-7 · streaming
            </span>
          }
        />
      </div>

      <div className="flex-1 overflow-auto px-6 pb-3 space-y-3">
        {messages.map((m) => (
          <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <Card className={cn(
              'max-w-[80%]',
              m.role === 'user' ? 'bg-secondary' : 'bg-card',
            )}>
              <CardContent className="py-3 px-4">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1 font-mono">
                  <span className="font-semibold">{m.role}</span>
                  <span>·</span>
                  <span>{formatTimeAgo(m.timestamp)}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{m.content}</p>
              </CardContent>
            </Card>
          </div>
        ))}
      </div>

      <div className="border-t border-border bg-background p-3">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-lg border border-border bg-card focus-within:ring-2 focus-within:ring-ring/40 transition">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="Ask the agent, or type / for commands…"
              rows={2}
              className="w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
              <div className="flex items-center gap-0.5 text-muted-foreground">
                <button className="p-1.5 hover:bg-accent rounded transition" aria-label="Attach file"><Paperclip className="size-3.5" /></button>
                <button className="p-1.5 hover:bg-accent rounded transition" aria-label="Mention tool"><AtSign className="size-3.5" /></button>
                <button className="p-1.5 hover:bg-accent rounded transition" aria-label="Insert command"><Hash className="size-3.5" /></button>
                <button className="p-1.5 hover:bg-accent rounded transition" aria-label="Voice input"><Mic className="size-3.5" /></button>
              </div>
              <button
                onClick={send}
                disabled={!input.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium hover:bg-primary/90 disabled:opacity-40 transition"
              >
                <Send className="size-3" /> Send
                <kbd className="ml-1 rounded bg-primary-foreground/20 px-1 text-[10px] font-mono">↵</kbd>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
