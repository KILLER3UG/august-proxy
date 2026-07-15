/** Compact metric tile for Active / Stale / Archived / Tracked skill counts. */

export function StatTile({
  icon,
  label,
  value,
  tone = 'muted',
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: 'warn' | 'muted';
}) {
  const valueClass = tone === 'warn' && value > 0 ? 'text-warning' : 'text-foreground';
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-center gap-2 mb-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className={`text-2xl font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}
