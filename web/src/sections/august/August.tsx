import { useState, useRef, type KeyboardEvent } from 'react';
import { Send, Lock, Unlock, Hash } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { mockChatThread } from '@/lib/mock';
import { formatTimeAgo, cn } from '@/lib/utils';

export function August() {
  const [messages, setMessages] = useState(mockChatThread);
  const [input, setInput] = useState('');
  const [locked, setLocked] = useState(true);
  const [plan, setPlan] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setMessages((m) => [...m, { id: `m${Date.now()}`, role: 'user' as const, content: text, timestamp: new Date().toISOString() }]);
    setInput('');
    setPlan(`1. ${text.slice(0, 60)}…\n2. inspect the current state\n3. propose changes\n4. await approval`);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6">
        <SectionHeader
          title="August"
          subtitle="Model-agnostic console. Send a prompt, get a plan, approve to execute."
          actions={
            <button
              onClick={() => setLocked(!locked)}
              className="inline-flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground hover:text-foreground transition"
            >
              {locked ? <><Lock className="size-3" /> locked</> : <><Unlock className="size-3" /> unlocked</>}
            </button>
          }
        />
      </div>

      <div className="flex-1 overflow-auto px-6 pb-3 space-y-3">
        {messages.map((m) => (
          <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <Card className={cn('max-w-[80%]', m.role === 'user' ? 'bg-secondary' : 'bg-card')}>
              <CardContent className="py-2.5 px-3">
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
        {plan && (
          <Card className="border-amber-500/50 bg-amber-500/5">
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-2">
                <Hash className="size-3 text-amber-600" />
                <span className="text-[10px] uppercase tracking-wider font-semibold text-amber-700 dark:text-amber-400">Plan submitted — awaiting approval</span>
              </div>
              <pre className="text-xs font-mono whitespace-pre-wrap">{plan}</pre>
              <div className="flex gap-2 mt-3">
                <button className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium hover:bg-primary/90 transition">Approve</button>
                <button className="rounded-md border border-border bg-background hover:bg-accent px-3 py-1.5 text-xs font-medium transition">Reject</button>
                <button className="rounded-md border border-border bg-background hover:bg-accent px-3 py-1.5 text-xs font-medium transition">Refine</button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="border-t border-border bg-background p-3">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-lg border border-border bg-card focus-within:ring-2 focus-within:ring-ring/40 transition">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder={locked ? "Console is locked — unlock to send prompts" : "Ask August anything…"}
              rows={1}
              disabled={locked}
              className="w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
            />
            <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
              <Badge variant={locked ? 'secondary' : 'outline'} className="text-[9px]">
                {locked ? '🔒 gated' : '🔓 open'}
              </Badge>
              <button
                onClick={send}
                disabled={locked || !input.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium hover:bg-primary/90 disabled:opacity-40 transition"
              >
                <Send className="size-3" /> Submit plan
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
