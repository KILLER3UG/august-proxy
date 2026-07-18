/* ── Chat-first layout ────────────────────────────────────────────── */
/*                                                                          */
/* The right-side Workbench sidebar is rendered as a layout sidebar with    */
/* Preview, Diff, Terminal, Tasks, and Plan sections.                       */

import { useState, useEffect, useRef } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSessionsStore, createSession, getOrCreateEmptySession, createEmptySessionInFolder, defaultSessionTitle, updateSessionWorkbenchMetadata, reconcileSessionsFromBackend, healDuplicateSessions, toggleFolderCollapse, ensureFolderForWorkspacePath } from "@/store/sessions";
import { startRealtimeBridge } from "@/realtime/bridge";
import { addWorkspace, useWorkspacesStore } from "@/store/workspaces";
import { ChatTitlebar } from "./ChatTitlebar";
import { TeamAgentsStrip } from "./TeamAgentsStrip";
import { SessionSidebar } from "./SessionSidebar";
import { RightDrawer } from "./RightDrawer";
import { addRightDrawerSection, closeRightDrawer, closeRightDrawerSection, setActiveRightDrawerSection, useRightDrawer } from "./RightDrawerState";
import { approveWorkbenchPlan, getWorkbenchSession, rejectWorkbenchPlan, setWorkbenchGuardMode, streamWorkbenchRevision } from "@/api/workbench";
import { isNonEmptyPlan, normalizeWorkbenchSession } from "@/lib/workbench-plan";
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
  // Never restore an empty open drawer from localStorage — sections are not
  // persisted, so a stale "open" flag left the Workbench shell blank.
  const [showRightSidebar, setShowRightSidebar] = useState(false);
  const sessions = useSessionsStore((s) => s.sessions);
  const rightDrawer = useRightDrawer();
  const queryClient = useQueryClient();
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const active =
    sessions.find((s) => s.id === sessionId && !s.isArchived) ?? null;

  // Get current workspace path for auto-assigning to new sessions
  const currentWorkspacePath = currentWorkspaceId
    ? workspaces.find(w => w.id === currentWorkspaceId)?.path ?? null
    : null;

  useEffect(() => {
    const shouldPersist =
      showRightSidebar && rightDrawer.open && rightDrawer.sections.length > 0;
    localStorage.setItem(WORKBENCH_SIDEBAR_OPEN_KEY, shouldPersist ? "1" : "0");
  }, [showRightSidebar, rightDrawer.open, rightDrawer.sections.length]);

  // Keep layout flag in sync with drawer store (both open and close).
  useEffect(() => {
    if (rightDrawer.open && rightDrawer.sections.length > 0) {
      if (!showRightSidebar) setShowRightSidebar(true);
    } else if (showRightSidebar) {
      setShowRightSidebar(false);
    }
  }, [rightDrawer.open, rightDrawer.sections.length, showRightSidebar]);

  const openWorkbenchSidebar = (section: RightDrawerSectionId) => {
    addRightDrawerSection(section);
    setShowRightSidebar(true);
  };

  useEffect(() => {
    localStorage.removeItem("august-show-right-sidebar");
  }, []);

  // Ensure global realtime bridge is up (idempotent). Reconcile is only a
  // safety net — live creates/deletes/status arrive via /api/realtime/stream.
  useEffect(() => {
    // Collapse any sess_* + wb_* duplicate pairs left by older builds / races.
    healDuplicateSessions();
    startRealtimeBridge();
    void reconcileSessionsFromBackend();
    const t = setInterval(() => { void reconcileSessionsFromBackend(); }, 60_000);
    return () => clearInterval(t);
  }, []);

  // Navigate away when the open chat was deleted via realtime.
  useEffect(() => {
    if (!sessionId) return;
    const open = sessions.some(
      (s) => !s.isArchived && (s.id === sessionId || s.workbenchSessionId === sessionId),
    );
    if (open) return;
    const next = sessions.find((s) => !s.isArchived);
    if (next) void navigate(`/c/${next.id}`, { replace: true });
  }, [sessions, sessionId, navigate]);

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
          if (['preview', 'diff', 'terminal', 'tasks', 'plan', 'browser'].includes(section)) {
            addRightDrawerSection(section);
            setActiveRightDrawerSection(section);
            setShowRightSidebar(true);
          }
          break;
        }
        case 'set_guard_mode':
          // ChatThread also handles this for local mode state; here we ensure backend is updated
          // when a workbench id is already known at the layout layer.
          if (workbenchSessionId) {
            const mode = e.target as 'plan' | 'ask' | 'full';
            setWorkbenchGuardMode(workbenchSessionId, mode).catch((err: unknown) =>
              toast.error(
                `Failed to update mode: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
          break;
        // undo / compact / branch: handled in ChatThread (needs message state)
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
  const workbenchSession: WorkbenchSession | null =
    normalizeWorkbenchSession(workbench.data) || null;

  // Auto-open Tasks when todos appear; close the section when they clear.
  const hasTodosRef = useRef(false);
  useEffect(() => {
    const hasTodos = (workbenchSession?.todos?.length ?? 0) > 0;
    if (hasTodos && !hasTodosRef.current) {
      hasTodosRef.current = true;
      addRightDrawerSection('tasks');
    } else if (!hasTodos) {
      if (hasTodosRef.current) {
        closeRightDrawerSection('tasks');
      }
      hasTodosRef.current = false;
    }
  }, [workbenchSession?.todos?.length]);

  // Auto-open Plan when a plan is presented (Cursor-style); close when gone.
  const hasPlanRef = useRef(false);
  useEffect(() => {
    const hasPlan = isNonEmptyPlan(workbenchSession?.plan);
    if (hasPlan && !hasPlanRef.current) {
      hasPlanRef.current = true;
      addRightDrawerSection('plan');
    } else if (!hasPlan) {
      if (hasPlanRef.current) {
        closeRightDrawerSection('plan');
      }
      hasPlanRef.current = false;
    }
  }, [workbenchSession?.plan]);

  const createSessionInCurrentWorkspace = () => {
    const path = currentWorkspacePath || null;
    if (path) {
      const { folder } = ensureFolderForWorkspacePath(path);
      return createSession(folder.id, defaultSessionTitle(), path);
    }
    return createSession(null, defaultSessionTitle(), null);
  };

  // Auto redirect from `/` or invalid/archived sessionId to the first non-archived session
  useEffect(() => {
    const activeSessions = sessions.filter((s) => !s.isArchived);
    if (location.pathname === "/" || location.pathname === "") {
      let activeSess = activeSessions[0];
      if (!activeSess) {
        activeSess = createSessionInCurrentWorkspace();
      }
      void navigate(`/c/${activeSess.id}`, { replace: true });
    } else if (location.pathname.startsWith("/c/")) {
      // Match by UI id OR legacy workbench id (older builds rewrote session.id).
      const match = sessions.find(
        (s) => s.id === sessionId || s.workbenchSessionId === sessionId,
      );
      if (match && !match.isArchived) {
        // URL still has a legacy workbench id — normalize to stable UI id.
        if (match.id !== sessionId) {
          void navigate(`/c/${match.id}`, { replace: true });
        }
        return;
      }
      if (!match || match.isArchived) {
        const fallback = activeSessions[0] || createSessionInCurrentWorkspace();
        void navigate(`/c/${fallback.id}`, { replace: true });
      }
    }
  }, [location.pathname, sessionId, sessions, navigate, currentWorkspacePath]);

  const handleNewSession = (folderId?: string | null) => {
    // Dirty confirm: streaming or unsent composer draft.
    try {
      const sid = active?.id;
      if (sid) {
        const draftKey = `august_composer_draft_${sid}`;
        const draft = (localStorage.getItem(draftKey) || '').trim();
        const status =
          useSessionsStore.getState().sessionStates[sid] ||
          useSessionsStore.getState().sessionStates[active?.workbenchSessionId || ''];
        const streaming =
          status === 'streaming' || status === 'working' || status === 'awaiting';
        if (streaming || draft) {
          const msg = streaming
            ? 'August is still working. Start a new chat anyway? The current run continues in the background until you stop it.'
            : 'You have an unsent draft. Discard it and start a new chat?';
          if (!window.confirm(msg)) return;
        }
      }
    } catch {
      /* ignore */
    }

    const folders = useSessionsStore.getState().folders;

    // Codex-style: "+" on a project folder → new thread in that folder/workspace.
    if (folderId) {
      const folder = folders.find((f) => f.id === folderId);
      const newSess = createEmptySessionInFolder(folderId, defaultSessionTitle());
      if (folder?.workspacePath) {
        addWorkspace(folder.workspacePath);
      }
      if (folder?.isCollapsed) {
        toggleFolderCollapse(folderId);
      }
      void navigate(`/c/${newSess.id}`);
      return;
    }

    // Top-level "New chat": stay in the active project folder when possible.
    // Resolve by folderId first, then by workspace path so chats do not land
    // in "Other chats" while Repositories folders keep growing.
    const activeFolderId = active?.folderId ?? null;
    const activeFolder = activeFolderId
      ? folders.find((f) => f.id === activeFolderId)
      : null;
    const targetPath =
      activeFolder?.workspacePath ??
      active?.workspacePath ??
      currentWorkspacePath ??
      null;

    let targetFolderId: string | null =
      activeFolder?.workspacePath ? activeFolderId : null;
    if (!targetFolderId && targetPath) {
      targetFolderId = ensureFolderForWorkspacePath(targetPath).folder.id;
    }

    const newSess = getOrCreateEmptySession(
      targetFolderId,
      defaultSessionTitle(),
      targetPath,
    );
    if (targetPath) {
      addWorkspace(targetPath);
    }
    void navigate(`/c/${newSess.id}`);
  };

  // /new slash command + voice "new chat" land here.
  useEffect(() => {
    const onNew = () => handleNewSession();
    window.addEventListener('august:new-session', onNew);
    return () => window.removeEventListener('august:new-session', onNew);
  }, [currentWorkspacePath]);

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
    <div className="h-full min-h-0 flex flex-col overflow-hidden bg-background text-foreground">
      <div className="flex-1 flex min-h-0 overflow-hidden">
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
            onSelectRightDrawerSection={openWorkbenchSidebar}
          />
          {!isSettings && (
            <TeamAgentsStrip workbenchSessionId={active?.workbenchSessionId} />
          )}
          <div className="flex-1 min-h-0 overflow-hidden relative flex">
            {/* Settings takes the full width (its own internal layout).
                Do NOT key Outlet on location.pathname here — that remounted
                the entire SettingsPage (shell + content) on every tab switch
                and felt like a full page reload. Tab transitions live inside
                SettingsPage content only. */}
            {isSettings ? (
              <div className="flex-1 min-w-0 h-full">
                <Outlet />
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
