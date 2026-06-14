import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { StatusPill } from '@/components/StatusPill';
import { SectionHeader } from '@/components/SectionHeader';
import { useStore } from '@nanostores/react';
import { $gateway } from '@/store/gateway';
import { PageLoader } from '@/components/PageLoader';

interface HealthData {
  claude?: { status: string };
  codex?:  { status: string };
  uptime?: number;
  memory?: { used: number; total: number };
}

export function Health() {
  const g = useStore($gateway);
  const { data, isLoading, error } = useQuery({
    queryKey: ['health', 'detailed'],
    queryFn: () => api.get<HealthData>('/api/health/detailed'),
    refetchInterval: 5_000,
  });

  if (isLoading) return <PageLoader label="Checking health…" />;
  if (error) {
    return (
      <div className="p-6">
        <SectionHeader title="Health" />
        <p className="text-sm text-destructive">Failed: {String(error)}</p>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="p-6 space-y-6">
      <SectionHeader title="Health" subtitle="Live runtime status and provider health." />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Gateway</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2">
            <StatusPill
              tone={g.status === 'open' ? 'good' : 'bad'}
              label={g.status === 'open' ? 'Open' : g.status}
            />
            <span className="text-xs text-muted-foreground">port 8085</span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Claude</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusPill
              tone={data.claude?.status === 'ok' ? 'good' : 'muted'}
              label={data.claude?.status ?? 'unknown'}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Codex</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusPill
              tone={data.codex?.status === 'ok' ? 'good' : 'muted'}
              label={data.codex?.status ?? 'unknown'}
            />
          </CardContent>
        </Card>
      </div>

      {data.memory && (
        <Card>
          <CardHeader>
            <CardTitle>Memory</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-mono">
              {data.memory.used} MB / {data.memory.total} MB
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
