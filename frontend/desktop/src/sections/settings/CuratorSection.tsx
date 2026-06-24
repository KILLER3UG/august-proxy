/* ── Curator — Skill lifecycle management settings ─────────────────── */
/* Manages skill usage tracking, auto-stale/archived transitions,
 * and LLM consolidation for umbrella-building. */

import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  Pause,
  Play,
  Archive,
  RotateCcw,
  Clock,
  CheckCircle,
  AlertCircle,
  Info,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface CuratorStatus {
  config: {
    enabled: boolean;
    interval_hours: number;
    stale_after_days: number;
    archive_after_days: number;
    consolidate: boolean;
    paused: boolean;
  };
  state: {
    last_run_at: string | null;
    last_run_duration_seconds: number | null;
    last_run_summary: string | null;
    last_report_path: string | null;
    run_count: number;
  };
  should_run_now: boolean;
}

interface SkillUsage {
  name: string;
  created_by: string;
  use_count: number;
  view_count: number;
  patch_count: number;
  last_activity_at: string | null;
  state: string;
  pinned: boolean;
  created_at: string;
}

export function CuratorSection() {
  const [status, setStatus] = useState<CuratorStatus | null>(null);
  const [skills, setSkills] = useState<SkillUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/curator/status');
      if (!res.ok) throw new Error('Failed to fetch curator status');
      const data = await res.json();
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  }, []);

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch('/api/curator/skills');
      if (!res.ok) throw new Error('Failed to fetch skills');
      const data = await res.json();
      setSkills(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchStatus(), fetchSkills()]).finally(() => setLoading(false));
  }, [fetchStatus, fetchSkills]);

  const handleRunCurator = async (dryRun = false) => {
    setRunning(true);
    try {
      const res = await fetch('/api/curator/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: dryRun }),
      });
      if (!res.ok) throw new Error('Failed to run curator');
      await fetchStatus();
      await fetchSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setRunning(false);
    }
  };

  const handlePauseToggle = async () => {
    if (!status) return;
    const action = status.config.paused ? 'unpause' : 'pause';
    try {
      const res = await fetch(`/api/curator/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error(`Failed to ${action} curator`);
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const handleTogglePin = async (skillName: string, pinned: boolean) => {
    try {
      const res = await fetch(`/api/curator/skills/${skillName}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !pinned }),
      });
      if (!res.ok) throw new Error('Failed to toggle pin');
      await fetchSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
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
          Skill Curator
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Automatic skill lifecycle management — tracks usage, archives unused skills,
          and consolidates related skills into umbrella knowledge.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Status Overview */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatusCard
          icon={<Clock className="size-4" />}
          label="Status"
          value={status?.config.paused ? 'Paused' : status?.config.enabled ? 'Active' : 'Disabled'}
          tone={status?.config.paused ? 'muted' : status?.config.enabled ? 'good' : 'warn'}
        />
        <StatusCard
          icon={<RefreshCw className="size-4" />}
          label="Last Run"
          value={
            status?.state.last_run_at
              ? new Date(status.state.last_run_at).toLocaleString()
              : 'Never'
          }
          tone="muted"
        />
        <StatusCard
          icon={<CheckCircle className="size-4" />}
          label="Total Runs"
          value={String(status?.state.run_count || 0)}
          tone="muted"
        />
        <StatusCard
          icon={<Archive className="size-4" />}
          label="Skills Tracked"
          value={String(skills.length)}
          tone="muted"
        />
      </div>

      {/* Configuration */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-4">
        <h3 className="text-sm font-semibold">Configuration</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ConfigItem
            label="Review Interval"
            value={`${status?.config.interval_hours || 168} hours`}
          />
          <ConfigItem
            label="Stale After"
            value={`${status?.config.stale_after_days || 30} days`}
          />
          <ConfigItem
            label="Archive After"
            value={`${status?.config.archive_after_days || 90} days`}
          />
          <ConfigItem
            label="LLM Consolidation"
            value={status?.config.consolidate ? 'Enabled' : 'Disabled'}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => handleRunCurator(false)}
          disabled={running || status?.config.paused}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <RefreshCw className={`size-4 ${running ? 'animate-spin' : ''}`} />
          Run Now
        </button>
        <button
          onClick={() => handleRunCurator(true)}
          disabled={running}
          className="inline-flex items-center gap-2 rounded-lg border border-white/[0.06] bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-card/80 disabled:opacity-50"
        >
          Dry Run
        </button>
        <button
          onClick={handlePauseToggle}
          disabled={running}
          className="inline-flex items-center gap-2 rounded-lg border border-white/[0.06] bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-card/80 disabled:opacity-50"
        >
          {status?.config.paused ? (
            <>
              <Play className="size-4" />
              Resume
            </>
          ) : (
            <>
              <Pause className="size-4" />
              Pause
            </>
          )}
        </button>
      </div>

      {/* Skills Table */}
      <div className="rounded-xl border border-white/[0.06] bg-card/60 overflow-hidden">
        <div className="px-5 py-3 border-b border-white/[0.06]">
          <h3 className="text-sm font-semibold">Tracked Skills</h3>
        </div>
        <div className="overflow-auto max-h-[400px]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card/95">
              <tr className="border-b border-white/[0.06] text-left text-muted-foreground">
                <th className="px-5 py-2 font-medium">Name</th>
                <th className="px-5 py-2 font-medium">State</th>
                <th className="px-5 py-2 font-medium">Uses</th>
                <th className="px-5 py-2 font-medium">Views</th>
                <th className="px-5 py-2 font-medium">Patches</th>
                <th className="px-5 py-2 font-medium">Last Activity</th>
                <th className="px-5 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {skills.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-muted-foreground">
                    No skills tracked yet. Skills will appear here after use.
                  </td>
                </tr>
              ) : (
                skills.map((skill) => (
                  <tr
                    key={skill.name}
                    className="border-b border-white/[0.06] hover:bg-white/[0.02]"
                  >
                    <td className="px-5 py-3 font-medium">{skill.name}</td>
                    <td className="px-5 py-3">
                      <StateBadge state={skill.state} />
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{skill.use_count}</td>
                    <td className="px-5 py-3 text-muted-foreground">{skill.view_count}</td>
                    <td className="px-5 py-3 text-muted-foreground">{skill.patch_count}</td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {skill.last_activity_at
                        ? new Date(skill.last_activity_at).toLocaleDateString()
                        : 'Never'}
                    </td>
                    <td className="px-5 py-3">
                      <button
                        onClick={() => handleTogglePin(skill.name, skill.pinned)}
                        className="text-muted-foreground hover:text-foreground"
                        title={skill.pinned ? 'Unpin' : 'Pin'}
                      >
                        {skill.pinned ? '📌' : '📍'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Info */}
      <div className="rounded-lg border border-white/[0.06] bg-card/40 p-4 text-sm text-muted-foreground">
        <div className="flex items-start gap-2">
          <Info className="size-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-foreground mb-1">How it works</p>
            <ul className="space-y-1 list-disc list-inside">
              <li>Skills are tracked automatically when used in conversations</li>
              <li>Unused skills become <strong>stale</strong> after {status?.config.stale_after_days || 30} days</li>
              <li>Stale skills are <strong>archived</strong> after {status?.config.archive_after_days || 90} days</li>
              <li>Pinned skills are never auto-archived</li>
              <li>LLM consolidation (optional) merges narrow skills into umbrella knowledge</li>
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
  tone,
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

function ConfigItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const config = {
    active: { label: 'Active', className: 'bg-success/20 text-success' },
    stale: { label: 'Stale', className: 'bg-warning/20 text-warning' },
    archived: { label: 'Archived', className: 'bg-muted text-muted-foreground' },
  }[state] || { label: state, className: 'bg-muted text-muted-foreground' };

  return (
    <Badge variant="outline" className={config.className}>
      {config.label}
    </Badge>
  );
}
