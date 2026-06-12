import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore } from '@nanostores/react';
import { useParams, useNavigate } from 'react-router-dom';
import { Home, Plus } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { StatusDot, type StatusTone } from '@/components/StatusDot';
import { $gateway } from '@/store/gateway';
import { $sessions, createSession, type Session } from '@/store/sessions';
import { api } from '@/api/client';

interface LearningStatus {
  status: 'idle' | 'learning' | 'evolved' | 'skipped' | 'failed';
  lastStartedAt?: string | null;
  lastEndedAt?: string | null;
  lastDurationMs?: number;
  lastClientId?: string | null;
  lastTopic?: string | null;
  lastSummary?: string | null;
  lastReason?: string | null;
  lastError?: string | null;
  history?: Array<{
    status: LearningStatus['status'];
    startedAt: string;
    endedAt: string;
    durationMs: number;
    topic?: string | null;
    summary?: string | null;
    reason?: string | null;
    warning?: string | null;
    error?: string | null;
    addedFacts?: unknown[];
    deletedFacts?: unknown[];
    semanticFacts?: unknown[];
    guidelinesQueued?: unknown[];
    checkpointSaved?: boolean;
    partial?: boolean;
    fallbackReason?: string | null;
  }>;
}

export function Statusbar() {
  const g = useStore($gateway);
  const sessions = useStore($sessions);
  const { sessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const [now, setNow] = useState(Date.now());
  const [collapsed] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const activeSession = useMemo(() => {
    return sessions.find((s) => s.id === sessionId && !s.isArchived) ?? sessions.find((s) => !s.isArchived) ?? null;
  }, [sessions, sessionId]);

  const { data: learning, error } = useQuery<LearningStatus>({
    queryKey: ['memory-learning-status'],
    queryFn: () => api.get<LearningStatus>('/ui/memory/learning-status'),
    refetchInterval: 1500,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const gatewayTone: StatusTone = g.status === 'open' ? 'good' : g.status === 'connecting' ? 'muted' : 'bad';
  const gatewayLabel = g.status === 'open' ? `gateway :${g.port || '?'}` : g.status;
  const learningView = getLearningView(learning);
  const tokens = 354_000 + Math.floor((now - Date.parse(activeSession?.startedAt || new Date().toISOString())) / 1000) * 12;
  const limit = 1_000_000;
  const pct = Math.min(100, Math.round((tokens / limit) * 100));
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(activeSession?.startedAt || new Date().toISOString())) / 1000));
  const model = stripProviderPrefix(activeSession?.model || 'Minimax M3 Free - Max');

  return (
    <footer className="h-7 flex items-center gap-3 border-t border-border/40 bg-[#09090b] px-0 text-[10.5px] text-muted-foreground font-mono shrink-0 select-none">
      <div className="flex h-full items-center">
        <div className="flex w-12 shrink-0 items-center justify-center gap-2">
          <button className="hover:text-foreground transition" title="Home" onClick={() => navigate('/')}>
            <Home className="size-3.5" />
          </button>
          <button className="hover:text-foreground transition" title="New Session" onClick={() => navigate(`/c/${createSession().id}`)}>
            <Plus className="size-3.5" />
          </button>
        </div>

        <Separator orientation="vertical" className="h-3" />

        <div className="flex items-center gap-3 pl-3">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <StatusDot tone={gatewayTone} />
            {gatewayLabel}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="inline-flex items-center gap-1.5 font-medium">
            <StatusDot
              tone={learningView.tone}
              className={cnPulse(learningView.tone === 'warn' && learning?.status === 'learning')}
            />
            {learningView.label}
          </span>
          {learningView.reason && (
            <span className="text-muted-foreground/70" title={learningView.reason}>
              {learningView.reason}
            </span>
          )}
          {error && <span className="text-destructive" title={error.message}>learning status unavailable</span>}
        </div>
      </div>

      <div className="mr-3 flex items-center gap-3">
        <span className="tabular-nums">{(tokens / 1000).toFixed(1)}k/{(limit / 1_000_000).toFixed(1)}M</span>
        <span className="flex items-center gap-1.5">
          <span className="tabular-nums w-7 text-right">{pct}%</span>
          <span className="relative h-1 w-24 overflow-hidden rounded-full bg-muted">
            <span
              className={cnPulse(false, `absolute inset-y-0 left-0 rounded-full ${pct > 80 ? 'bg-destructive' : pct > 60 ? 'bg-amber-500' : 'bg-foreground'}`)}
              style={{ width: `${pct}%` }}
            />
          </span>
        </span>
        <span className="text-muted-foreground/40">·</span>
        <span className="tabular-nums">Session {formatClock(elapsedSeconds)}</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="text-foreground">{model}</span>
        <span className="rounded border border-border/30 bg-muted/40 px-1 py-0 text-[9px] font-mono text-muted-foreground/60">
          # v0.15.1 (+24) 66a6b9c
        </span>
        {!collapsed && learning?.history?.[0] && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="tabular-nums" title={learning.history[0].summary || undefined}>{learning.history[0].topic || 'memory'}</span>
          </>
        )}
      </div>
    </footer>
  );
}

function getLearningView(learning?: LearningStatus | null) {
  const status = learning?.status || 'idle';
  if (status === 'learning') return { tone: 'warn' as StatusTone, label: 'Learning...', reason: null };
  if (status === 'evolved') return { tone: 'good' as StatusTone, label: 'Evolved recent turns', reason: null };
  if (status === 'failed') return { tone: 'bad' as StatusTone, label: 'Learning failed', reason: learning?.lastError || learning?.history?.[0]?.error || null };

  const reason = learning?.lastReason || learning?.history?.[0]?.reason;
  const warning = learning?.lastError || learning?.lastReason || learning?.history?.[0]?.warning;
  const isWarning = status === 'skipped' && warning && !['no user messages', 'no user text', 'short assistant response', 'no new facts'].includes(warning);
  if (status === 'skipped' && isWarning) return { tone: 'warn' as StatusTone, label: 'Memory budget warning', reason: warning };
  if (status === 'skipped') return { tone: 'muted' as StatusTone, label: 'Self-evolving idle', reason: reason ? `skipped: ${reason}` : null };
  return { tone: 'muted' as StatusTone, label: 'Self-evolving idle', reason: null };
}

function stripProviderPrefix(model: string) {
  return model.includes('/') ? model.split('/').pop() || model : model;
}

function formatClock(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function cnPulse(pulse: boolean, extra = '') {
  return `${pulse ? 'animate-pulse shadow-amber-500/40' : ''} ${extra}`;
}
