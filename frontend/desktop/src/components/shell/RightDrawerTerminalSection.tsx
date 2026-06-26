/* ── RightDrawerTerminalSection ─ real xterm.js PTY panel ────────── */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Plus, ShieldAlert, X, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  const autoSpawnRef = useRef(false);

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

  // Auto-spawn a real terminal session if there are none yet.
  useEffect(() => {
    if (
      !autoSpawnRef.current &&
      !isLoading &&
      sessions.length === 0 &&
      !activeId &&
      !createSession.isPending
    ) {
      autoSpawnRef.current = true;
      createSession.mutate();
    }
  }, [isLoading, sessions.length, activeId, createSession]);

  useEffect(() => {
    if (!activeId) {
      socketRef.current?.close();
      socketRef.current = null;
      connectedRef.current = false;
      setSocketReady(false);
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      return;
    }

    const terminal = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
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
      // Defer initial fit until after layout settles.
      requestAnimationFrame(() => fit.fit());
    }

    const syncSize = () => {
      const bounds = containerRef.current?.getBoundingClientRect();
      const terminalInstance = terminalRef.current;
      const fitAddon = fitRef.current;
      if (!bounds || !terminalInstance || !fitAddon) return;
      fitAddon.fit();
      const cols = Math.max(20, Math.floor(bounds.width / 7.5));
      const rows = Math.max(5, Math.floor(bounds.height / 16));
      terminalInstance.resize(cols, rows);
      resize.mutate({ sessionId: activeId, cols, rows });
    };

    const observer = new ResizeObserver(syncSize);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener('resize', syncSize);

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/api/terminal/connect?id=${encodeURIComponent(activeId)}`);
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
  }, [activeId, resize]);

  const showConnectingOverlay =
    !socketReady && !connectedRef.current && (isLoading || createSession.isPending || !!active);

  return (
    <div className="relative h-full min-h-0 w-full">
      {/* Floating toolbar in the top-right corner; doesn't eat terminal width. */}
      <div className="absolute right-1 top-1 z-10 flex items-center gap-1 rounded-md bg-black/40 px-1 py-0.5 backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => terminalRef.current?.clear()}
          disabled={!active}
          aria-label="Clear terminal"
          title="Clear"
        >
          <Check className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => createSession.mutate()}
          disabled={createSession.isPending}
          aria-label="New terminal session"
          title="New"
        >
          {createSession.isPending ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
        </Button>
        {active && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => close.mutate(active.id)}
            disabled={close.isPending}
            aria-label="Close terminal session"
            title="Close"
          >
            <X className="size-3" />
          </Button>
        )}
      </div>

      {approvals.length > 0 && (
        <div className="absolute left-1 right-12 top-9 z-10">
          <ApprovalList approvals={approvals} approve={approve} reject={reject} />
        </div>
      )}

      {/* The xterm pane fills the entire section. */}
      <div
        ref={containerRef}
        className={cn(
          'absolute inset-0 overflow-hidden rounded-lg border border-black/20 bg-[#020617]',
          !socketReady && !connectedRef.current && 'opacity-95'
        )}
      />

      {showConnectingOverlay && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">
          {isLoading || createSession.isPending ? 'Starting real terminal…' : 'Connecting to shell…'}
        </div>
      )}

      {!active && !isLoading && !createSession.isPending && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center text-muted-foreground">
          <Inbox className="size-6 text-muted-foreground/40" />
          <div className="mt-2 text-[11px]">Click + to start a terminal session.</div>
        </div>
      )}
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
    <div className="rounded-md border border-warning/30 bg-warning/5 p-2 space-y-1.5 shadow">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-warning font-semibold">
        <ShieldAlert className="size-3" />
        {approvals.length} approval{approvals.length > 1 ? 's' : ''} required
      </div>
      {approvals.map((approval) => (
        <div key={approval.requestId} className="flex items-start justify-between gap-2 rounded-md border border-warning/20 bg-card/70 p-1.5">
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
