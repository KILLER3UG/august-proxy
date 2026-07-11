/* ── Chat-first layout ────────────────────────────────────────────── */
/*                                                                          */
/* The right-side Workbench sidebar is rendered as a layout sidebar with    */
/* Preview, Diff, Terminal, Tasks, and Plan sections.                       */

import { useState, useEffect, useRef } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "@nanostores/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { $sessions, createSession, updateSessionWorkbenchMetadata, reconcileSessionsFromBackend } from "@/store/sessions";
import { $currentWorkspaceId, $workspaces } from "@/store/workspaces";
import { ChatTitlebar } from "./ChatTitlebar";
import { SessionSidebar } from "./SessionSidebar";
import { RightDrawer } from "./RightDrawer";
import { addRightDrawerSection, closeRightDrawer, setActiveRightDrawerSection, useRightDrawer } from "./RightDrawerState";
import { approveWorkbenchPlan, getWorkbenchSession, rejectWorkbenchPlan, setWorkbenchGuardMode, streamWorkbenchRevision } from "@/api/workbench";
import { toast } from "sonner";
import type { WorkbenchSession } from "@/types/workbench";
import type { RightDrawerSectionId } from "./RightDrawerState";
import { dispatchFocusComposer, dispatchInsertComposerText, onUiAction } from "@/api/ui-events";

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
  const currentWorkspaceId = useStore($currentWorkspaceId);
  const workspaces = useStore($workspaces);
  const active =
    sessions.find((s) => s.id === sessionId && !s.isArchived) ?? null;

  // Get current workspace path for auto-assigning to new sessions
  const currentWorkspacePath = currentWorkspaceId
    ? workspaces.find(w => w.id === currentWorkspaceId)?.path ?? null
    : null;

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

  // Reconcile the sidebar session list with the backend brain database so
  // sessions deleted by the model (via delete_session / delete_folder tools)
  // are automatically removed from the frontend. Polls every 30 s while the
  // layout is mounted.
  useEffect(() => {
    void reconcileSessionsFromBackend();
    const t = setInterval(() => { void reconcileSessionsFromBackend(); }, 30_000);
    return () => clearInterval(t);
  }, []);

  // Listen for the "open right sidebar" event dispatched by the PlanProposalBanner
  // (and any other in-chat call-to-action) so the drawer opens without the
  // caller needing access to the layout's setter.
  useEffect(() => {
    const handler = () => setShowRightSidebar(true);
    window.addEventListener('august:open-right-sidebar', handler);
    return () => window.removeEventListener('august:open-right-sidebar', handler);
  }, []);

  // Task 5: listen for august:ui-action events from the LLM/tool layer.
  // API/state actions only — no DOM clicks/fills (locked decision 3).
  const workbenchSessionId = active?.workbenchSessionId;
  useEffect(() => {
    const handler = (e: { action: string; target: string; payload?: Record<string, unknown> }) => {
      switch (e.action) {
        case 'navigate':
          void navigate(e.target);
          break;
        case 'open_drawer': {
          const section = (e.payload?.section || 'preview') as RightDrawerSectionId;
          addRightDrawerSection(section);
          setShowRightSidebar(true);
          break;
        }
        case 'close_drawer':
          closeRightDrawer();
          setShowRightSidebar(false);
          break;
        case 'set_drawer_section': {
          const section = e.target as RightDrawerSectionId;
          if (['preview', 'diff', 'terminal', 'tasks', 'plan'].includes(section)) {
            addRightDrawerSection(section);
            setActiveRightDrawerSection(section);
            setShowRightSidebar(true);
          }
          break;
        }
        case 'set_guard_mode':
          if (workbenchSessionId) {
            const mode = e.target as 'plan' | 'ask' | 'full';
            setWorkbenchGuardMode(workbenchSessionId, mode)
              .catch(err => toast.error(`Failed to update guard mode: ${err?.message || err}`));
          }
          break;
        case 'refresh':
          void queryClient.invalidateQueries();
          break;
        case 'focus_composer':
          dispatchFocusComposer();
          break;
        case 'insert_composer_text':
          dispatchInsertComposerText(e.target || '');
          break;
      }
    };
    const unsubscribe = onUiAction(handler);
    return unsubscribe;
  }, [navigate, queryClient, workbenchSessionId]);

  // Fetch the active workbench session to feed the right sidebar. The chat
  // thread also fetches this independently, so this is the layout-level mirror.
  const workbench = useQuery({
    queryKey: ['workbench-session', active?.workbenchSessionId],
    queryFn: async () => {
      if (!active?.workbenchSessionId) return null;
      try {
        return await getWorkbenchSession(active.workbenchSessionId);
      } catch {
        // The backend Workbench session is gone — e.g. the backend was
        // restarted and its in-memory store was wiped, leaving a stale id in
        // localStorage. Drop the dead id so we stop polling it; the chat
        // thread recreates a fresh Workbench session on the next message.
        if (active?.id) {
          updateSessionWorkbenchMetadata(active.id, { workbenchSessionId: undefined });
        }
        return null;
      }
    },
    enabled: !!active?.workbenchSessionId,
    refetchInterval: 2_000,
    retry: false,
  });
  const workbenchSession: WorkbenchSession | null = workbench.data || null;

  // Auto-open the Tasks section when todos first appear.
  const hasTodosRef = useRef(false);
  useEffect(() => {
    const hasTodos = (workbenchSession?.todos?.length ?? 0) > 0;
    if (hasTodos && !hasTodosRef.current) {
      hasTodosRef.current = true;
      addRightDrawerSection('tasks');
      setShowRightSidebar(true);
    } else if (!hasTodos) {
      hasTodosRef.current = false;
    }
  }, [workbenchSession?.todos?.length]);

  // Auto redirect from `/` or invalid/archived sessionId to the first non-archived session
  useEffect(() => {
    const activeSessions = sessions.filter((s) => !s.isArchived);
    if (location.pathname === "/" || location.pathname === "") {
      let activeSess = activeSessions[0];
      if (!activeSess) {
        activeSess = createSession(null, 'New Chat', currentWorkspacePath);
      }
      void navigate(`/c/${activeSess.id}`, { replace: true });
    } else if (location.pathname.startsWith("/c/")) {
      const match = sessions.find((s) => s.id === sessionId);
      if (!match || match.isArchived) {
        const fallback = activeSessions[0] || createSession(null, 'New Chat', currentWorkspacePath);
        void navigate(`/c/${fallback.id}`, { replace: true });
      }
    }
  }, [location.pathname, sessionId, sessions, navigate, currentWorkspacePath]);

  const handleNewSession = (folderId?: string | null) => {
    const newSess = createSession(folderId ?? null, 'New Chat', currentWorkspacePath);
    void navigate(`/c/${newSess.id}`);
  };

  const approvePlan = async () => {
    if (!active?.workbenchSessionId) return;
    try {
      const updated = await approveWorkbenchPlan(active.workbenchSessionId);
      queryClient.setQueryData(['workbench-session', active.workbenchSessionId], updated);
      toast.success('Workbench plan approved');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Could not approve Workbench plan', { description: message });
    }
  };

  const rejectPlan = async () => {
    if (!active?.workbenchSessionId) return;
    try {
      const updated = await rejectWorkbenchPlan(active.workbenchSessionId);
      queryClient.setQueryData(['workbench-session', active.workbenchSessionId], updated);
      toast.success('Workbench plan rejected');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Could not reject Workbench plan', { description: message });
    }
  };

  const revisePlan = async (feedback: string) => {
    if (!active?.workbenchSessionId) return;
    try {
      await streamWorkbenchRevision(active.workbenchSessionId, feedback, {
        onError: (data) => toast.error('Could not send plan revision', { description: data.message }),
        onSession: () => { void queryClient.invalidateQueries({ queryKey: ['workbench-session', active.workbenchSessionId] }); },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error('Could not send plan revision', { description: message });
    }
  };

  const closeWorkbenchSidebar = () => {
    closeRightDrawer();
    setShowRightSidebar(false);
  };

  useEffect(() => {
    localStorage.setItem(SESSIONS_COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // Settings is a FULL-SCREEN page (not a modal). When the path is
  // /settings/*, render the SettingsPage full-width with the chat
  // thread + right drawer hidden. The session sidebar stays visible.
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
              void navigate(path.startsWith("/") ? path : `/${path}`);
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
              void navigate("/settings");
            }}
            onSelectRightDrawerSection={openWorkbenchSidebar}
          />
          <div className="flex-1 min-h-0 overflow-hidden relative flex">
            {/* Settings takes the full width (its own internal layout). */}
            {isSettings ? (
              <div className="flex-1 min-w-0 h-full">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={location.pathname}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    className="h-full min-w-0"
                  >
                    <Outlet />
                  </motion.div>
                </AnimatePresence>
              </div>
            ) : (
              <>
                {/* Full-width chat column — scroll container spans the full
                    chat-area width so the thumb sits at the chat-area edge.
                    Internal content max-width is applied inside ChatThread
                    for message readability. */}
                <div className="flex-1 flex min-w-0 h-full">
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

                {!isSettings && active && (
                  <RightDrawer
                    open={showRightSidebar}
                    sessionId={active.id}
                    workspacePath={active.workspacePath || null}
                    workbenchSession={workbenchSession}
                    onApprovePlan={approvePlan}
                    onRejectPlan={rejectPlan}
                    onRevisePlan={revisePlan}
                    onClose={closeWorkbenchSidebar}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
