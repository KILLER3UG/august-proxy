/* ── RightDrawerTerminalSection ─ compact terminal panel ──────────── */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Plus, ShieldAlert, TerminalSquare, X, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  approveTerminalRequest,
  createTerminalSession,
  deleteTerminalSession,
  getTerminalBuffer,
  getTerminalSessions,
  submitTerminalCommand,
  type TerminalApproval,
  type TerminalSession,
} from '@/api/backend-ui';

export function RightDrawerTerminalSection() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [command, setCommand] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['terminal-sessions'],
    queryFn: getTerminalSessions,
    refetchInterval: 3_000,
  });

  const sessions = data?.sessions ?? [];
  const approvals = data?.approvals ?? [];
  const activeId = selectedId ?? sessions[0]?.id ?? null;
  const active = sessions.find((session) => session.id === activeId) ?? null;

  const { data: buffer } = useQuery({
    queryKey: ['terminal-buffer', activeId],
    queryFn: () => (activeId ? getTerminalBuffer(activeId) : Promise.resolve(null)),
    enabled: !!activeId,
    refetchInterval: 2_000,
  });

  const run = useMutation({
    mutationFn: () => submitTerminalCommand(activeId || '', command),
    onSuccess: () => {
      setCommand('');
      qc.invalidateQueries({ queryKey: ['terminal-sessions'] });
      if (activeId) qc.invalidateQueries({ queryKey: ['terminal-buffer', activeId] });
    },
  });

  const createSession = useMutation({
    mutationFn: () => createTerminalSession(),
    onSuccess: (session) => {
      setSelectedId(session.id);
      qc.invalidateQueries({ queryKey: ['terminal-sessions'] });
    },
  });

  const approve = useMutation({
    mutationFn: (requestId: string) => approveTerminalRequest(requestId, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['terminal-sessions'] }),
  });
  const reject = useMutation({
    mutationFn: (requestId: string) => approveTerminalRequest(requestId, false),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['terminal-sessions'] }),
  });
  const close = useMutation({
    mutationFn: deleteTerminalSession,
    onSuccess: () => {
      if (selectedId) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ['terminal-sessions'] });
    },
  });

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          Approval-aware command runner
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => createSession.mutate()}
          disabled={createSession.isPending}
        >
          <Plus className="size-3" />
          New
        </Button>
      </div>

      {approvals.length > 0 && (
        <ApprovalList approvals={approvals} approve={approve} reject={reject} />
      )}

      <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 min-h-[260px]">
        <div className="space-y-1 overflow-auto rounded-lg border border-border/50 bg-card/40 p-1.5">
          {sessions.length === 0 && !isLoading && (
            <div className="py-6 text-center text-muted-foreground/60">No sessions</div>
          )}
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => setSelectedId(session.id)}
              className={cn(
                'w-full rounded-md px-2 py-1.5 text-left transition',
                activeId === session.id ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
              )}
            >
              <div className="flex items-center gap-1.5">
                <TerminalSquare className="size-3 shrink-0" />
                <span className="truncate font-mono text-[10.5px]">{session.title || session.id}</span>
              </div>
              {session.cwd && (
                <div className={cn(
                  'mt-0.5 truncate font-mono text-[9px]',
                  activeId === session.id ? 'text-primary-foreground/70' : 'text-muted-foreground/55'
                )}>
                  {session.cwd}
                </div>
              )}
            </button>
          ))}
        </div>

        <div className="min-w-0 space-y-2">
          {active ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                    <Badge variant="secondary" className="text-[9px]">{active.id}</Badge>
                    <span className="truncate">{active.status}</span>
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground/70">{active.cwd}</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => close.mutate(active.id)}
                  disabled={close.isPending}
                  aria-label="Close terminal session"
                >
                  <X className="size-3" />
                </Button>
              </div>

              <div className="h-[180px] overflow-auto rounded-lg bg-black/80 p-3 font-mono text-[10.5px] leading-relaxed text-green-400/90">
                <pre className="whitespace-pre-wrap break-all">
                  {buffer?.buffer || '(empty buffer — run a command)'}
                </pre>
              </div>

              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (command.trim() && activeId) run.mutate();
                }}
              >
                <span className="font-mono text-muted-foreground">$</span>
                <Input
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="Type a command…"
                  className="font-mono text-xs"
                  disabled={run.isPending || !activeId}
                />
                <Button type="submit" size="sm" disabled={!command.trim() || !activeId || run.isPending}>
                  {run.isPending ? <Loader2 className="size-3 animate-spin" /> : 'Run'}
                </Button>
              </form>
            </>
          ) : (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center rounded-lg border border-border/50 bg-card/40 text-center text-muted-foreground">
              <Inbox className="size-6 text-muted-foreground/40" />
              <div className="mt-2 text-[11px]">{isLoading ? 'Loading terminal…' : 'Create or select a terminal session.'}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ApprovalList({
  approvals,
  approve,
  reject,
}: {
  approvals: TerminalApproval[];
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
              {approval.command || approval.inputPreview || '(no command)'}
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
