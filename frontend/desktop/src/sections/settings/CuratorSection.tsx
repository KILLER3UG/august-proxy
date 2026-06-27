/* ── Skill Curator — lifecycle management settings ─────────────────── */
/* Tracks usage, transitions active→stale→archived, pin/archive/restore. */

import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  Archive,
  RotateCcw,
  Clock,
  Pin,
  PinOff,
  CheckCircle,
  AlertCircle,
  Info,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { api } from '@/api/client';

interface SkillUsage {
  name: string;
  use_count: number;
  view_count: number;
  patch_count: number;
  last_used_at: number | null;
  state: string;
  pinned: boolean;
  archived_at: number | null;
}

interface CuratorReport {
  active: number;
  staled: string[];
  archived: string[];
  errors: string[];
}

export function CuratorSection() {
  const [skills, setSkills] = useState<SkillUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<CuratorReport | null>(null);

  const fetchSkills = useCallback(async () => {
    try {
      const data = await api.get<{ usage: SkillUsage[] }>('/api/curator/usage');
      setSkills(data.usage ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage');
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchSkills()]).finally(() => setLoading(false));
  }, [fetchSkills]);

  const handleRunCurator = async (dryRun = false) => {
    setRunning(true);
    setReport(null);
    try {
      const data = await api.post<{ report: CuratorReport }>(`/api/curator/run?dry_run=${dryRun}`);
      setReport(data.report);
      await fetchSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run curator');
    } finally {
      setRunning(false);
    }
  };

  const handleTogglePin = async (name: string, pinned: boolean) => {
    try {
      if (pinned) {
        await api.post(`/api/curator/unpin/${encodeURIComponent(name)}`);
      } else {
        await api.post(`/api/curator/pin/${encodeURIComponent(name)}`);
      }
      await fetchSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to toggle pin');
    }
  };

  const handleArchive = async (name: string) => {
    try {
      await api.post(`/api/curator/archive/${encodeURIComponent(name)}`);
      await fetchSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to archive');
    }
  };

  const handleRestore = async (name: string) => {
    try {
      await api.post(`/api/curator/restore/${encodeURIComponent(name)}`);
      await fetchSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to restore');
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const staledCount = skills.filter(s => s.state === 'stale').length;
  const archivedCount = skills.filter(s => s.state === 'archived').length;

  return (
    <div className="px-8 py-6 space-y-6 h-full flex flex-col overflow-auto">
      <header className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Skill Curator
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Automatic skill lifecycle management — tracks usage, archives unused skills.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {report && (
        <div className="rounded-lg border border-white/[0.06] bg-card/60 p-4 text-sm space-y-1">
          <p className="font-medium">Curation run complete</p>
          <p className="text-muted-foreground">
            {report.staled.length > 0 ? `Staled: ${report.staled.join(', ')}. ` : 'No skills staled. '}
            {report.archived.length > 0 ? `Archived: ${report.archived.join(', ')}. ` : 'No skills archived. '}
            {report.errors.length > 0 && `Errors: ${report.errors.join(', ')}.`}
          </p>
        </div>
      )}

      {/* Status Overview */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatusCard icon={<CheckCircle className="size-4" />} label="Active Skills" value={String(skills.filter(s => s.state === 'active').length)} />
        <StatusCard icon={<Clock className="size-4" />} label="Stale" value={String(staledCount)} tone={staledCount > 0 ? 'warn' : 'muted'} />
        <StatusCard icon={<Archive className="size-4" />} label="Archived" value={String(archivedCount)} tone="muted" />
        <StatusCard icon={<RefreshCw className="size-4" />} label="Total Tracked" value={String(skills.length)} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => handleRunCurator(false)}
          disabled={running}
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
                  <tr key={skill.name} className="border-b border-white/[0.06] hover:bg-white/[0.02]">
                    <td className="px-5 py-3 font-medium">{skill.name}</td>
                    <td className="px-5 py-3"><StateBadge state={skill.state} /></td>
                    <td className="px-5 py-3 text-muted-foreground">{skill.use_count}</td>
                    <td className="px-5 py-3 text-muted-foreground">{skill.view_count}</td>
                    <td className="px-5 py-3 text-muted-foreground">{skill.patch_count}</td>
                    <td className="px-5 py-3 text-muted-foreground">
                      {skill.last_used_at ? new Date(skill.last_used_at * 1000).toLocaleDateString() : 'Never'}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleTogglePin(skill.name, skill.pinned)}
                          className="text-muted-foreground hover:text-foreground"
                          title={skill.pinned ? 'Unpin' : 'Pin'}
                        >
                          {skill.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                        </button>
                        <button
                          onClick={() => handleArchive(skill.name)}
                          className="text-muted-foreground hover:text-foreground"
                          title="Archive"
                          disabled={skill.state === 'archived'}
                        >
                          <Archive className="size-4" />
                        </button>
                        <button
                          onClick={() => handleRestore(skill.name)}
                          className="text-muted-foreground hover:text-foreground"
                          title="Restore"
                          disabled={skill.state !== 'archived'}
                        >
                          <RotateCcw className="size-4" />
                        </button>
                      </div>
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
              <li>Skills are tracked automatically when used in conversations or created by the background review</li>
              <li>Unused skills become <strong>stale</strong> after 14 days</li>
              <li>Stale skills are <strong>archived</strong> after 60 days</li>
              <li>Pinned skills are never auto-archived</li>
              <li>The background review runs automatically after every few turns to capture lessons as skills</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────── */

function StatusCard({ icon, label, value, tone = 'muted' }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'muted';
}) {
  const colors = { good: 'text-success', warn: 'text-warning', muted: 'text-muted-foreground' };
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

function StateBadge({ state }: { state: string }) {
  const config: Record<string, { label: string; className: string }> = {
    active: { label: 'Active', className: 'bg-success/20 text-success' },
    stale: { label: 'Stale', className: 'bg-warning/20 text-warning' },
    archived: { label: 'Archived', className: 'bg-muted text-muted-foreground' },
  };
  const c = config[state] ?? { label: state, className: 'bg-muted text-muted-foreground' };
  return <Badge variant="outline" className={c.className}>{c.label}</Badge>;
}
