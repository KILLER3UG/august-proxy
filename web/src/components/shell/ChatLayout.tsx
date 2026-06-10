/* ── Chat-first layout (matches the screenshot) ─────────────────────── */
/*                                                                             */
/*  ┌────┬────────────────────────────────────────────────────────────────┐  */
/*  │  + │ ⌘N  New session                            Search... ⌘K        │  */
/*  │  ⌘ │   Skills & Tools                                                │  */
/*  │  ✉ │   Messaging                                                     │  */
/*  │  📦│   Artifacts                                                     │  */
/*  │────│  ┌─────────────────────────┐                                  │  */
/*  │ 🔍│  │ PINNED                   │                                  │  */
/*  │    │  │ SESSIONS 3               │                                  │  */
/*  │ PIN│  │   • session 1            │        <chat area>                │  */
/*  │ SES│  │   • session 2            │                                  │  */
/*  │    │  │   • session 3            │                                  │  */
/*  │────│  └─────────────────────────┘                                  │  */
/*  │ ⌂+│  ⌂ Home   + New   👤 Agents   ⏱ Cron   ⚙ Settings                 │  */
/*  └────┴────────────────────────────────────────────────────────────────┘  */
/*  Gateway ready · Agents · Cron       354.0k/1.0M 35% ━━━━  15:43 MiniMax M3   v2  */

import { useState, useEffect } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, ChevronDown, Volume2, Minus, Square, X, Columns, Home, Plus } from 'lucide-react';
import { SessionList } from '@/components/sidebar/SessionList';
import { WorkspacePanel } from '@/sections/chat/WorkspacePanel';
import { cn } from '@/lib/utils';
import { useStore } from '@nanostores/react';
import { $sessions, createSession, type Session } from '@/store/sessions';

const SESSIONS_COLLAPSED_KEY = 'august-sessions-collapsed';

export function ChatLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(SESSIONS_COLLAPSED_KEY) === '1');
  const [showRightSidebar, setShowRightSidebar] = useState<boolean>(() => localStorage.getItem('august-show-right-sidebar') === '1');
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    localStorage.setItem('august-show-right-sidebar', showRightSidebar ? '1' : '0');
  }, [showRightSidebar]);

  useEffect(() => {
    const handleOpen = () => setShowRightSidebar(true);
    window.addEventListener('august-open-right-sidebar', handleOpen);
    return () => window.removeEventListener('august-open-right-sidebar', handleOpen);
  }, []);

  const sessions = useStore($sessions);
  const active = sessions.find((s) => s.id === sessionId && !s.isArchived) ?? null;

  // Auto redirect from `/` or invalid/archived sessionId to the first non-archived session
  useEffect(() => {
    const activeSessions = sessions.filter(s => !s.isArchived);
    if (location.pathname === '/' || location.pathname === '') {
      let activeSess = activeSessions[0];
      if (!activeSess) {
        activeSess = createSession();
      }
      navigate(`/c/${activeSess.id}`, { replace: true });
    } else if (location.pathname.startsWith('/c/')) {
      const match = sessions.find(s => s.id === sessionId);
      if (!match || match.isArchived) {
        const fallback = activeSessions[0] || createSession();
        navigate(`/c/${fallback.id}`, { replace: true });
      }
    }
  }, [location.pathname, sessionId, sessions, navigate]);

  const handleNewSession = () => {
    const newSess = createSession();
    navigate(`/c/${newSess.id}`);
  };

  useEffect(() => {
    localStorage.setItem(SESSIONS_COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  // Tick the session timer once a second (cosmetic for mock)
  useEffect(() => {
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Don't show sidebar in settings overlay (the overlay has its own sidebar)
  const isSettings = location.pathname.startsWith('/settings');

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <div className="flex-1 flex min-h-0">
        {!isSettings && (
          <aside
            className={cn(
              'shrink-0 bg-sidebar text-sidebar-foreground flex flex-col transition-[width] duration-150',
              collapsed ? 'w-12' : 'w-64',
            )}
          >
            <div className="flex-1 overflow-hidden">
              <SessionList
                activeId={active?.id}
                collapsed={collapsed}
                onToggleCollapsed={() => setCollapsed((c) => !c)}
                onSelect={(s) => navigate(`/c/${s.id}`)}
                onNew={handleNewSession}
                onNavigate={(p) => {
                  if (p.startsWith('settings') || p.startsWith('/settings')) {
                    sessionStorage.setItem('pre-settings-path', location.pathname);
                  }
                  navigate(p.startsWith('/') ? p : `/${p}`);
                }}
              />
            </div>
          </aside>
        )}

        <div className="flex-1 flex flex-col min-w-0">
          <Titlebar
            session={active}
            onSettings={() => {
              sessionStorage.setItem('pre-settings-path', location.pathname);
              navigate('/settings');
            }}
            onToggleRightSidebar={() => setShowRightSidebar(s => !s)}
          />
          <div className="flex-1 flex min-h-0 overflow-hidden">
            <main className="flex-1 min-h-0 overflow-hidden">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={location.pathname}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{    opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  className="h-full"
                >
                  <Outlet />
                </motion.div>
              </AnimatePresence>
            </main>
            {showRightSidebar && !isSettings && (
              <aside className="w-80 border-l border-border/40 bg-[#0e0e11] shrink-0 overflow-y-auto flex flex-col">
                <WorkspacePanel sessionId={active?.id || null} />
              </aside>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Titlebar({ session, onSettings, onToggleRightSidebar }: {
  session: Session | null;
  onSettings: () => void;
  onToggleRightSidebar: () => void;
}) {
  return (
    <header className="h-12 bg-background flex items-center justify-between px-4 shrink-0 select-none">
      <div className="flex items-center gap-2 min-w-0">
        <h1 className="text-[13px] font-medium text-foreground truncate">
          {session?.title ?? 'General Assistance Conversation Started'}
        </h1>
        <ChevronDown className="size-3.5 text-muted-foreground/60 cursor-pointer hover:text-foreground transition" />
      </div>

      <div className="flex items-center gap-3">
        <button className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition" title="Mute/Unmute">
          <Volume2 className="size-4" />
        </button>
        <button 
          onClick={onToggleRightSidebar}
          className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition" 
          title="Toggle Workspace Explorer"
        >
          <Columns className="size-4" />
        </button>

        <div className="h-4 w-[1px] bg-border/40" />

        <div className="flex items-center gap-1.5 ml-1">
          <button className="size-6 flex items-center justify-center hover:bg-accent rounded text-muted-foreground hover:text-foreground transition" aria-label="Minimize">
            <Minus className="size-3.5" />
          </button>
          <button className="size-6 flex items-center justify-center hover:bg-accent rounded text-muted-foreground hover:text-foreground transition" aria-label="Maximize">
            <Square className="size-2.5" />
          </button>
          <button className="size-6 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground rounded text-muted-foreground transition" aria-label="Close">
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}

function Statusbar({ session, elapsed, collapsed, onNew, onNavigate }: {
  session: Session | null;
  elapsed: number;
  collapsed: boolean;
  onNew: () => void;
  onNavigate: (path: string) => void;
}) {
  // Mock usage numbers (would come from a real /usage endpoint in production)
  const tokens = 354_000 + elapsed * 12;
  const limit  = 1_000_000;
  const pct    = Math.min(100, Math.round((tokens / limit) * 100));
  const mins = Math.floor(elapsed / 60);

  return (
    <footer className="h-7 border-t border-border/40 bg-[#09090b] flex items-center justify-between px-0 text-[10.5px] text-muted-foreground font-mono shrink-0 select-none">
      <div className="flex items-center h-full">
        <div className="w-12 shrink-0 flex items-center justify-center gap-2">
          <button onClick={() => onNavigate('/')} className="hover:text-foreground transition" title="Home">
            <Home className="size-3.5" />
          </button>
          <button onClick={onNew} className="hover:text-foreground transition" title="New Session">
            <Plus className="size-3.5" />
          </button>
        </div>
        
        <div className="h-4 w-[1px] bg-border/40" />

        <div className="flex items-center gap-3 pl-3">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50" />
            Gateway ready
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span onClick={() => onNavigate('/settings?tab=health')} className="hover:text-foreground cursor-pointer transition">Agents</span>
          <span className="text-muted-foreground/40">·</span>
          <span onClick={() => onNavigate('/thinking')} className="hover:text-foreground cursor-pointer transition">Cron</span>
        </div>
      </div>

      <div className="flex items-center gap-3 pr-3">
        <span className="tabular-nums">{(tokens / 1000).toFixed(1)}k/{(limit / 1_000_000).toFixed(1)}M</span>
        <span className="flex items-center gap-1.5">
          <span className="tabular-nums w-7 text-right">{pct}%</span>
          <span className="relative w-24 h-1 rounded-full bg-muted overflow-hidden">
            <span
              className={cn('absolute inset-y-0 left-0 rounded-full', pct > 80 ? 'bg-destructive' : pct > 60 ? 'bg-amber-500' : 'bg-foreground')}
              style={{ width: `${pct}%` }}
            />
          </span>
        </span>
        <span className="text-muted-foreground/40">·</span>
        <span className="tabular-nums">Session {String(Math.floor(mins / 60)).padStart(2, '0')}:{String(mins % 60).padStart(2, '0')}</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="text-foreground">{session?.model ?? 'Minimax M3 Free - Max'}</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="font-mono text-[9px] text-muted-foreground/60 px-1 py-0.5 rounded bg-muted/40 border border-border/30">
          # v0.15.1 (+24) 66a6b9c
        </span>
      </div>
    </footer>
  );
}
