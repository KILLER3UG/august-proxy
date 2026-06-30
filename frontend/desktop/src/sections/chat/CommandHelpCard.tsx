import { COMMANDS, type ChatCommand } from './commands-data';

interface CommandHelpCardProps {
  /** Optional title override; defaults to "Available commands". */
  title?: string;
}

const CATEGORY_ORDER = ['Meta', 'Session', 'Provider', 'Workbench', 'Skills', 'Study', 'Other'];

export function CommandHelpCard({ title = 'Available commands' }: CommandHelpCardProps) {
  const grouped = new Map<string, ChatCommand[]>();
  for (const c of COMMANDS) {
    const cat = c.category || 'Other';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(c);
  }
  const categories = Array.from(grouped.keys()).sort(
    (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)
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
