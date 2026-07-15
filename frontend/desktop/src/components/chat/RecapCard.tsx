/**
 * RecapCard — end-of-turn prose summary under the assistant answer.
 *
 * Instant template from tool/file activity; optional "Rewrite with AI"
 * polishes the paragraph via the local OpenAI-compatible proxy.
 */

import { useCallback, useMemo, useState } from 'react';
import { Loader2, Sparkles, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { whenReady } from '@/api/client';
import {
  buildAiRecapPrompt,
  buildTurnRecap,
  type TurnRecapInput,
} from '@/lib/turn-recap';
import { toast } from 'sonner';

export interface RecapCardProps {
  input: TurnRecapInput;
  /** Preferred model id for AI rewrite (session selection). */
  modelId?: string | null;
  className?: string;
}

async function rewriteRecapWithAi(
  prompt: string,
  modelId?: string | null,
): Promise<string> {
  const base = (await whenReady()) ?? '';
  const url = `${base}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId || undefined,
      temperature: 0.3,
      max_tokens: 180,
      messages: [
        {
          role: 'system',
          content:
            'You write concise past-tense work recaps for a coding agent. Output only the recap paragraph.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(errText.slice(0, 200) || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty model response');
  // Strip accidental "Recap" heading
  return text.replace(/^recap\s*[:.\-–—]?\s*/i, '').trim();
}

export function RecapCard({ input, modelId, className }: RecapCardProps) {
  const template = useMemo(() => buildTurnRecap(input), [input]);
  const [text, setText] = useState<string | null>(null);
  const [aiPolished, setAiPolished] = useState(false);
  const [busy, setBusy] = useState(false);

  // Prefer controlled display: local AI override, else latest template
  const display = text ?? template;

  const onRewrite = useCallback(async () => {
    if (!template || busy) return;
    setBusy(true);
    try {
      const prompt = buildAiRecapPrompt(template, input);
      const polished = await rewriteRecapWithAi(prompt, modelId);
      setText(polished);
      setAiPolished(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error('Could not rewrite recap', { description: msg });
    } finally {
      setBusy(false);
    }
  }, [template, busy, input, modelId]);

  const onReset = useCallback(() => {
    setText(null);
    setAiPolished(false);
  }, []);

  if (!display) return null;

  return (
    <div
      className={cn(
        'mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.025]',
        'shadow-sm overflow-hidden',
        className,
      )}
      data-slot="recap-card"
      data-testid="recap-card"
    >
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
            Recap
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/90">
            {display}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => { void onRewrite(); }}
            disabled={busy || !template}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              'text-muted-foreground hover:bg-white/[0.05] hover:text-foreground',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
            title="Rewrite with AI for a more natural paragraph"
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Sparkles className="size-3" />
            )}
            {busy ? 'Rewriting…' : aiPolished ? 'Rewrite again' : 'Rewrite with AI'}
          </button>
          {aiPolished && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground/80 hover:bg-white/[0.05] hover:text-foreground transition-colors"
              title="Restore instant template recap"
            >
              <RotateCcw className="size-3" />
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
