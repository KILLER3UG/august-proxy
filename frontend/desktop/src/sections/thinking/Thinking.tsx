import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Check, Circle, Loader2, Clock } from 'lucide-react';
import { mockThinking, type ThinkingStep } from '@/lib/mock';
import { formatTimeAgo, cn } from '@/lib/utils';

export function Thinking() {
  const { data } = useQuery({
    queryKey: ['thinking'],
    queryFn: async () => {
      try { return await api.get<{ steps: ThinkingStep[] }>('/api/thinking/current'); }
      catch { return { steps: mockThinking }; }
    },
    refetchInterval: 2_000,
  });
  const steps = data?.steps ?? mockThinking;
  const active = steps.find((s) => s.status === 'active');

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Thinking"
        subtitle={active ? `Active step: ${active.title}` : 'Idle — no reasoning in progress'}
        actions={active && <span className="inline-flex items-center gap-1.5 text-[10px] text-amber-600 font-mono"><Loader2 className="size-3 animate-spin" /> processing</span>}
      />
      <div className="space-y-1.5">
        {steps.map((s, i) => (
          <Card key={s.id} className={cn(s.status === 'active' && 'border-amber-500/50 bg-amber-500/5')}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <StepIcon status={s.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold">{i + 1}. {s.title}</h3>
                    {s.duration !== undefined && (
                      <span className="text-[10px] text-muted-foreground font-mono">{(s.duration / 1000).toFixed(1)}s</span>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto">{formatTimeAgo(s.timestamp)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{s.detail}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: ThinkingStep['status'] }) {
  if (status === 'done')    return <div className="size-6 rounded-full bg-primary/20 text-primary grid place-items-center"><Check className="size-3.5" /></div>;
  if (status === 'active')  return <div className="size-6 rounded-full bg-amber-500/20 text-amber-600 grid place-items-center"><Loader2 className="size-3.5 animate-spin" /></div>;
  return <div className="size-6 rounded-full bg-muted text-muted-foreground grid place-items-center"><Circle className="size-3.5" /></div>;
}
