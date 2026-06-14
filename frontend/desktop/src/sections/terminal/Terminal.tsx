import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TerminalSquare, Plus, ShieldAlert, Check, X, Loader2, Inbox } from 'lucide-react';
import {
  getTerminalSessions,
  submitTerminalCommand,
  approveTerminalRequest,
  type TerminalSession,
  type TerminalApproval,
} from '@/api/backend-ui';
import { api } from '@/api/client';

/**
 * Approval-aware terminal. Per the migration plan, this ships after Workbench
 * chat is stable. Dangerous commands require explicit approval before they
 * run; the backend returns `approval_required` instead of executing, and the
 * pending request appears in the approvals list.
 */
export function Terminal() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [command, setCommand] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['terminal-sessions'],
    queryFn: () => getTerminalSessions(),
    refetchInterval: 3_000,
  });

  const sessions = data?.sessions ?? [];
  const approvals = data?.approvals ?? [];
  const activeId = selectedId ?? sessions[0]?.id ?? null;
  const active = sessions.find((s) => s.id === activeId) ?? null;

  const { data: buffer } = useQuery({
    queryKey: ['terminal-buffer', activeId],
    queryFn: () => (activeId ? api.get<{ buffer: string } & TerminalSession>(`/ui/terminal/buffer?id=${activeId}`) : Promise.resolve(null)),
    enabled: !!activeId,
    refetchInterval: 2_000,
  });

  const run = useMutation({
    mutationFn: () => submitTerminalCommand(activeId || '', command),
    onSuccess: (res: any) => {
      setCommand('');
      qc.invalidateQueries({ queryKey: ['terminal-sessions'] });
      if (res?.status === 'approval_required') {
        // Approval will surface in the approvals list.
      }
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
  const createSession = useMutation({
    mutationFn: () => api.post('/ui/terminal/sessions', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['terminal-sessions'] }),
  });

  return (
    <div className="p-6 space-y-4 flex flex-col h-full">
      <SectionHeader
        title="Terminal"
        subtitle="Approval-aware command runner. Dangerous commands require explicit approval."
        actions={
          <Button size="sm" variant="outline" onClick={() => createSession.mutate()} disabled={createSession.isPending}>
            <Plus className="size-3" /> New session
          </Button>
        }
      />

      {/* Pending approvals */}
      {approvals.length > 0 && (
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardContent className="p-3 space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 font-semibold flex items-center gap-1">
              <ShieldAlert className="size-3" /> {approvals.length} approval{approvals.length > 1 ? 's' : ''} required
            </p>
            {approvals.map((a) => (
              <div key={a.requestId} className="flex items-start justify-between gap-3 rounded-md bg-card/70 border border-amber-500/30 px-3 py-2">
                <div className="min-w-0">
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all">{a.command || a.inputPreview || '(no command)'}</pre>
                  <p className="text-[10px] text-muted-foreground mt-1">{a.reason || a.cwd}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" onClick={() => approve.mutate(a.requestId)} disabled={approve.isPending}>
                    <Check className="size-3" /> Approve
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => reject.mutate(a.requestId)} disabled={reject.isPending}>
                    <X className="size-3" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex-1 flex gap-3 min-h-0">
        {/* Session list */}
        <div className="w-52 shrink-0 border-r border-border pr-3 overflow-auto">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-mono">Sessions</p>
          {sessions.length === 0 && !isLoading && (
            <p className="text-xs text-muted-foreground py-4">No sessions</p>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`w-full text-left rounded-md px-2 py-1.5 text-xs transition mb-0.5 ${
                activeId === s.id ? 'bg-accent' : 'hover:bg-accent/50'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <TerminalSquare className="size-3 shrink-0 text-muted-foreground" />
                <span className="font-mono truncate">{s.title || s.id}</span>
              </div>
              {s.cwd && <p className="text-[10px] text-muted-foreground/60 font-mono truncate mt-0.5">{s.cwd}</p>}
            </button>
          ))}
        </div>

        {/* Active session */}
        <div className="flex-1 flex flex-col min-w-0">
          {active ? (
            <>
              <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground font-mono">
                <Badge variant="secondary" className="text-[9px]">{active.id}</Badge>
                <span className="truncate">{active.cwd}</span>
              </div>
              <div className="flex-1 rounded-md bg-black/80 dark:bg-black/60 border border-border overflow-auto p-3 min-h-[180px]">
                <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-green-400/90">
                  {buffer?.buffer || '(empty buffer — run a command)'}
                </pre>
              </div>
              <form
                className="mt-2 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (command.trim()) run.mutate();
                }}
              >
                <span className="text-xs font-mono text-muted-foreground">$</span>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="Type a command…"
                  className="font-mono text-sm"
                  disabled={run.isPending}
                />
                <Button type="submit" size="sm" disabled={!command.trim() || run.isPending}>
                  {run.isPending ? <Loader2 className="size-3 animate-spin" /> : 'Run'}
                </Button>
              </form>
            </>
          ) : (
            <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
              {isLoading ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <div className="text-center">
                  <Inbox className="size-8 text-muted-foreground/40 mx-auto mb-2" />
                  Create a session to start running commands.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
