/* Cognitive operator panel — boot layers, consolidation, fleet link, sync. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2, RefreshCw, Play, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { api } from '@/api/client';

interface CognitiveTree {
  boot?: Record<string, boolean>;
  features?: Record<string, boolean>;
  fleet?: Record<string, string>;
  consolidation_interval_s?: number;
}

interface SyncStatus {
  brainSync?: Record<string, unknown>;
  cognitiveBoot?: {
    started?: boolean;
    services?: Record<string, unknown>;
    errors?: string[];
  };
}

interface SessionExportStatus {
  enabled?: boolean;
  envOverrides?: boolean;
  source?: string;
  path?: string;
  fileExists?: boolean;
  note?: string;
  exportedPath?: string;
}

export function CognitiveOpsTab() {
  const qc = useQueryClient();

  const cognitiveQ = useQuery({
    queryKey: ['cognitive-config'],
    queryFn: () => api.get<CognitiveTree>('/api/config/cognitive'),
    staleTime: 5_000,
  });

  const syncQ = useQuery({
    queryKey: ['brain-sync-status'],
    queryFn: () => api.get<SyncStatus>('/api/brain/sync-status'),
    refetchInterval: 15_000,
  });

  const sessionExportQ = useQuery({
    queryKey: ['session-export-config'],
    queryFn: () => api.get<SessionExportStatus>('/api/config/session-export'),
    staleTime: 5_000,
  });

  const consolidate = useMutation({
    mutationFn: () => api.post<Record<string, unknown>>('/api/brain/run-consolidation', {}),
    onSuccess: (data) => {
      toast.success(`Consolidation done: ${JSON.stringify(data).slice(0, 120)}`);
      void qc.invalidateQueries({ queryKey: ['brain-learning'] });
      void qc.invalidateQueries({ queryKey: ['brain-sync-status'] });
      void qc.invalidateQueries({ queryKey: ['brain-health'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Consolidation failed'),
  });

  const backfill = useMutation({
    mutationFn: () => api.post<Record<string, unknown>>('/api/brain/backfill-workbench', {}),
    onSuccess: (data) => {
      toast.success(`Backfill: ${JSON.stringify(data).slice(0, 120)}`);
      void qc.invalidateQueries({ queryKey: ['brain-sync-status'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Backfill failed'),
  });

  const toggleBoot = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: boolean }) => {
      const boot = { ...(cognitiveQ.data?.boot ?? {}), [key]: value };
      return api.put<CognitiveTree>('/api/config/cognitive', { boot });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cognitive-config'] });
      toast.success('Cognitive boot flags saved (restart to fully apply)');
    },
    onError: (e: Error) => toast.error(e.message || 'Save failed'),
  });

  const toggleSessionExport = useMutation({
    mutationFn: (enabled: boolean) =>
      api.put<SessionExportStatus>('/api/config/session-export', { enabled }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['session-export-config'] });
      toast.success(data.enabled ? 'JSON session export enabled' : 'JSON session export disabled');
    },
    onError: (e: Error) => toast.error(e.message || 'Export toggle failed'),
  });

  const exportNow = useMutation({
    mutationFn: () =>
      api.put<SessionExportStatus>('/api/config/session-export', {
        enabled: sessionExportQ.data?.enabled ?? false,
        exportNow: true,
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['session-export-config'] });
      toast.success(`Exported snapshot to ${data.exportedPath || data.path || 'disk'}`);
    },
    onError: (e: Error) => toast.error(e.message || 'One-shot export failed'),
  });

  if (cognitiveQ.isLoading) {
    return (
      <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
        <Loader2 className="size-4 animate-spin" /> Loading cognitive config…
      </div>
    );
  }

  const boot = cognitiveQ.data?.boot ?? {};
  const features = cognitiveQ.data?.features ?? {};
  const fleet = cognitiveQ.data?.fleet ?? {};
  const services = syncQ.data?.cognitiveBoot?.services ?? {};

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="p-4 space-y-3 md:col-span-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings2 className="size-4 text-primary" />
            <h3 className="font-medium text-sm">Cognitive boot layers</h3>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
              disabled={consolidate.isPending}
              onClick={() => consolidate.mutate()}
              data-testid="ops-run-consolidation"
            >
              <Play className="size-3 inline mr-1" />
              Run consolidation
            </button>
            <button
              type="button"
              className="text-xs px-2 py-1 rounded border border-border"
              disabled={backfill.isPending}
              onClick={() => backfill.mutate()}
              data-testid="ops-backfill"
            >
              <RefreshCw className="size-3 inline mr-1" />
              Backfill workbench
            </button>
          </div>
        </div>
        <ul className="grid sm:grid-cols-2 gap-2">
          {Object.entries(boot).map(([key, val]) => (
            <li key={key} className="flex items-center justify-between text-xs p-2 rounded bg-muted/20">
              <span className="font-mono">{key}</span>
              <button
                type="button"
                className={`px-2 py-0.5 rounded ${val ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'}`}
                onClick={() => toggleBoot.mutate({ key, value: !val })}
                data-testid={`ops-boot-${key}`}
              >
                {val ? 'on' : 'off'}
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4 space-y-2">
        <h3 className="font-medium text-sm">Runtime services</h3>
        <pre className="text-[10px] overflow-auto max-h-48 bg-black/20 p-2 rounded">
          {JSON.stringify(services, null, 2)}
        </pre>
      </Card>

      <Card className="p-4 space-y-2">
        <h3 className="font-medium text-sm">Model fleet (read-only here)</h3>
        <ul className="text-xs space-y-1">
          {Object.entries(fleet).map(([role, model]) => (
            <li key={role} className="flex justify-between gap-2">
              <span className="text-muted-foreground">{role}</span>
              <span className="font-mono truncate">{model || '(session model)'}</span>
            </li>
          ))}
        </ul>
        <p className="text-[10px] text-muted-foreground">
          Edit fleet under Settings → Model Fleet. Saves apply without restart.
        </p>
      </Card>

      <Card className="p-4 space-y-2 md:col-span-2">
        <h3 className="font-medium text-sm">Feature flags</h3>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(features).map(([k, v]) => (
            <span
              key={k}
              className={`text-[10px] px-2 py-0.5 rounded-full ${v ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'}`}
            >
              {k}: {v ? 'on' : 'off'}
            </span>
          ))}
        </div>
      </Card>

      <Card className="p-4 space-y-3 md:col-span-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="font-medium text-sm">Session JSON export (admin backup)</h3>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              SQLite is always the session source of truth. This only writes an optional
              workbench-sessions.json backup.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              className={`text-xs px-2 py-1 rounded ${sessionExportQ.data?.enabled ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'}`}
              disabled={toggleSessionExport.isPending || sessionExportQ.data?.envOverrides}
              onClick={() =>
                toggleSessionExport.mutate(!(sessionExportQ.data?.enabled ?? false))
              }
              data-testid="ops-session-export-toggle"
            >
              {sessionExportQ.data?.enabled ? 'export on' : 'export off'}
            </button>
            <button
              type="button"
              className="text-xs px-2 py-1 rounded border border-border"
              disabled={exportNow.isPending}
              onClick={() => exportNow.mutate()}
              data-testid="ops-session-export-now"
            >
              Export now
            </button>
          </div>
        </div>
        {sessionExportQ.data?.envOverrides && (
          <p className="text-[10px] text-warning">
            Env AUGUST_SESSION_JSON_EXPORT overrides the config toggle.
          </p>
        )}
        <p className="text-[10px] font-mono text-muted-foreground break-all">
          {sessionExportQ.data?.path || '…'}
          {sessionExportQ.data?.fileExists ? ' (file present)' : ' (no file yet)'}
        </p>
      </Card>
    </div>
  );
}
