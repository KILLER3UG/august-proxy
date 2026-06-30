/* v4.4 — BrainModal: small overlay opened from the titlebar Brain icon.
   Defaults to the Activity tab (the realtime brain flow). Reuses the
   existing BrainActivityTab / LearningTab / SystemHealthTab components
   from sections/brain — no duplication. */
import { useEffect, useState } from 'react';
import { X, Activity, Brain, Heart } from 'lucide-react';
import { BrainActivityTab } from '@/sections/brain/BrainActivityTab';
import { LearningTab } from '@/sections/brain/LearningTab';
import { SystemHealthTab } from '@/sections/brain/SystemHealthTab';
import { cn } from '@/lib/utils';

interface BrainModalProps {
  open: boolean;
  onClose: () => void;
}

type TabKey = 'activity' | 'learning' | 'health';

const TABS: Array<{ key: TabKey; label: string; icon: typeof Activity }> = [
  { key: 'activity', label: 'Activity',     icon: Activity },
  { key: 'learning', label: 'Learning',     icon: Brain },
  { key: 'health',   label: 'System Health', icon: Heart },
];

export function BrainModal({ open, onClose }: BrainModalProps) {
  const [tab, setTab] = useState<TabKey>('activity');

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      data-testid="brain-modal"
      role="dialog"
      aria-label="Brain activity"
      onClick={(e) => {
        // Backdrop click closes the modal
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-[min(96vw,720px)] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Brain className="size-4 text-primary" />
            <span className="text-sm font-semibold">Brain</span>
            <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">
              realtime flow
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-3 pt-2 border-b border-border shrink-0">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-t-md border-b-2 transition',
                tab === key
                  ? 'border-primary text-foreground bg-card'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50',
              )}
              data-testid={`brain-modal-tab-${key}`}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3">
          {tab === 'activity' && <BrainActivityTab />}
          {tab === 'learning' && <LearningTab />}
          {tab === 'health' && <SystemHealthTab />}
        </div>
      </div>
    </div>
  );
}
