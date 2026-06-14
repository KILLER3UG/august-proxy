import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Check, Loader2, Brain, Inbox } from 'lucide-react';
import { formatTimeAgo } from '@/lib/utils';
import { getRequestDetails, type RequestDetailEntry, type Period } from '@/api/backend-ui';

/**
 * Thinking traces are not a standalone endpoint — they ride along on each
 * captured request in /ui/details (the `thinking` field, set by the
 * anthropic adapter when extended thinking is enabled). We surface the most
 * recent traces here. When no thinking is available, we show a clear empty
 * state instead of fake/mock data.
 */

interface ThinkingTrace {
  reqId: string;
  date?: string;
  thinking: string;
  finishReason?: string | null;
}

function extractTraces(details: RequestDetailEntry[] | undefined): ThinkingTrace[] {
  if (!details) return [];
  const traces: ThinkingTrace[] = [];
  for (const d of details) {
    const text = stringifyThinking(d.thinking);
    if (!text || !text.trim()) continue;
    traces.push({
      reqId: d.reqId,
      date: d.date,
      thinking: text,
      finishReason: d.finishReason,
    });
  }
  return traces;
}

function stringifyThinking(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    if (Array.isArray(v)) {
      // Anthropic thinking blocks: [{ type: 'thinking', thinking: '...' }]
      return v
        .map((b: any) => (typeof b === 'string' ? b : b?.thinking || b?.text || ''))
        .filter(Boolean)
        .join('\n');
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return String(o.thinking || o.text || o.content || '');
    }
  } catch {
    /* ignore */
  }
  return String(v);
}

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: '7d' },
  { key: 'all', label: 'All' },
];

export function Thinking() {
  const [periodIndex, setPeriodIndex] = useState(0);
  const period = PERIODS[periodIndex].key;

  const { data: details, isLoading } = useQuery({
    queryKey: ['request-details-thinking', period],
    queryFn: () => getRequestDetails(period),
    refetchInterval: 4_000,
  });

  const traces = extractTraces(details);
  const active = traces.find((t) => !t.finishReason);

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Thinking"
        subtitle={
          isLoading
            ? 'Loading thinking traces…'
            : traces.length
              ? `${traces.length} reasoning trace${traces.length > 1 ? 's' : ''} captured`
              : 'No reasoning traces yet — extended thinking is off or no requests have used it'
        }
        actions={
          <div className="flex items-center gap-3">
            {active && (
              <span className="inline-flex items-center gap-1.5 text-[10px] text-amber-600 font-mono">
                <Loader2 className="size-3 animate-spin" /> processing
              </span>
            )}
            <div className="flex items-center gap-1 text-[10px]">
              {PERIODS.map((p, i) => (
                <button
                  key={p.key}
                  onClick={() => setPeriodIndex(i)}
                  className={`rounded-md px-2 py-1 font-mono transition ${
                    periodIndex === i ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {traces.length === 0 ? (
        <EmptyThinking isLoading={isLoading} />
      ) : (
        <div className="space-y-3">
          {traces.map((t, i) => (
            <ThinkingCard key={t.reqId} index={i + 1} trace={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThinkingCard({ index, trace }: { index: number; trace: ThinkingTrace }) {
  const isActive = !trace.finishReason;
  const preview = trace.thinking.length > 400 ? trace.thinking.slice(0, 400) + '…' : trace.thinking;
  return (
    <Card className={isActive ? 'border-amber-500/50 bg-amber-500/5' : ''}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <StepIcon status={isActive ? 'active' : 'done'} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold">Trace {index}</h3>
              <span className="text-[10px] text-muted-foreground font-mono">{trace.reqId}</span>
              {trace.date && (
                <span className="text-[10px] text-muted-foreground ml-auto">{formatTimeAgo(trace.date)}</span>
              )}
            </div>
            <pre className="text-xs text-muted-foreground mt-2 whitespace-pre-wrap break-words font-mono leading-relaxed">
              {preview}
            </pre>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StepIcon({ status }: { status: 'done' | 'active' }) {
  if (status === 'active') {
    return (
      <div className="size-6 rounded-full bg-amber-500/20 text-amber-600 grid place-items-center shrink-0">
        <Loader2 className="size-3.5 animate-spin" />
      </div>
    );
  }
  return (
    <div className="size-6 rounded-full bg-primary/20 text-primary grid place-items-center shrink-0">
      <Check className="size-3.5" />
    </div>
  );
}

function EmptyThinking({ isLoading }: { isLoading: boolean }) {
  return (
    <Card className="border-dashed">
      <CardContent className="p-10 grid place-items-center text-center">
        {isLoading ? (
          <>
            <Brain className="size-8 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">Loading…</p>
          </>
        ) : (
          <>
            <Inbox className="size-8 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">No thinking traces available</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              Extended thinking traces appear here when a provider returns them.
              Send a message that uses a reasoning model to populate this view.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
