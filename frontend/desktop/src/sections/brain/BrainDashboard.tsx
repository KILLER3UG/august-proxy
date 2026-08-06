/* Brain dashboard: You / Runs / Learning / Journey / Ops / Activity / Health */
import { useState } from 'react';
import { Brain, Sparkles, Heart, Activity, Settings2, History, User, Network } from 'lucide-react';
import { LearningTab } from './LearningTab';
import { SystemHealthTab } from './SystemHealthTab';
import { BrainActivityTab } from './BrainActivityTab';
import { CognitiveOpsTab } from './CognitiveOpsTab';
import { JourneyTab } from './JourneyTab';
import { YouTab } from './YouTab';
import { RunsTab } from './RunsTab';

export function BrainDashboard() {
  const [tab, setTab] = useState<'you' | 'runs' | 'learning' | 'journey' | 'ops' | 'activity' | 'health'>('you');

  const tabClass = (id: typeof tab) =>
    `px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
      tab === id
        ? 'bg-card text-foreground border border-border border-b-background -mb-px'
        : 'text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div
      className="h-full min-h-0 overflow-y-auto overflow-x-hidden p-6 max-w-6xl mx-auto space-y-6"
      data-testid="brain-dashboard"
    >
      <div className="flex items-center gap-3">
        <Brain className="size-7 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold">Brain</h1>
          <p className="text-sm text-muted-foreground">Learning, cognitive ops, and system health</p>
        </div>
      </div>

      <div className="sticky top-0 z-10 flex gap-1 border-b border-border bg-background/95 pb-px backdrop-blur flex-wrap">
        <button type="button" onClick={() => setTab('you')} className={tabClass('you')} data-testid="brain-tab-you">
          <User className="size-3.5 inline mr-1.5" />
          You
        </button>
        <button type="button" onClick={() => setTab('runs')} className={tabClass('runs')} data-testid="brain-tab-runs">
          <Network className="size-3.5 inline mr-1.5" />
          Runs
        </button>
        <button type="button" onClick={() => setTab('learning')} className={tabClass('learning')}>
          <Sparkles className="size-3.5 inline mr-1.5" />
          Learning
        </button>
        <button
          type="button"
          onClick={() => setTab('journey')}
          className={tabClass('journey')}
          data-testid="brain-tab-journey"
        >
          <History className="size-3.5 inline mr-1.5" />
          Journey
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
        {tab === 'you' && <YouTab />}
        {tab === 'runs' && <RunsTab />}
        {tab === 'learning' && <LearningTab />}
        {tab === 'journey' && <JourneyTab />}
        {tab === 'ops' && <CognitiveOpsTab />}
        {tab === 'activity' && <BrainActivityTab />}
        {tab === 'health' && <SystemHealthTab />}
      </div>
    </div>
  );
}
