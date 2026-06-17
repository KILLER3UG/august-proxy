/* ── Chat-first layout (matches the screenshot) ─────────────────────── */
/*                                                                             */
/*  ┌────┬────────────────────────────────────────────────────────────────┐  */
/*  │  + │ ⌘N  New session                            Search... ⌘K        │  */
/*  │  ⌘ │   Skills & Tools                                                │  */
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

import { useState, useEffect } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "@nanostores/react";
import { $sessions, createSession, type Session } from "@/store/sessions";
import { ChatTitlebar } from "./ChatTitlebar";
import { SessionSidebar } from "./SessionSidebar";
import { GitPanel } from "./GitPanel";

const SESSIONS_COLLAPSED_KEY = "august-sessions-collapsed";

export function ChatLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(SESSIONS_COLLAPSED_KEY) === "1",
  );
  const [showRightSidebar, setShowRightSidebar] = useState<boolean>(
    () => localStorage.getItem("august-show-right-sidebar") === "1",
  );

  useEffect(() => {
    localStorage.setItem(
      "august-show-right-sidebar",
      showRightSidebar ? "1" : "0",
    );
  }, [showRightSidebar]);

  useEffect(() => {
    const handleOpen = () => setShowRightSidebar(true);
    window.addEventListener("august-open-right-sidebar", handleOpen);
    return () =>
      window.removeEventListener("august-open-right-sidebar", handleOpen);
  }, []);

  const sessions = useStore($sessions);
  const active =
    sessions.find((s) => s.id === sessionId && !s.isArchived) ?? null;


  // Auto redirect from `/` or invalid/archived sessionId to the first non-archived session
  useEffect(() => {
    const activeSessions = sessions.filter((s) => !s.isArchived);
    if (location.pathname === "/" || location.pathname === "") {
      let activeSess = activeSessions[0];
      if (!activeSess) {
        activeSess = createSession();
      }
      navigate(`/c/${activeSess.id}`, { replace: true });
    } else if (location.pathname.startsWith("/c/")) {
      const match = sessions.find((s) => s.id === sessionId);
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
    localStorage.setItem(SESSIONS_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // Don't show sidebar in settings overlay (the overlay has its own sidebar)
  const isSettings = location.pathname.startsWith("/settings");

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <div className="flex-1 flex min-h-0">
        {!isSettings && (
          <SessionSidebar
            activeId={active?.id}
            collapsed={collapsed}
            showRightSidebar={showRightSidebar}
            onToggleCollapsed={() => setCollapsed((c) => !c)}
            onToggleRightSidebar={() => setShowRightSidebar((s) => !s)}
            onNew={() => handleNewSession()}
            onNewInFolder={(folderId) => handleNewSession(folderId)}
            onNavigate={(path) => {
              if (path.startsWith("settings") || path.startsWith("/settings")) {
                sessionStorage.setItem("pre-settings-path", location.pathname);
              }
              navigate(path.startsWith("/") ? path : `/${path}`);
            }}
          />
        )}

        <div className="flex-1 flex flex-col min-w-0">
          <ChatTitlebar
            session={active}
            sidebarCollapsed={collapsed}
            onToggleSidebar={() => setCollapsed((c) => !c)}
            showRightSidebar={showRightSidebar}
            onSettings={() => {
              sessionStorage.setItem("pre-settings-path", location.pathname);
              navigate("/settings");
            }}
            onToggleRightSidebar={() => setShowRightSidebar((s) => !s)}
          />
          <div className="flex-1 flex min-h-0 overflow-hidden">
            <main className="flex-1 min-h-0 overflow-hidden">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={location.pathname}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  className="h-full"
                >
                  <Outlet />
                </motion.div>
              </AnimatePresence>
            </main>
            <AnimatePresence initial={false}>
              {showRightSidebar && (
                <motion.aside
                  key="right-rail"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 288, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  className="border-l border-white/[0.06] bg-card/30 overflow-hidden shrink-0"
                >
                  <div className="w-72 h-full overflow-y-auto">
                    <GitPanel sessionId={active?.id} className="border-0 rounded-none" />
                  </div>
                </motion.aside>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
