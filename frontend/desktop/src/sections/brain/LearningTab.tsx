/* v3 — Learning tab: heuristics, auto-memories, facts, sleep cycle, delta engine, skill genesis */
import { useEffect, useState } from 'react';
import { Sparkles, Brain, Clock, Zap, ListChecks } from 'lucide-react';
import { Card } from '@/components/ui/card';

interface Heuristic {
  id: number;
  rule: string;
  source: string;
  category: string;
  createdAt: string;
}

interface AutoMemory {
  id: number;
  key: string;
  content: string;
  importance: number;
  createdAt?: string;
}

interface PendingSkill {
  id: number;
  name: string;
  description: string;
  triggerText?: string;
}

interface LearningData {
  heuristics: Heuristic[];
  heuristicCount: number;
  coreFacts: unknown;
  userProfile: unknown;
  autoMemories: AutoMemory[];
  sleepCycle: { lastRunAt: string | null; lastMerged: number; lastPromoted: number; lastDeleted: number };
  deltaEngine: { consentGranted: boolean; queueSize: number; lastFlushAt: string | null };
  pendingSkills: PendingSkill[];
}

const API_BASE = '/api/brain';

export function LearningTab() {
  const [data, setData] = useState<LearningData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const resp = await fetch(`${API_BASE}/learning`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    fetchData();
    const id = setInterval(fetchData, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return <div className="p-4 text-danger">Error loading brain data: {error}</div>;
  }
  if (!data) {
    return (
      <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
        <Clock className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Learned heuristics */}
      <Card className="p-4 space-y-3 md:col-span-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="size-4 text-primary" />
            <h3 className="font-medium text-sm">Learned heuristics</h3>
          </div>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
            {data.heuristicCount}
          </span>
        </div>
        {data.heuristics.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No learned heuristics yet — the brain starts learning once you use it.
          </p>
        ) : (
          <ul className="space-y-2 max-h-72 overflow-y-auto">
            {data.heuristics.map((h) => (
              <li
                key={h.id}
                className="text-xs flex items-start gap-2 p-2 rounded hover:bg-muted/30"
              >
                <span
                  className={`mt-1 size-1.5 rounded-full shrink-0 ${
                    h.source === 'manual'
                      ? 'bg-primary'
                      : h.source === 'local-diff'
                      ? 'bg-success'
                      : 'bg-muted-foreground'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p>{h.rule}</p>
                  <span className="text-[10px] text-muted-foreground">
                    <span>{h.source}</span>
                    {' · '}
                    <span>{h.category}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Auto-memories */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ListChecks className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Recent auto-memories</h3>
        </div>
        {data.autoMemories.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No auto-memories captured yet. The model saves them as you chat.
          </p>
        ) : (
          <ul className="space-y-2 max-h-60 overflow-y-auto">
            {data.autoMemories.map((m) => (
              <li key={m.id} className="text-xs p-2 rounded hover:bg-muted/30">
                <p>{m.content}</p>
                <span className="text-[10px] text-muted-foreground">
                  importance: {m.importance.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Core facts */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-warning" />
          <h3 className="font-medium text-sm">Core facts</h3>
        </div>
        {data.coreFacts ? (
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap max-h-60 overflow-y-auto">
            {JSON.stringify(data.coreFacts, null, 2).slice(0, 800)}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">No core facts yet.</p>
        )}
      </Card>

      {/* Sleep cycle */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Sleep cycle</h3>
        </div>
        {data.sleepCycle.last_run_at ? (
          <p className="text-xs text-muted-foreground">
            Last run: {new Date(data.sleepCycle.last_run_at).toLocaleString()}
            <br />
            {data.sleepCycle.last_merged} merges, {data.sleepCycle.last_promoted} promotions,{' '}
            {data.sleepCycle.last_deleted} deletions
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No consolidation runs yet.</p>
        )}
      </Card>

      {/* Delta engine */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-warning" />
          <h3 className="font-medium text-sm">Delta engine</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Queue: {data.deltaEngine.queue_size} ·{' '}
          Consent: {data.deltaEngine.consent_granted ? 'granted' : 'not granted'}
        </p>
        <p className="text-[10px] text-muted-foreground">
          Last flush:{' '}
          {data.deltaEngine.last_flush_at
            ? new Date(data.deltaEngine.last_flush_at).toLocaleString()
            : 'never'}
        </p>
      </Card>

      {/* Pending skills */}
      <Card className="p-4 space-y-3 md:col-span-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Skill genesis (pending approval)</h3>
        </div>
        {data.pendingSkills.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No auto-generated skills pending review. The brain drafts skills from complex successful sessions.
          </p>
        ) : (
          <ul className="space-y-2 max-h-60 overflow-y-auto">
            {data.pendingSkills.map((s) => (
              <li key={s.id} className="text-xs p-2 rounded hover:bg-muted/30">
                <strong>{s.name}</strong>: {s.description}
                {s.triggerText && (
                  <span className="block text-[10px] text-muted-foreground">
                    trigger: {s.triggerText}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}