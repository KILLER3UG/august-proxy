/* Observability overview — audit / host / observations. Token charts live on Usage. */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Camera, History, Wifi, type LucideIcon } from 'lucide-react';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { PageLoader } from '@/components/PageLoader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { variantForHostStatus } from '@/components/workspace/StatusPill';
import { getObservabilityOverview } from '@/api/api-client';
import { Button } from '@/components/ui/button';
import { ErrorBoundary } from '@/components/ErrorBoundary';

export function ObservabilityOverview({
  onNavigate,
}: {
  onNavigate?: (subtab: 'overview' | 'audit' | 'rollback' | 'observations' | 'requests') => void;
}) {
  const overview = useQuery({
    queryKey: ['observability', 'overview'],
    queryFn: () => getObservabilityOverview('30d'),
    refetchInterval: 5000,
  });

  if (overview.isLoading) {
    return <PageLoader label="Loading observability…" variant="card" className="py-2" />;
  }

  const o = overview.data;
  if (!o) {
    return <SettingsEmptyState title="No data" description="Could not load observability overview." />;
  }

  const criticalCount = o.audit.byCritical.true ?? 0;

  return (
    <ErrorBoundary
      fallback={
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm">
          <p className="font-semibold text-rose-300">Observability render error</p>
        </div>
      }
    >
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={AlertTriangle}
            label="Critical actions"
            value={String(criticalCount)}
            accent={criticalCount > 0 ? 'text-danger' : 'text-foreground'}
          />
          <StatCard
            icon={History}
            label="Available rollbacks"
            value={String(o.rollback.available)}
            accent="text-warning"
          />
          <StatCard
            icon={Wifi}
            label="Host agent"
            value={o.hostAgent.status}
            accent={
              variantForHostStatus(o.hostAgent.status) === 'ok'
                ? 'text-success'
                : 'text-muted-foreground'
            }
          />
          <StatCard
            icon={Camera}
            label="Observations"
            value={String(o.hostAgent.postObservationCount)}
            accent="text-foreground"
          />
        </div>

        <p className="text-[13px] text-muted-foreground">
          Token counts, heatmaps, and per-model share live in{' '}
          <Link to="/settings/usage" className="text-foreground/90 underline-offset-2 hover:underline">
            Usage &amp; Limits
          </Link>
          . App allowlists are under{' '}
          <Link
            to="/settings/computer-access"
            className="text-foreground/90 underline-offset-2 hover:underline"
          >
            Desktop App Permissions
          </Link>
          .
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Audit summary (last 30d)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row k="Total entries" v={String(o.audit.count)} />
              <Row k="By result: ok" v={String(o.audit.byResult.ok ?? 0)} />
              <Row k="By result: blocked" v={String(o.audit.byResult.blocked ?? 0)} />
              <Row k="By result: error" v={String(o.audit.byResult.error ?? 0)} />
              <Row k="Critical" v={String(criticalCount)} />
              <div className="pt-1">
                <Button variant="ghost" size="sm" onClick={() => onNavigate?.('audit')}>
                  Open audit log →
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </ErrorBoundary>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="py-4 flex items-start gap-3">
        <div className="rounded-md bg-white/[0.04] p-2 text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
          <div className={`mt-1 text-lg font-semibold truncate ${accent || ''}`}>{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-medium">{v}</span>
    </div>
  );
}
