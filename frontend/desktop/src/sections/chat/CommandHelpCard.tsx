import {
  getDisplayCommands,
  type DisplayCommand,
} from '@/api/voice/registry';

interface CommandHelpCardProps {
  /** Optional title override; defaults to "Available commands". */
  title?: string;
  /** Optional override list. Defaults to commands registered with the registry. */
  commands?: DisplayCommand[];
}

// Kept human-friendly for the UI; registry stores lowercase category ids.
const CATEGORY_LABEL: Record<string, string> = {
  core: 'Core',
  plugin: 'Plugins',
};
const CATEGORY_ORDER = ['Core', 'Session', 'Provider', 'Workbench', 'Skills', 'Study', 'Plugin'];

function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? (CATEGORY_ORDER.includes(category) ? category : 'Other');
}

export function CommandHelpCard({
  title = 'Available commands',
  commands,
}: CommandHelpCardProps) {
  const list = commands ?? getDisplayCommands();
  const grouped = new Map<string, DisplayCommand[]>();
  for (const c of list) {
    const cat = categoryLabel(c.category);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(c);
  }
  const categories = Array.from(grouped.keys()).sort(
    (a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a);
      const bi = CATEGORY_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    },
  );

  return (
    <div
      data-slot="help-card"
      className="rounded-lg border border-border bg-card p-4 space-y-3 max-w-3xl"
    >
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {categories.map(cat => (
        <div key={cat} className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">{cat}</div>
          <div className="grid gap-1">
            {grouped.get(cat)!.map(cmd => (
              <div key={cmd.name} className="grid grid-cols-[140px_1fr] gap-3 text-xs">
                <div className="font-mono text-primary">{cmd.name}</div>
                <div className="space-y-0.5">
                  <div className="text-foreground/90">{cmd.desc}</div>
                  {cmd.usage && (
                    <div className="text-[11px] text-muted-foreground">
                      <span className="font-mono">{cmd.usage}</span>
                      {cmd.example && cmd.example !== cmd.usage && (
                        <span className="ml-2">e.g. <span className="font-mono">{cmd.example}</span></span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
