/* ── Chat-first layout ────────────────────────────────────────────── */
/*                                                                          */
/* The right-side Workbench sidebar is rendered as a layout sidebar with    */
/* Preview, Diff, Terminal, Tasks, and Plan sections.                       */

import { useState, useEffect } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "@nanostores/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { $sessions, createSession, type Session } from "@/store/sessions";
import { ChatTitlebar } from "./ChatTitlebar";
import { SessionSidebar } from "./SessionSidebar";
import { RightDrawer } from "./RightDrawer";
import { addRightDrawerSection, closeRightDrawer, useRightDrawer } from "./RightDrawerState";
import { approveWorkbenchPlan, getWorkbenchSession } from "@/api/workbench";
import { toast } from "sonner";
import type { WorkbenchSession } from "@/types/workbench";
import type { RightDrawerSectionId } from "./RightDrawerState";

const SESSIONS_COLLAPSED_KEY = "august-sessions-collapsed";
const WORKBENCH_SIDEBAR_OPEN_KEY = "august-workbench-sidebar-open";

export function ChatLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(SESSIONS_COLLAPSED_KEY) === "1",
  );
  const [showRightSidebar, setShowRightSidebar] = useState<boolean>(
    () => localStorage.getItem(WORKBENCH_SIDEBAR_OPEN_KEY) === "1",
  );
  const sessions = useStore($sessions);
  const rightDrawer = useRightDrawer();
  const queryClient = useQueryClient();
  const active =
    sessions.find((s) => s.id === sessionId && !s.isArchived) ?? null;

  useEffect(() => {
    localStorage.setItem(
      WORKBENCH_SIDEBAR_OPEN_KEY,
      showRightSidebar ? "1" : "0",
    );
  }, [showRightSidebar]);

  useEffect(() => {
    if (rightDrawer.open && !showRightSidebar) {
      setShowRightSidebar(true);
    }
  }, [rightDrawer.open, showRightSidebar]);

  const openWorkbenchSidebar = (section: RightDrawerSectionId) => {
    addRightDrawerSection(section);
    setShowRightSidebar(true);
  };

  useEffect(() => {
    localStorage.removeItem("august-show-right-sidebar");
  }, []);

  // Fetch the active workbench session to feed the right sidebar. The chat
  // thread also fetches this independently, so this is the layout-level mirror.
  const workbench = useQuery({
    queryKey: ['workbench-session', active?.workbenchSessionId],
    queryFn: () =>
      active?.workbenchSessionId
        ? getWorkbenchSession(active.workbenchSessionId)
        : Promise.resolve(null),
    enabled: !!active?.workbenchSessionId,
    refetchInterval: 2_000,
  });
  const workbenchSession: WorkbenchSession | null = workbench.data || null;

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

  const approvePlan = async () => {
    if (!active?.workbenchSessionId) return;
    try {
      const updated = await approveWorkbenchPlan(active.workbenchSessionId);
      queryClient.setQueryData(['workbench-session', active.workbenchSessionId], updated);
      toast.success('Workbench plan approved');
    } catch (e: any) {
      toast.error('Could not approve Workbench plan', { description: e.message });
    }
  };

  const closeWorkbenchSidebar = () => {
    closeRightDrawer();
    setShowRightSidebar(false);
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
            onToggleCollapsed={() => setCollapsed((c) => !c)}
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
            rightDrawerOpen={showRightSidebar}
            onToggleSidebar={() => setCollapsed((c) => !c)}
            onSettings={() => {
              sessionStorage.setItem("pre-settings-path", location.pathname);
              navigate("/settings");
            }}
            onSelectRightDrawerSection={openWorkbenchSidebar}
          />
          <div className="flex-1 min-h-0 overflow-hidden relative flex">
            {/* Center the chat within the remaining width after any open sidebar(s). */}
            <div className="flex-1 flex min-w-0 justify-center">
              <div className="flex h-full w-full max-w-3xl flex-col min-w-0 px-2">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={location.pathname}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    className="h-full min-w-0 flex-1"
                  >
                    <Outlet />
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            {!isSettings && active && (
              <RightDrawer
                open={showRightSidebar}
                sessionId={active.id}
                workspacePath={active.workspacePath || null}
                workbenchSession={workbenchSession}
                onApprovePlan={approvePlan}
                onClose={closeWorkbenchSidebar}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
