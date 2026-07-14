/* Brain dashboard: Learning / Ops / Activity / Health */
import { useState } from 'react';
import { Brain, Sparkles, Heart, Activity, Settings2 } from 'lucide-react';
import { LearningTab } from './LearningTab';
import { SystemHealthTab } from './SystemHealthTab';
import { BrainActivityTab } from './BrainActivityTab';
import { CognitiveOpsTab } from './CognitiveOpsTab';

export function BrainDashboard() {
  const [tab, setTab] = useState<'learning' | 'ops' | 'activity' | 'health'>('learning');

  const tabClass = (id: typeof tab) =>
    `px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
      tab === id
        ? 'bg-card text-foreground border border-border border-b-background -mb-px'
        : 'text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Brain className="size-7 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold">Brain</h1>
          <p className="text-sm text-muted-foreground">Learning, cognitive ops, and system health</p>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border pb-px flex-wrap">
        <button type="button" onClick={() => setTab('learning')} className={tabClass('learning')}>
          <Sparkles className="size-3.5 inline mr-1.5" />
          Learning
        </button>
        <button
          type="button"
          onClick={() => setTab('ops')}
          className={tabClass('ops')}
          data-testid="brain-tab-ops"
        >
          <Settings2 className="size-3.5 inline mr-1.5" />
          Cognitive Ops
        </button>
        <button
          type="button"
          onClick={() => setTab('activity')}
          className={tabClass('activity')}
          data-testid="brain-tab-activity"
        >
          <Activity className="size-3.5 inline mr-1.5" />
          Activity
        </button>
        <button type="button" onClick={() => setTab('health')} className={tabClass('health')}>
          <Heart className="size-3.5 inline mr-1.5" />
          System Health
        </button>
      </div>

      <div className="pb-8">
        {tab === 'learning' && <LearningTab />}
        {tab === 'ops' && <CognitiveOpsTab />}
        {tab === 'activity' && <BrainActivityTab />}
        {tab === 'health' && <SystemHealthTab />}
      </div>
    </div>
  );
}