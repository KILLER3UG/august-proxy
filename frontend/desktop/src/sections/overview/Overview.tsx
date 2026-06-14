import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { SectionHeader } from '@/components/SectionHeader';

interface OverviewData {
  requests?: number;
  activity?: number;
  inspector?: number;
  errors?: number;
  cost?: { input: number; output: number; total: number };
  activeConfig?: Record<string, unknown>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
        <p className="text-2xl font-semibold tabular-nums mt-1">{value.toLocaleString()}</p>
      </CardContent>
    </Card>
  );
}

export function Overview() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['overview', 'day'],
    queryFn: () => api.get<OverviewData>('/api/overview?range=day'),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <SectionHeader title="Overview" subtitle="Loading…" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />)}
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <SectionHeader title="Overview" />
        <p className="text-sm text-destructive">Failed to load: {String(error)}</p>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Overview"
        subtitle="Provider routing and live traffic. Claude, Codex, memory, and request flow in one local control surface."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Requests"  value={data.requests  ?? 0} />
        <Stat label="Activity"  value={data.activity  ?? 0} />
        <Stat label="Inspector" value={data.inspector ?? 0} />
        <Stat label="Errors"    value={data.errors    ?? 0} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cost</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Input tokens</p>
            <p className="font-mono mt-1">{(data.cost?.input  ?? 0).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Output tokens</p>
            <p className="font-mono mt-1">{(data.cost?.output ?? 0).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="font-mono mt-1">${(data.cost?.total ?? 0).toFixed(2)}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Current Active Config</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs font-mono bg-muted p-3 rounded-md overflow-auto max-h-64">
            {JSON.stringify(data.activeConfig ?? {}, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
