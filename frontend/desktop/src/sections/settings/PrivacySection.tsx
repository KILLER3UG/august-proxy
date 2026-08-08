/* ── Data & Privacy center — what August stores, and how to erase it ── */
/* Fed by /api/privacy/summary; destructive actions (purge/clear/delete)
 * always confirm first and surface exactly what was removed. Everything
 * here is local-first — nothing leaves the device. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Brain,
  Camera,
  Database,
  Download,
  Eraser,
  FileClock,
  MessagesSquare,
  Trash2,
  HardDrive,
} from 'lucide-react';
import { api } from '@/api/client';
import { PageLoader } from '@/components/PageLoader';

interface PrivacyCounts {
  facts: number;
  autoMemories: number;
  heuristics: number;
  proposals: number;
  timeline: number;
  sessions: number;
  messages: number;
  usageEvents: number;
  auditEvents: number;
  configAudit: number;
  routingEvidence: number;
  subagentRuns: number;
  observations: number;
  dbSizeBytes: number;
}

interface PrivacySummary {
  counts: PrivacyCounts;
}

interface MutationResult {
  deleted?: Record<string, number>;
  path?: string;
  bytes?: number;
  entries?: Record<string, number>;
}

function fmtBytes(b?: number): string {
  if (!b) return '—';
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1_024) return `${(b / 1_024).toFixed(0)} KB`;
  return `${b} B`;
}

function StatCard({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Database }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <p className="mt-1.5 text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}

function ActionRow({
  icon: Icon,
  title,
  description,
  buttonLabel,
  destructive,
  pending,
  onClick,
}: {
  icon: typeof Database;
  title: string;
  description: string;
  buttonLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-card/60 p-4">
      <Icon className={`size-4 shrink-0 ${destructive ? 'text-rose-500' : 'text-primary'}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={onClick}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-xs disabled:opacity-50 ${
          destructive
            ? 'bg-rose-500/15 text-rose-400 hover:bg-rose-500/25'
            : 'bg-primary text-primary-foreground hover:bg-primary/90'
        }`}
        data-testid={`privacy-${title.toLowerCase().replace(/\s+/g, '-')}`}
      >
        {pending ? 'Working…' : buttonLabel}
      </button>
    </div>
  );
}

export function PrivacySection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<PrivacySummary>({
    queryKey: ['privacy-summary'],
    queryFn: () => api.get<PrivacySummary>('/api/privacy/summary'),
    staleTime: 10_000,
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['privacy-summary'] });

  const exportData = useMutation({
    mutationFn: () => api.post<MutationResult>('/api/privacy/export'),
    onSuccess: (res) => {
      toast.success(`Export written (${fmtBytes(res.bytes)}) — ${res.path ?? 'see backend data dir'}`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Export failed'),
  });

  const purgeMemories = useMutation({
    mutationFn: () => api.post<MutationResult>('/api/privacy/purge-memories'),
    onSuccess: (res) => {
      const d = res.deleted ?? {};
      toast.success(`Memory erased: ${Object.values(d).reduce((a, b) => a + b, 0)} entries`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Purge failed'),
  });

  const clearLogs = useMutation({
    mutationFn: () => api.post<MutationResult>('/api/privacy/clear-logs'),
    onSuccess: (res) => {
      const d = res.deleted ?? {};
      toast.success(`Logs cleared: ${Object.values(d).reduce((a, b) => a + b, 0)} entries + screenshots`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Clear failed'),
  });

  const deleteUsage = useMutation({
    mutationFn: () => api.post<MutationResult>('/api/privacy/delete-usage'),
    onSuccess: (res) => {
      toast.success(`Usage history deleted: ${res.deleted?.usage_events ?? 0} events`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });

  const deleteSessions = useMutation({
    mutationFn: () => api.post<MutationResult>('/api/privacy/delete-sessions'),
    onSuccess: (res) => {
      const d = res.deleted ?? {};
      const total = (d.sessions ?? 0) + (d.workbenchSessions ?? 0);
      toast.success(`Deleted ${total} sessions (${d.messages ?? 0} messages)`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });

  const c = data?.counts;

  return (
    <div className="px-8 py-6 max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <Database className="size-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Data &amp; Privacy</h1>
          <p className="text-sm text-muted-foreground">
            Everything August stores stays on this device — inspect it, export it, or erase it.
          </p>
        </div>
      </div>

      {isLoading || !c ? (
        <PageLoader label="Loading storage summary…" variant="card" className="py-10" />
      ) : (
        <>
          {/* What's stored */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={Brain} label="Memories" value={String((c.facts ?? 0) + (c.autoMemories ?? 0) + (c.heuristics ?? 0))} />
            <StatCard icon={MessagesSquare} label="Messages" value={String(c.messages ?? 0)} />
            <StatCard icon={FileClock} label="Audit events" value={String(c.auditEvents ?? 0)} />
            <StatCard icon={Camera} label="Screenshots" value={String(c.observations ?? 0)} />
            <StatCard icon={Database} label="Usage events" value={String(c.usageEvents ?? 0)} />
            <StatCard icon={HardDrive} label="Database" value={fmtBytes(c.dbSizeBytes)} />
            <StatCard icon={MessagesSquare} label="Sessions" value={String(c.sessions ?? 0)} />
            <StatCard icon={Database} label="Routing evidence" value={String(c.routingEvidence ?? 0)} />
          </div>

          {/* Actions */}
          <div className="space-y-2">
            <ActionRow
              icon={Download}
              title="Export all data"
              description="One readable JSON file: memories, transcripts, and usage, saved to the backend data directory."
              buttonLabel="Export"
              pending={exportData.isPending}
              onClick={() => exportData.mutate()}
            />
            <ActionRow
              icon={Eraser}
              title="Purge memory"
              description={`Erase ${(c.facts ?? 0) + (c.autoMemories ?? 0) + (c.heuristics ?? 0) + (c.timeline ?? 0) + (c.proposals ?? 0)} memory entries — facts, auto-memories, heuristics, proposals, timeline. System config is kept.`}
              buttonLabel="Purge"
              destructive
              pending={purgeMemories.isPending}
              onClick={() => {
                if (confirm('Erase all agent memories? This cannot be undone.')) purgeMemories.mutate();
              }}
            />
            <ActionRow
              icon={FileClock}
              title="Clear activity logs"
              description={`Delete ${(c.auditEvents ?? 0) + (c.configAudit ?? 0)} audit events and ${c.observations ?? 0} observation screenshots.`}
              buttonLabel="Clear logs"
              destructive
              pending={clearLogs.isPending}
              onClick={() => {
                if (confirm('Clear audit logs and observation screenshots? This cannot be undone.')) clearLogs.mutate();
              }}
            />
            <ActionRow
              icon={Trash2}
              title="Delete usage history"
              description={`Remove ${c.usageEvents ?? 0} token-usage events (quota displays reset to zero).`}
              buttonLabel="Delete"
              destructive
              pending={deleteUsage.isPending}
              onClick={() => {
                if (confirm('Delete all token usage history? Quota displays will reset.')) deleteUsage.mutate();
              }}
            />
            <ActionRow
              icon={AlertTriangle}
              title="Delete all sessions"
              description={`Remove ${c.sessions ?? 0} sessions and ${c.messages ?? 0} messages — every chat and workbench transcript on this device.`}
              buttonLabel="Delete all"
              destructive
              pending={deleteSessions.isPending}
              onClick={() => {
                if (confirm('Delete ALL sessions and transcripts? This cannot be undone.')) deleteSessions.mutate();
              }}
            />
          </div>

          <p className="text-[11px] text-muted-foreground/60 flex items-center gap-1.5">
            <HardDrive className="size-3" />
            All data lives in the local backend database — nothing is sent anywhere unless you explicitly connect an external service.
          </p>
        </>
      )}
    </div>
  );
}
