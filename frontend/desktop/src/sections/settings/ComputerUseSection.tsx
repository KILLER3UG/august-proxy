/* ── Computer Use — Desktop automation settings ────────────────────── */
/* Manages computer use backend, health diagnostics, and approval workflows. */

import { useState } from 'react';
import {
  Monitor,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Info,
  Shield,
  MousePointer,
  Keyboard,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useComputerUseHealth, useComputerUseConfig } from '@/hooks/useComputerUse';
import type { HealthCheck, HealthReport, ComputerUseConfig } from '@/hooks/useComputerUse';

export function ComputerUseSection() {
  const { data: health, isLoading: healthLoading, refetch: refetchHealth, error: healthError } = useComputerUseHealth();
  const { data: config, isLoading: configLoading, refetch: refetchConfig, error: configError } = useComputerUseConfig();
  const error = healthError || configError;

  const loading = healthLoading || configLoading;

  const handleRefresh = async () => {
    await Promise.all([refetchHealth(), refetchConfig()]);
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="px-8 py-6 space-y-6 h-full flex flex-col overflow-auto">
      <header className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Computer Use
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Desktop automation with SOM overlay, cross-platform support, and safe approval workflows.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* Status Overview */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatusCard
          icon={<Monitor className="size-4" />}
          label="Status"
          value={config?.enabled ? 'Enabled' : 'Disabled'}
          tone={config?.enabled ? 'good' : 'muted'}
        />
        <StatusCard
          icon={<Shield className="size-4" />}
          label="Health"
          value={health?.overall || 'Unknown'}
          tone={health?.overall === 'ok' ? 'good' : health?.overall === 'warning' ? 'warn' : 'muted'}
        />
        <StatusCard
          icon={<MousePointer className="size-4" />}
          label="Backend"
          value={config?.backend || 'cua'}
          tone="muted"
        />
        <StatusCard
          icon={<Keyboard className="size-4" />}
          label="Platform"
          value={health?.platform || 'Unknown'}
          tone="muted"
        />
      </div>

      {/* Health Checks */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Health Checks</h3>
          <button
            onClick={() => { void handleRefresh(); }}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="size-4" />
          </button>
        </div>
        <div className="space-y-3">
          {health?.checks.map((check, i) => (
            <div
              key={i}
              className="flex items-start gap-3 rounded-lg border border-white/[0.06] bg-card/40 p-3"
            >
              {check.status === 'ok' ? (
                <CheckCircle className="size-4 text-success mt-0.5 shrink-0" />
              ) : check.status === 'warning' ? (
                <AlertCircle className="size-4 text-warning mt-0.5 shrink-0" />
              ) : (
                <AlertCircle className="size-4 text-destructive mt-0.5 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{check.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{check.message}</p>
                {check.details.solution != null && (
                  <p className="text-xs text-muted-foreground mt-1 italic">
                    Solution: {check.details.solution as string}
                  </p>
                )}
              </div>
              <Badge
                variant="outline"
                className={
                  check.status === 'ok'
                    ? 'bg-success/20 text-success'
                    : check.status === 'warning'
                    ? 'bg-warning/20 text-warning'
                    : 'bg-destructive/20 text-destructive'
                }
              >
                {check.status}
              </Badge>
            </div>
          ))}
          {(!health?.checks || health.checks.length === 0) && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No health checks available
            </p>
          )}
        </div>
      </div>

      {/* Configuration */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
        <h3 className="text-sm font-semibold">Configuration</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Auto-approve actions</p>
            <div className="flex flex-wrap gap-1">
              {config?.autoApprove.map((action) => (
                <Badge key={action} variant="outline" className="text-xs">
                  {action}
                </Badge>
              ))}
              {(!config?.autoApprove || config.autoApprove.length === 0) && (
                <span className="text-xs text-muted-foreground">None</span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Blocked key combos</p>
            <div className="flex flex-wrap gap-1">
              {config?.blocklistKeys.map((key) => (
                <Badge key={key} variant="outline" className="text-xs bg-destructive/10">
                  {key}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="rounded-lg border border-white/[0.06] bg-card/40 p-4 text-sm text-muted-foreground">
        <div className="flex items-start gap-2">
          <Info className="size-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-foreground mb-1">How it works</p>
            <ul className="space-y-1 list-disc list-inside">
              <li>Computer use captures your screen and identifies interactable elements</li>
              <li>SOM (Set of Mark) overlay numbers each element for reliable clicking</li>
              <li>Safe actions (capture) are auto-approved; dangerous actions require confirmation</li>
              <li>Works on macOS, Windows, and Linux with platform-specific optimizations</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────── */

function StatusCard({
  icon,
  label,
  value,
  tone: _tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'muted';
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
      </div>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
