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
import { Settings, ChevronDown, Volume2, Minus, Square, X, PanelLeft, PanelLeftClose, PanelRight, PanelRightClose } from 'lucide-react';
import { SessionList } from '@/components/sidebar/SessionList';
import { WorkspacePanel } from '@/sections/chat/WorkspacePanel';
import { Statusbar } from './Statusbar';
import { useStore } from '@nanostores/react';
import { $sessions, createSession, type Session } from '@/store/sessions';

const SESSIONS_COLLAPSED_KEY = 'august-sessions-collapsed';

export function ChatLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(SESSIONS_COLLAPSED_KEY) === '1');
  const [showRightSidebar, setShowRightSidebar] = useState<boolean>(() => localStorage.getItem('august-show-right-sidebar') === '1');

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

  const handleNewSession = (folderId?: string | null) => {
    const newSess = createSession(folderId ?? null);
    navigate(`/c/${newSess.id}`);
  };

  useEffect(() => {
    localStorage.setItem(SESSIONS_COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  // Don't show sidebar in settings overlay (the overlay has its own sidebar)
  const isSettings = location.pathname.startsWith('/settings');

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <div className="flex-1 flex min-h-0">
        {!isSettings && (
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.aside
                key="sidebar"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 256, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className="shrink-0 bg-sidebar text-sidebar-foreground flex flex-col overflow-hidden"
              >
                <div className="w-64 flex-1 overflow-hidden">
                  <SessionList
                    activeId={active?.id}
                    collapsed={collapsed}
                    onToggleCollapsed={() => setCollapsed((c) => !c)}
                    onSelect={(s) => navigate(`/c/${s.id}`)}
                    onNew={() => handleNewSession()}
                    onNewInFolder={(folderId) => handleNewSession(folderId)}
                    onNavigate={(p) => {
                      if (p.startsWith('settings') || p.startsWith('/settings')) {
                        sessionStorage.setItem('pre-settings-path', location.pathname);
                      }
                      navigate(p.startsWith('/') ? p : `/${p}`);
                    }}
                  />
                </div>
              </motion.aside>
            )}
          </AnimatePresence>
        )}

        <div className="flex-1 flex flex-col min-w-0">
          <Titlebar
            session={active}
            sidebarCollapsed={collapsed}
            onToggleSidebar={() => setCollapsed(c => !c)}
            showRightSidebar={showRightSidebar}
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
            <AnimatePresence initial={false}>
              {showRightSidebar && !isSettings && (
                <motion.aside
                  key="right-sidebar"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 320, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="shrink-0 bg-[#0e0e11] overflow-hidden flex flex-col"
                >
                  <div className="w-80 shrink-0 overflow-y-auto flex flex-col h-full">
                    <WorkspacePanel sessionId={active?.id || null} />
                  </div>
                </motion.aside>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
      <Statusbar />
    </div>
  );
}

function Titlebar({ session, sidebarCollapsed, onToggleSidebar, showRightSidebar, onSettings, onToggleRightSidebar }: {
  session: Session | null;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  showRightSidebar: boolean;
  onSettings: () => void;
  onToggleRightSidebar: () => void;
}) {
  return (
    <header className="h-12 bg-background flex items-center justify-between shrink-0 select-none">
      <div className="flex items-center min-w-0">
        <button
          onClick={onToggleSidebar}
          className="size-12 flex items-center justify-center shrink-0 hover:bg-accent text-muted-foreground hover:text-foreground transition"
          title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        >
          {sidebarCollapsed ? <PanelLeftClose className="size-4" /> : <PanelLeft className="size-4" />}
        </button>
        <div className="flex items-center gap-2 px-2 min-w-0">
          <h1 className="text-[13px] font-medium text-foreground truncate">
            {session?.title ?? 'General Assistance Conversation Started'}
          </h1>
          <ChevronDown className="size-3.5 text-muted-foreground/60 cursor-pointer hover:text-foreground transition" />
        </div>
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
          {showRightSidebar ? <PanelRightClose className="size-4" /> : <PanelRight className="size-4" />}
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
