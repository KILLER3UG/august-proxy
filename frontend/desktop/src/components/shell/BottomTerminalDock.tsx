/* ── BottomTerminalDock ─ JetBrains-style terminal strip at the bottom ─
   Spans the main column (chat + right panel) with session tabs, a resize
   handle, and the same real PTY sessions as the old drawer section. */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
  Inbox,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import {
  approveTerminalRequest,
  createTerminalSession,
  getTerminalSessions,
  openExternalTerminal,
  resizeTerminalSession,
  type TerminalApproval,
} from '@/api/api-client';
import { useSessionsStore } from '@/store/sessions';
import { useParams } from 'react-router-dom';

const MIN_DOCK_H = 120;
const DEFAULT_DOCK_H = 280;
const DOCK_H_KEY = 'august-bottom-terminal-h';

function loadDockH(): number {
  if (typeof window === 'undefined') return DEFAULT_DOCK_H;
  const raw = window.localStorage.getItem(DOCK_H_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? Math.max(MIN_DOCK_H, parsed) : DEFAULT_DOCK_H;
}

export function BottomTerminalDock({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const workspacePath = useSessionsStore((s) => {
    const id = routeSessionId;
    const sess = s.sessions.find((x) => x.id === id || x.workbenchSessionId === id);
    return sess?.workspacePath || null;
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [socketReady, setSocketReady] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [dockH, setDockH] = useState<number>(() => loadDockH());
  const [isDragging, setIsDragging] = useState(false);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const connectedRef = useRef(false);
  const autoSpawnRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(DOCK_H_KEY, String(dockH));
  }, [dockH]);

  // Vertical resize: drag the top edge.
  useEffect(() => {
    if (!isDragging) return;
    const stop = () => setIsDragging(false);
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, [isDragging]);

  const startResize = (clientY: number) => {
    const startY = clientY;
    const startH = dockH;
    setIsDragging(true);
    const onMove = (ev: MouseEvent) => {
      // Dragging up grows the dock.
      const next = startH + (startY - ev.clientY);
      setDockH(Math.min(Math.max(MIN_DOCK_H, next), Math.floor(window.innerHeight * 0.7)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

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
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['terminal-sessions'] }); },
  });
  const resizeRef = useRef(resize);
  resizeRef.current = resize;

  const createSession = useMutation({
    mutationFn: () =>
      createTerminalSession({
        cwd: workspacePath || undefined,
        title: 'Shell',
        approvedInteractive: true,
      }),
    onSuccess: (session) => {
      setSelectedId(session.id);
      setSpawnError(session.error || null);
      if (session.error || session.status === 'error') {
        toast.error(session.error || 'Terminal failed to start');
      }
      void qc.invalidateQueries({ queryKey: ['terminal-sessions'] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setSpawnError(msg);
      toast.error(msg);
    },
  });

  const openExternal = useMutation({
    mutationFn: () => openExternalTerminal(workspacePath || undefined),
  });

  // Auto-spawn one shell when the dock first opens empty.
  useEffect(() => {
    if (autoSpawnRef.current || isLoading || sessions.length > 0) return;
    autoSpawnRef.current = true;
    createSession.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, sessions.length]);

  // Approvals wiring (kept minimal — same behavior as the drawer section).
  const approve = {
    mutate: (requestId: string) => {
      void approveTerminalRequest(requestId).then(() =>
        qc.invalidateQueries({ queryKey: ['terminal-sessions'] }),
      );
    },
    isPending: false,
  };
  const reject = {
    mutate: (requestId: string) => {
      void approveTerminalRequest(requestId, false).then(() =>
        qc.invalidateQueries({ queryKey: ['terminal-sessions'] }),
      );
    },
    isPending: false,
  };

  // xterm lifecycle — identical protocol to the previous drawer section.
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    const terminal = new XTerm({
      cursorBlink: true,
      fontSize: 12,
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      theme: {
        background: '#181818',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const syncSize = () => {
      try {
        fit.fit();
        const s = terminal;
        if (activeId) {
          resizeRef.current.mutate({
            sessionId: activeId,
            cols: s.cols,
            rows: s.rows,
          });
        }
      } catch { /* container may be hidden */ }
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(containerRef.current);
    window.addEventListener('resize', syncSize);

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const connectSocket = () => {
      if (!activeId || disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(
        `${proto}://${window.location.host}/api/terminal/${encodeURIComponent(activeId)}/ws`,
      );
      socketRef.current = sock;
      sock.onopen = () => {
        connectedRef.current = true;
        setSocketReady(true);
        reconnectAttemptRef.current = 0;
        try {
          fit.fit();
          resizeRef.current.mutate({
            sessionId: activeId,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        } catch { /* ignore */ }
      };
      sock.onmessage = (msg) => {
        try {
          const payload = JSON.parse(String(msg.data));
          if (payload.type === 'data' && typeof payload.data === 'string') {
            terminal.write(payload.data);
          } else if (payload.type === 'exit') {
            connectedRef.current = false;
            setSocketReady(false);
            terminal.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n');
          }
        } catch {
          terminal.write(String(msg.data));
        }
      };
      sock.onclose = () => {
        connectedRef.current = false;
        setSocketReady(false);
        if (disposed) return;
        reconnectAttemptRef.current += 1;
        const delay = Math.min(8000, 500 * 2 ** Math.min(4, reconnectAttemptRef.current));
        retryTimer = setTimeout(connectSocket, delay);
      };
      sock.addEventListener('error', () => {
        connectedRef.current = false;
        setSocketReady(false);
      });
    };

    const onData = (data: string) => {
      const sock = socketRef.current;
      if (sock && sock.readyState === WebSocket.OPEN) sock.send(data);
    };
    const onDataDisposable = terminal.onData(onData);

    void connectSocket();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (retryTimer) clearTimeout(retryTimer);
      onDataDisposable.dispose();
      ro.disconnect();
      window.removeEventListener('resize', syncSize);
      const sock = socketRef.current;
      if (sock && sock.readyState <= WebSocket.OPEN) sock.close();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      socketRef.current = null;
      connectedRef.current = false;
      setSocketReady(false);
    };
     
  }, [activeId]);

  useEffect(() => {
    if (active?.error && !spawnError) setSpawnError(active.error);
  }, [active?.error, spawnError]);

  const inErrorState =
    !!spawnError || active?.status === 'error' || active?.status === 'exited';

  const showConnectingOverlay =
    !socketReady &&
    !connectedRef.current &&
    !inErrorState &&
    (isLoading || createSession.isPending || !!active);

  return (
    <div
      className="relative flex shrink-0 flex-col border-t border-border bg-[#181818]"
      style={{ height: dockH }}
      data-testid="bottom-terminal-dock"
    >
      {/* Resize handle — drag to grow/shrink. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        onMouseDown={(e) => {
          e.preventDefault();
          startResize(e.clientY);
        }}
        className={cn(
          'absolute -top-px left-0 right-0 z-20 h-1.5 cursor-row-resize touch-none transition-colors hover:bg-primary/40',
          isDragging ? 'bg-primary/50' : 'bg-transparent',
        )}
      />

      {/* Header: label + tabs left, actions right (reference layout). */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Terminal
          </span>
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => setSelectedId(session.id)}
              data-testid={`bottom-terminal-tab-${session.id}`}
              className={cn(
                'group flex max-w-[10rem] shrink-0 items-center gap-1 border-b-2 px-1 py-1 text-xs transition',
                session.id === activeId
                  ? 'border-primary/70 text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="truncate">{session.title || 'Shell'}</span>
              <X
                className="size-2.5 opacity-40 group-hover:opacity-90"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId((cur) => (cur === session.id ? null : cur));
                }}
              />
            </button>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" onClick={() => openExternal.mutate()} title="Open external OS terminal" aria-label="Open external OS terminal">
            <ExternalLink className="size-3" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => terminalRef.current?.clear()} disabled={!active} title="Clear" aria-label="Clear terminal">
            <Trash2 className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => createSession.mutate()}
            disabled={createSession.isPending}
            title="New shell tab"
            aria-label="New embedded shell"
            data-testid="bottom-terminal-new"
          >
            {createSession.isPending ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} title="Close terminal" aria-label="Close terminal">
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        {inErrorState && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#181818]/95 p-6 text-center">
            <AlertCircle className="size-8 text-destructive" />
            <div className="max-w-xs">
              <p className="text-sm font-medium text-foreground">Shell failed to start</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                {spawnError || active?.error || 'The shell process exited unexpectedly.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => { setSpawnError(null); createSession.mutate(); }} disabled={createSession.isPending}>
                {createSession.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                Retry Shell
              </Button>
              <Button variant="outline" size="sm" onClick={() => openExternal.mutate()} disabled={openExternal.isPending}>
                <ExternalLink className="size-3" />
                Open System Terminal
              </Button>
            </div>
          </div>
        )}

        {approvals.length > 0 && (
          <div className="absolute left-2 right-2 top-2 z-10">
            <ApprovalList approvals={approvals} approve={approve} reject={reject} />
          </div>
        )}

        <div ref={containerRef} className="absolute inset-0 overflow-hidden" />

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
    <div className="rounded-md border border-warning/30 bg-warning/5 p-2 shadow-lg space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-warning">
        <ShieldAlert className="size-3" />
        {approvals.length} approval{approvals.length > 1 ? 's' : ''} required
      </div>
      {approvals.map((approval) => (
        <div key={approval.requestId} className="flex items-start justify-between gap-2 rounded-md border border-warning/20 bg-card/70 p-1.5">
          <div className="min-w-0">
            <pre className="whitespace-pre-wrap break-all font-mono text-[10.5px] text-foreground/85">
              {approval.command || approval.inputPreview || '(no command)'}
            </pre>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{approval.reason || approval.cwd}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
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
