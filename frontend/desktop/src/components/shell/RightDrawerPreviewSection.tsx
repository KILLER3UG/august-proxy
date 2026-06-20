/* ── RightDrawerPreviewSection ─ browser preview workflow ────────── */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Check, Globe, Loader2, Play, ShieldAlert, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  approvePreviewRequest,
  getPreviewSession,
  getPreviewSessions,
  getRequests,
  startPreviewSession,
  stopPreviewSession,
  type PreviewApproval,
} from '@/api/backend-ui';
import type { RequestEntry } from '@/api/backend-ui';

export function RightDrawerPreviewSection({
  sessionId,
  workspacePath,
}: {
  sessionId: string | null;
  workspacePath: string | null;
}) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [command, setCommand] = useState('npm run dev');
  const [previewUrl, setPreviewUrl] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['preview-sessions', sessionId],
    queryFn: getPreviewSessions,
    refetchInterval: 2_500,
  });

  const sessions = data?.sessions ?? [];
  const approvals = data?.approvals ?? [];
  const active = sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null;

  const { data: activePreview } = useQuery({
    queryKey: ['preview-session', active?.id],
    queryFn: () => (active?.id ? getPreviewSession(active.id) : Promise.resolve(null)),
    enabled: !!active?.id,
    refetchInterval: 1_500,
  });

  const { data: requests } = useQuery({
    queryKey: ['preview-requests', sessionId],
    queryFn: () => getRequests('today'),
    enabled: !!sessionId,
    refetchInterval: 5_000,
  });

  const start = useMutation({
    mutationFn: () => startPreviewSession({ command, cwd: workspacePath || undefined, approved: false }),
    onSuccess: (result: any) => {
      if (result?.status === 'approval_required') {
        qc.invalidateQueries({ queryKey: ['preview-sessions', sessionId] });
        return;
      }
      setCommand('');
      qc.invalidateQueries({ queryKey: ['preview-sessions', sessionId] });
    },
  });

  const stop = useMutation({
    mutationFn: (id: string) => stopPreviewSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['preview-sessions', sessionId] }),
  });

  const approve = useMutation({
    mutationFn: (requestId: string) => approvePreviewRequest(requestId, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['preview-sessions', sessionId] }),
  });
  const reject = useMutation({
    mutationFn: (requestId: string) => approvePreviewRequest(requestId, false),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['preview-sessions', sessionId] }),
  });

  const url = activePreview?.url || active?.url || previewUrl;
  const canEmbed = url ? isLocalPreviewUrl(url) : false;
  const recentRequests = (requests?.completed || []).slice(0, 8);

  return (
    <div className="h-full space-y-3 drawer-section-text">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          Run a local dev server and inspect the browser preview
        </div>
        <Badge variant="secondary" className="text-[10px]">
          <Globe className="size-3" />
          local preview
        </Badge>
      </div>

      {approvals.length > 0 && (
        <PreviewApprovalList approvals={approvals} approve={approve} reject={reject} />
      )}

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (command.trim()) start.mutate();
        }}
      >
        <Input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="npm run dev"
          className="font-mono text-xs"
          disabled={start.isPending}
        />
        <Button type="submit" size="sm" disabled={!command.trim() || start.isPending}>
          {start.isPending ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          Start
        </Button>
      </form>

      <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 min-h-[320px]">
        <div className="space-y-1 overflow-auto rounded-lg border border-border/50 bg-card/40 p-1.5">
          {sessions.length === 0 && !isLoading && (
            <div className="py-6 text-center text-muted-foreground/60">No previews</div>
          )}
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => setSelectedId(session.id)}
              className={cn(
                'w-full rounded-md px-2 py-1.5 text-left transition',
                active?.id === session.id ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
              )}
            >
              <div className="flex items-center gap-1.5">
                <Globe className="size-3 shrink-0" />
                <span className="truncate font-mono text-xs">{session.title || session.id}</span>
              </div>
              <div className={cn(
                'mt-0.5 truncate text-[10px]',
                active?.id === session.id ? 'text-primary-foreground/70' : 'text-muted-foreground/55'
              )}>
                {session.status}
              </div>
            </button>
          ))}
        </div>

        <div className="min-w-0 space-y-3">
          {active ? (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <Badge variant="secondary" className="text-[10px]">{active.id}</Badge>
                    <span>{active.status}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground/70">{active.cwd}</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => stop.mutate(active.id)}
                  disabled={stop.isPending || active.status === 'exited'}
                  aria-label="Stop preview"
                >
                  <Square className="size-3" />
                </Button>
              </div>

              {url && (
                <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background px-2.5 py-2">
                  <Globe className="size-3 text-muted-foreground" />
                  <input
                    value={url}
                    onChange={(event) => setPreviewUrl(event.target.value)}
                    className="min-w-0 flex-1 bg-transparent text-xs font-mono outline-none"
                  />
                </div>
              )}

              {canEmbed ? (
                <div className="h-[180px] overflow-hidden rounded-lg border border-border bg-background">
                  <iframe
                    key={url}
                    src={url}
                    className="h-full w-full border-0"
                    title="Local preview"
                    sandbox="allow-scripts allow-same-origin allow-forms"
                  />
                </div>
              ) : (
                <div className="flex h-[180px] flex-col items-center justify-center rounded-lg border border-border/50 bg-card/40 text-center text-muted-foreground">
                  <Activity className="size-6 text-muted-foreground/40" />
                  <div className="mt-2 text-[11px]">
                    {active.status === 'running' ? 'Waiting for a local preview URL…' : 'Start a preview to see the browser target.'}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center rounded-lg border border-border/50 bg-card/40 text-center text-muted-foreground">
              <Play className="size-6 text-muted-foreground/40" />
              <div className="mt-2 text-[11px]">{isLoading ? 'Loading previews…' : 'Start a local dev server preview.'}</div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Logs</div>
              {activePreview?.logLength ? <span className="font-mono text-[10px] text-muted-foreground">{activePreview.logLength}</span> : null}
            </div>
            <div className="max-h-[120px] overflow-auto rounded-lg bg-black/80 p-3 font-mono text-[10px] leading-relaxed text-green-400/90">
              <pre className="whitespace-pre-wrap break-all">
                {activePreview?.log || active?.status === 'running' ? 'Waiting for preview logs…' : 'No preview logs yet.'}
              </pre>
            </div>
          </div>

          <NetworkList requests={recentRequests} />
        </div>
      </div>
    </div>
  );
}

function PreviewApprovalList({
  approvals,
  approve,
  reject,
}: {
  approvals: PreviewApproval[];
  approve: { mutate: (requestId: string) => void; isPending: boolean };
  reject: { mutate: (requestId: string) => void; isPending: boolean };
}) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400 font-semibold">
        <ShieldAlert className="size-3" />
        {approvals.length} approval{approvals.length > 1 ? 's' : ''} required
      </div>
      {approvals.map((approval) => (
        <div key={approval.requestId} className="flex items-start justify-between gap-2 rounded-md border border-amber-500/20 bg-card/70 p-2">
          <div className="min-w-0">
            <pre className="whitespace-pre-wrap break-all text-[10.5px] font-mono text-foreground/85">
              {approval.command || '(no command)'}
            </pre>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{approval.reason || approval.cwd}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button size="sm" onClick={() => approve.mutate(approval.requestId)} disabled={approve.isPending}>
              <Check className="size-3" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => reject.mutate(approval.requestId)} disabled={reject.isPending}>
              <X className="size-3" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function NetworkList({ requests }: { requests: RequestEntry[] }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Network</div>
        <Activity className="size-3 text-muted-foreground/60" />
      </div>
      {requests.length === 0 && (
        <div className="rounded-lg border border-border/50 bg-card/40 p-3 text-center text-muted-foreground/70">
          No recent requests yet.
        </div>
      )}
      <div className="space-y-1">
        {requests.map((request) => (
          <div key={request.reqId} className="rounded-md border border-border/50 bg-card/40 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[10.5px]">{request.endpoint}</span>
              <span className={cn(
                'font-mono text-[10px]',
                request.status === 'success' || request.status === 'completed' ? 'text-emerald-500' : 'text-rose-400'
              )}>
                {Math.round(request.durationMs)}ms
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground/65 truncate">
              {request.model || request.clientType}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function isLocalPreviewUrl(value: string) {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname);
  } catch {
    return false;
  }
}
