/* ── RightDrawerTerminalSection ─ xterm.js PTY panel ───────────── */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Plus, ShieldAlert, TerminalSquare, X, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import {
  approveTerminalRequest,
  createTerminalSession,
  deleteTerminalSession,
  getTerminalSessions,
  resizeTerminalSession,
  type TerminalApproval,
  type TerminalSession,
} from '@/api/backend-ui';

export function RightDrawerTerminalSection() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [socketReady, setSocketReady] = useState(false);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const connectedRef = useRef(false);

  const { data, isLoading } = useQuery({
    queryKey: ['terminal-sessions'],
    queryFn: getTerminalSessions,
    refetchInterval: 3_000,
  });

  const sessions = data?.sessions ?? [];
  const approvals = data?.approvals ?? [];
  const activeId = selectedId ?? sessions[0]?.id ?? null;
  const active = sessions.find((session) => session.id === activeId) ?? null;

  const resize = useMutation({
    mutationFn: ({ sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) =>
      resizeTerminalSession(sessionId, cols, rows),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['terminal-sessions'] }),
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

  const disposeTerminal = () => {
    socketRef.current?.close();
    socketRef.current = null;
    connectedRef.current = false;
    setSocketReady(false);
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitRef.current = null;
  };

  useEffect(() => {
    if (!activeId) {
      disposeTerminal();
      return;
    }

    const terminal = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      theme: {
        background: '#020617',
        foreground: '#e5e7eb',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const container = containerRef.current;
    if (container) {
      terminal.open(container);
      fit.fit();
    }

    const syncSize = () => {
      const bounds = containerRef.current?.getBoundingClientRect();
      const terminalInstance = terminalRef.current;
      const fitAddon = fitRef.current;
      if (!bounds || !terminalInstance || !fitAddon) return;
      const cols = Math.max(20, Math.floor(bounds.width / 7.5));
      const rows = Math.max(5, Math.floor(bounds.height / 16));
      fitAddon.fit();
      terminalInstance.resize(cols, rows);
      resize.mutate({ sessionId: activeId, cols, rows });
    };

    const observer = new ResizeObserver(syncSize);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener('resize', syncSize);

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/ui/terminal/connect?id=${encodeURIComponent(activeId)}`);
    socketRef.current = socket;

    const onData = (data: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    };
    const onDataDisposable = terminal.onData(onData);

    socket.addEventListener('open', () => {
      connectedRef.current = true;
      setSocketReady(true);
      syncSize();
      terminal.focus();
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        terminal.write(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
      } else if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => terminal.write(new Uint8Array(buffer)));
      }
    });
    socket.addEventListener('close', () => {
      connectedRef.current = false;
      setSocketReady(false);
    });
    socket.addEventListener('error', () => {
      connectedRef.current = false;
      setSocketReady(false);
    });

    return () => {
      onDataDisposable.dispose();
      observer.disconnect();
      window.removeEventListener('resize', syncSize);
      if (socket.readyState <= WebSocket.OPEN) socket.close();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      socketRef.current = null;
      connectedRef.current = false;
      setSocketReady(false);
    };
  }, [activeId]);

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          xterm.js PTY terminal
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
                    {active.pty && <Badge variant="outline" className="text-[9px]">pty</Badge>}
                    {socketReady && <Badge variant="outline" className="text-[9px]">connected</Badge>}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground/70">{active.cwd}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => terminalRef.current?.clear()}
                    aria-label="Clear terminal"
                    title="Clear terminal"
                  >
                    <Check className="size-3" />
                  </Button>
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
              </div>

              <div
                ref={containerRef}
                className={cn(
                  'h-[220px] overflow-hidden rounded-lg border border-black/20 bg-[#020617]',
                  !socketReady && !connectedRef.current && 'opacity-80'
                )}
              />
              {!socketReady && !connectedRef.current && (
                <div className="text-[10px] text-muted-foreground">
                  {isLoading ? 'Loading terminal…' : 'Connecting to PTY shell…'}
                </div>
              )}
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
