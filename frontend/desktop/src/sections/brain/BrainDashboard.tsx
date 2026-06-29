import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Brain, Heart, Sparkles, Clock, Trash2, CheckCircle2 } from 'lucide-react';

interface LearningData {
  heuristics: Array<{ id: number; rule: string; source: string; category: string; created_at: string }>;
  heuristic_count: number;
  core_facts: unknown;
  user_profile: unknown;
  delta_engine: { consent_granted: boolean; queue_size: number };
  pending_skills: unknown[];
}

interface HealthPhase {
  layer: string;
  flag: string;
  flag_value: boolean;
  status: string;
}

export function BrainDashboard() {
  const [tab, setTab] = useState<'learning' | 'health'>('learning');
  const [learning, setLearning] = useState<LearningData | null>(null);
  const [health, setHealth] = useState<HealthPhase[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/brain/learning').then(r => r.json()),
      fetch('/api/brain/health').then(r => r.json()),
    ]).then(([learningData, healthData]) => {
      setLearning(learningData);
      setHealth(healthData.phases || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Brain className="size-7 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold">Brain</h1>
          <p className="text-sm text-muted-foreground">Jarvis's learning and system health</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border pb-px">
        <button
          onClick={() => setTab('learning')}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            tab === 'learning' ? 'bg-card text-foreground border border-border border-b-background -mb-px' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Sparkles className="size-3.5 inline mr-1.5" />Learning
        </button>
        <button
          onClick={() => setTab('health')}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            tab === 'health' ? 'bg-card text-foreground border border-border border-b-background -mb-px' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Heart className="size-3.5 inline mr-1.5" />System Health
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Clock className="size-5 animate-spin mr-2" /> Loading...
        </div>
      ) : tab === 'learning' ? (
        <LearningTab data={learning} />
      ) : (
        <HealthTab phases={health} />
      )}
    </div>
  );
}

function LearningTab({ data }: { data: LearningData | null }) {
  if (!data) return <EmptyState message="No learning data yet. The brain starts learning once you use it." />;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Learned Heuristics */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-sm">Learned Heuristics</h3>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{data.heuristic_count}</span>
        </div>
        {data.heuristics.length === 0 ? (
          <p className="text-xs text-muted-foreground">No heuristics learned yet.</p>
        ) : (
          <ul className="space-y-2 max-h-60 overflow-y-auto">
            {data.heuristics.map((h) => (
              <li key={h.id} className="text-xs flex items-start gap-2">
                <span className={`mt-0.5 size-1.5 rounded-full shrink-0 ${
                  h.source === 'manual' ? 'bg-primary' : h.source === 'local-diff' ? 'bg-success' : 'bg-muted-foreground'
                }`} />
                <div className="flex-1 min-w-0">
                  <p className="truncate">{h.rule}</p>
                  <span className="text-[10px] text-muted-foreground">{h.source} · {h.category}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Core Facts */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Core Facts</h3>
        </div>
        {data.core_facts ? (
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{JSON.stringify(data.core_facts, null, 2).slice(0, 500)}</pre>
        ) : (
          <p className="text-xs text-muted-foreground">No core facts yet.</p>
        )}
      </Card>

      {/* Delta Engine */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-warning" />
          <h3 className="font-medium text-sm">Delta Engine</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Consent: {data.delta_engine.consent_granted ? 'Granted' : 'Not granted'}
        </p>
        <p className="text-xs text-muted-foreground">
          Queued diffs: {data.delta_engine.queue_size}
        </p>
        <p className="text-[10px] text-muted-foreground">Learns coding style from your edits.</p>
      </Card>

      {/* Skill Genesis */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Brain className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Skill Genesis</h3>
        </div>
        {data.pending_skills.length > 0 ? (
          <p className="text-xs text-muted-foreground">{data.pending_skills.length} skill(s) awaiting approval.</p>
        ) : (
          <p className="text-xs text-muted-foreground">No pending skills.</p>
        )}
      </Card>
    </div>
  );
}

function HealthTab({ phases }: { phases: HealthPhase[] }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-3 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        <span>Phase / Layer</span>
        <span>Flag</span>
        <span>Status</span>
        <span>Self-Check</span>
      </div>
      {phases.map((p) => (
        <div key={p.flag} className="grid grid-cols-4 gap-3 items-center px-4 py-2.5 bg-card rounded-lg border border-border text-sm">
          <span className="font-medium">{p.layer}</span>
          <code className="text-xs text-muted-foreground">{p.flag}</code>
          <span className={`inline-flex items-center gap-1 text-xs font-medium ${
            p.status === 'on & healthy' ? 'text-success' : p.status === 'off' ? 'text-muted-foreground' : 'text-danger'
          }`}>
            <span className={`size-1.5 rounded-full ${
              p.status === 'on & healthy' ? 'bg-success' : p.status === 'off' ? 'bg-muted-foreground' : 'bg-danger'
            }`} />
            {p.status}
          </span>
          <span className="text-xs text-muted-foreground">{p.flag_value ? 'active' : 'inactive'}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
      <Brain className="size-12 mb-4 opacity-20" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
