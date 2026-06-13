import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore } from '@nanostores/react';
import { useParams } from 'react-router-dom';
import { StatusDot, type StatusTone } from '@/components/StatusDot';
import { $gateway } from '@/store/gateway';
import { $sessions } from '@/store/sessions';
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
  }>;
}

export function Statusbar() {
  const g = useStore($gateway);
  const sessions = useStore($sessions);
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [now, setNow] = useState(Date.now());

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
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const gatewayTone: StatusTone = g.status === 'open' ? 'good' : g.status === 'connecting' ? 'muted' : 'bad';
  const gatewayLabel = g.status === 'open' ? `gateway :${g.port || '?'}` : g.status;
  const learningView = getLearningView(learning);
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(activeSession?.startedAt || new Date().toISOString())) / 1000));

  return (
    <div className="flex items-center justify-end mt-1 px-1">
      <div className="flex items-center gap-3 text-[12px] text-muted-foreground font-mono">
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={gatewayTone} className="size-1.5" />
          {gatewayLabel}
        </span>
        <span className="text-muted-foreground/30">·</span>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot
            tone={learningView.tone}
            className={cnPulse(learningView.tone === 'warn' && learning?.status === 'learning', 'size-1.5')}
          />
          {learningView.label}
        </span>
        <span className="text-muted-foreground/30">·</span>
        <span className="tabular-nums">{formatClock(elapsedSeconds)}</span>
      </div>
    </div>
  );
}

function getLearningView(learning?: LearningStatus | null) {
  const status = learning?.status || 'idle';
  if (status === 'learning') return { tone: 'warn' as StatusTone, label: 'Learning...' };
  if (status === 'evolved') return { tone: 'good' as StatusTone, label: 'Evolved' };
  if (status === 'failed') return { tone: 'bad' as StatusTone, label: 'Learning failed' };
  if (status === 'skipped') return { tone: 'muted' as StatusTone, label: 'Memory idle' };
  return { tone: 'muted' as StatusTone, label: 'Memory idle' };
}

function formatClock(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function cnPulse(pulse: boolean, extra = '') {
  return `${pulse ? 'animate-pulse shadow-amber-500/40' : ''} ${extra}`.trim();
}
