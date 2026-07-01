/* v3/v4.3 — Brain dashboard: tabbed view over Learning / Activity / Health */
import { useState } from 'react';
import { Brain, Sparkles, Heart, Activity } from 'lucide-react';
import { LearningTab } from './LearningTab';
import { SystemHealthTab } from './SystemHealthTab';
import { BrainActivityTab } from './BrainActivityTab';

export function BrainDashboard() {
  const [tab, setTab] = useState<'learning' | 'activity' | 'health'>('learning');

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
            tab === 'learning'
              ? 'bg-card text-foreground border border-border border-b-background -mb-px'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Sparkles className="size-3.5 inline mr-1.5" />
          Learning
        </button>
        <button
          onClick={() => setTab('activity')}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            tab === 'activity'
              ? 'bg-card text-foreground border border-border border-b-background -mb-px'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          data-testid="brain-tab-activity"
        >
          <Activity className="size-3.5 inline mr-1.5" />
          Activity
        </button>
        <button
          onClick={() => setTab('health')}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            tab === 'health'
              ? 'bg-card text-foreground border border-border border-b-background -mb-px'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Heart className="size-3.5 inline mr-1.5" />
          System Health
        </button>
      </div>

      <div className="pb-8">
        {tab === 'learning' && <LearningTab />}
        {tab === 'activity' && <BrainActivityTab />}
        {tab === 'health' && <SystemHealthTab />}
      </div>
    </div>
  );
}