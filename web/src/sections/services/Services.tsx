import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { mockServices } from '@/lib/mock';
import { cn } from '@/lib/utils';

const ICONS: Record<string, string> = {
  google: 'G', github: '⌥', slack: 'S', notion: 'N', linear: 'L', figma: 'F',
};
const COLORS: Record<string, string> = {
  google: 'from-red-500 to-orange-500',
  github: 'from-slate-700 to-slate-900',
  slack: 'from-purple-500 to-pink-500',
  notion: 'from-stone-600 to-stone-800',
  linear: 'from-indigo-500 to-purple-600',
  figma: 'from-orange-500 to-pink-600',
};

export function Services() {
  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Services"
        subtitle="Third-party integrations used by MCP tools. Connect once, use everywhere."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {mockServices.map((svc) => {
          const connected = svc.status === 'connected';
          return (
            <Card key={svc.name}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'size-10 rounded-xl bg-gradient-to-br grid place-items-center text-white text-sm font-bold',
                      COLORS[svc.name] ?? 'from-slate-500 to-slate-700',
                    )}>
                      {ICONS[svc.name] ?? svc.name[0]?.toUpperCase()}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold capitalize">{svc.name}</h3>
                      <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">{svc.scopes.length} scopes</p>
                    </div>
                  </div>
                  <Badge variant={connected ? 'success' : 'secondary'}>{connected ? 'Connected' : 'Not connected'}</Badge>
                </div>
                {connected && svc.account && (
                  <p className="text-xs text-muted-foreground mb-3 font-mono truncate">{svc.account}</p>
                )}
                {connected && svc.scopes.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {svc.scopes.slice(0, 4).map((s) => (
                      <span key={s} className="inline-flex items-center rounded-full bg-secondary text-secondary-foreground px-1.5 py-0.5 text-[9px] font-mono">
                        {s}
                      </span>
                    ))}
                    {svc.scopes.length > 4 && (
                      <span className="text-[9px] text-muted-foreground">+{svc.scopes.length - 4} more</span>
                    )}
                  </div>
                )}
                <div className="flex gap-2">
                  <button className="flex-1 rounded-md border border-border bg-background hover:bg-accent text-xs font-medium py-1.5 transition">
                    {connected ? 'Re-authenticate' : 'Connect'}
                  </button>
                  {connected && (
                    <button className="rounded-md border border-red-200 text-red-600 hover:bg-red-50 text-xs font-medium px-3 py-1.5 transition dark:border-red-800 dark:hover:bg-red-900/20">
                      Disconnect
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Available integrations</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          More services can be added by dropping an MCP server config into <code className="font-mono bg-muted px-1 rounded">config.json</code> under <code className="font-mono">mcp.servers</code>.
        </CardContent>
      </Card>
    </div>
  );
}
