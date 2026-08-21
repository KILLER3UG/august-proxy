import { cn } from '@/lib/utils';

export type MemoryHubTabId = 'recalled' | 'by-project' | 'saved' | 'graph';

export const MEMORY_HUB_TABS: Array<{
  id: MemoryHubTabId;
  label: string;
  hint: string;
}> = [
  { id: 'recalled', label: 'Recalled', hint: 'All projects' },
  { id: 'by-project', label: 'By Project', hint: 'Per folder' },
  { id: 'saved', label: 'Saved', hint: 'Always included' },
  { id: 'graph', label: 'Graph', hint: 'Relations' },
];

export function MemoryHubTabs({
  active,
  onChange,
}: {
  active: MemoryHubTabId;
  onChange: (id: MemoryHubTabId) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border/60 pb-3">
      {MEMORY_HUB_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            'rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors',
            active === t.id
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {t.label}
          <span className="ml-1.5 text-[10px] font-normal opacity-60">{t.hint}</span>
        </button>
      ))}
    </div>
  );
}
