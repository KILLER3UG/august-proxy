import { useEffect, useState } from 'react';
import { Bot, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { WorkbenchBtwResult } from '@/types/workbench';

export function WorkbenchBtwDrawer({
  result,
  onSend,
  onClose,
}: {
  result: WorkbenchBtwResult | null;
  onSend: (question: string) => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');

  useEffect(() => {
    setQuestion('');
  }, [result?.id]);

  if (!result) return null;

  return (
    <div className="absolute right-3 top-3 z-30 w-[min(420px,calc(100%-24px))] rounded-xl border border-border bg-card shadow-2xl">
      <div className="flex items-start justify-between gap-3 border-b border-border p-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Bot className="size-3.5 text-primary" />
            Workbench BTW
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Side question answered without leaving the current chat.
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close BTW drawer">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="max-h-[320px] overflow-auto p-3 text-xs leading-relaxed">
        <Badge variant="secondary" className="mb-2">BTW</Badge>
        <div className="whitespace-pre-wrap">{result.answer || 'No answer returned.'}</div>
      </div>
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask a side question…"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary"
          />
          <Button size="sm" disabled={!question.trim()} onClick={submit}>
            <Send className="size-3" />
            Ask
          </Button>
        </div>
      </div>
    </div>
  );

  function submit() {
    const value = question.trim();
    if (!value) return;
    onSend(value);
    setQuestion('');
  }
}
