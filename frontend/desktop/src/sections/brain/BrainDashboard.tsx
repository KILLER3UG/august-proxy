/* v3 — Brain dashboard: tabbed view over LearningTab + SystemHealthTab */
import { useState } from 'react';
import { Brain, Sparkles, Heart } from 'lucide-react';
import { LearningTab } from './LearningTab';
import { SystemHealthTab } from './SystemHealthTab';

export function BrainDashboard() {
  const [tab, setTab] = useState<'learning' | 'health'>('learning');

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
        {tab === 'learning' ? <LearningTab /> : <SystemHealthTab />}
      </div>
    </div>
  );
}