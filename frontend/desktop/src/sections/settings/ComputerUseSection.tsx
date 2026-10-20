/* ── Computer Use — Desktop automation settings ────────────────────── */
/* Manages computer use backend, health diagnostics, and approval workflows. */

import {
  Monitor,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Shield,
  MousePointer,
  Keyboard,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { SectionHeader } from '@/components/SectionHeader';
import { PageLoader } from '@/components/PageLoader';
import { useComputerUseHealth, useComputerUseConfig } from '@/hooks/useComputerUse';

export function ComputerUseSection() {
  const { data: health, isLoading: healthLoading, refetch: refetchHealth, error: healthError } = useComputerUseHealth();
  const { data: config, isLoading: configLoading, refetch: refetchConfig, error: configError } = useComputerUseConfig();
  const error = healthError || configError;

  const loading = healthLoading || configLoading;

  const handleRefresh = async () => {
    await Promise.all([refetchHealth(), refetchConfig()]);
  };

  if (loading) {
    return <PageLoader label="Loading computer use…" variant="card" className="h-full" />;
  }

  return (
    <div className="px-8 py-6 h-full flex flex-col overflow-auto">
      <SectionHeader
        title="Computer Use"
        subtitle="Desktop automation with SOM overlay, cross-platform support, and safe approval workflows."
        className="mb-4"
      />

      {error && (
        <p className="text-sm text-danger-fg" role="alert">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {/* ONE container, hairline-separated children. The four stat cards, the
          health panel, the configuration and the explainer were four bordered
          boxes (and a box inside a box); the reference's shape is one rounded
          container with hairline children. */}
      <div className="rounded-xl border border-border/60 bg-card/60">
        {/* Status */}
        <div className="flex flex-col divide-y divide-white/[0.06] sm:flex-row sm:divide-y-0 sm:divide-x">
          <StatusCell
            icon={<Monitor className="size-4" />}
            label="Status"
            value={config?.enabled ? 'Enabled' : 'Disabled'}
            tone={config?.enabled ? 'good' : 'muted'}
          />
          <StatusCell
            icon={<Shield className="size-4" />}
            label="Health"
            value={health?.overall || 'Unknown'}
            tone={
              health?.overall === 'ok'
                ? 'good'
                : health?.overall === 'warning' || health?.overall === 'error'
                  ? 'warn'
                  : 'muted'
            }
          />
          <StatusCell
            icon={<MousePointer className="size-4" />}
            label="Backend"
            value={config?.backend || 'cua'}
            tone="muted"
          />
          <StatusCell
            icon={<Keyboard className="size-4" />}
            label="Platform"
            value={health?.platform || 'Unknown'}
            tone="muted"
          />
        </div>

        {/* Health Checks */}
        <section className="border-t border-border/60 p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Health Checks</h3>
            <button
              onClick={() => { void handleRefresh(); }}
              aria-label="Refresh health checks"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="size-4" />
            </button>
          </div>
          <div className="mt-3 divide-y divide-white/[0.04]">
            {health?.checks.map((check, i) => (
              <div key={i} className="flex items-start gap-3 py-2">
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
                {/* The status is a WORD, not a coloured chip: the reference
                    keeps metadata muted, and the word carries the meaning. */}
                <Badge variant="outline" className="text-muted-foreground">
                  {check.status}
                </Badge>
              </div>
            ))}
            {(!health?.checks || health.checks.length === 0) && (
              <p className="text-sm text-muted-foreground py-2">
                No health checks available
              </p>
            )}
          </div>
        </section>

        {/* Configuration */}
        <section className="border-t border-border/60 p-5">
          <h3 className="text-sm font-semibold text-foreground">Configuration</h3>
          <div className="mt-3 divide-y divide-white/[0.04]">
            <div className="flex items-center justify-between gap-4 py-2">
              <span className="text-sm text-foreground">Auto-approve actions</span>
              {/* One bordered pill showing the value — the reference's value
                  control — not a row of four chips. */}
              <span className="inline-flex items-center rounded-lg border border-border/70 bg-background px-2.5 py-1 text-sm text-foreground">
                {config?.autoApprove?.length ? config.autoApprove.join(', ') : 'None'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 py-2">
              <span className="text-sm text-foreground">Blocked key combos</span>
              <span className="inline-flex items-center rounded-lg border border-border/70 bg-background px-2.5 py-1 text-sm text-foreground">
                {config?.blocklistKeys?.length ? config.blocklistKeys.join(', ') : 'None'}
              </span>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-border/60 p-5">
          <h3 className="text-sm font-semibold text-foreground">How it works</h3>
          <ul className="mt-2 space-y-1 list-disc list-inside text-sm text-muted-foreground">
            <li>Computer use captures your screen and identifies interactable elements</li>
            <li>SOM (Set of Mark) overlay numbers each element for reliable clicking</li>
            <li>Safe actions (capture) are auto-approved; dangerous actions require confirmation</li>
            <li>Works on macOS, Windows, and Linux with platform-specific optimizations</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

/* The value's tone. The caller has always computed one; it used to be
 * accepted and thrown away (`tone: _tone`), so "Disabled", "error",
 * "pyautogui" and "windows" all rendered the same white and the signal was
 * lost. `good` is the plain foreground, `warn` the amber status colour, and
 * `muted` the quiet one. */
const TONE_CLASS: Record<'good' | 'warn' | 'muted', string> = {
  good: 'text-foreground',
  warn: 'text-warning-fg',
  muted: 'text-muted-foreground',
};

/** One stat, as a CELL of the single container — not a card of its own. */
function StatusCell({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'muted';
}) {
  return (
    <div className="min-w-0 p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
      </div>
      <p className={`text-lg font-semibold ${TONE_CLASS[tone]}`}>{value}</p>
    </div>
  );
}
