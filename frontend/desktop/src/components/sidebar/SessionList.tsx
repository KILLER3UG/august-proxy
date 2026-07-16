/* ── Session list — Claude-like recents-first sidebar ──────────────── */
/* Top:   New chat + quieter Continue / Skills / Artifacts                 */
/* Middle: search, PINNED, RECENTS                                         */
/* Bottom: Settings                                                        */

import { useState, useEffect, useRef } from "react";
import { AnimatePresence, LayoutGroup } from "framer-motion";
import { Settings } from "lucide-react";
import { isTauri } from "@/lib/tauri-detect";
import {
  useSessionsStore,
  renameSession,
  deleteSession,
  archiveSession,
  moveSessionToFolder,
  createFolder,
  renameFolder,
  deleteFolder,
  toggleFolderCollapse,
  findOrCreateSessionForPath,
  type Session,
  type SessionStatus,
} from "@/store/sessions";
import { useWorkspacesStore } from "@/store/workspaces";
import { useActiveChatStreamsStore, startChatActiveStreamsPoller } from "@/store/chat-active-streams";
import { toast } from "sonner";
import { api } from "@/api/client";
import { SessionListNav } from "./SessionListNav";
import { SessionRow } from "./SessionRow";
import { Section, FolderHeader, UncategorizedHeader } from "./FolderTree";
import {
  UserDropdown,
  type UserDropdownAction,
  type UserStatus,
} from "@/components/ui/user-dropdown";

const SESSIONS_KEY = "august-pinned-sessions";
const STORAGE = (() => {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]") as string[];
  } catch {
    return [];
  }
})();

interface Props {
  activeId?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (s: Session) => void;
  onNew: () => void;
  onNewInFolder?: (folderId: string) => void;
  onNavigate: (path: string) => void;
}

export function SessionList({
  activeId,
  collapsed: _collapsed,
  onToggleCollapsed: _onToggleCollapsed,
  onSelect,
  onNew,
  onNewInFolder,
  onNavigate,
}: Props) {
  const [filter, setFilter] = useState("");
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set(STORAGE));
  const [userStatus, setUserStatus] = useState<UserStatus>("online");
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const rootRef = useRef<HTMLDivElement>(null);
  const [uncategorizedCollapsed, setUncategorizedCollapsed] = useState(
    () => localStorage.getItem("august-uncategorized-collapsed") === "1",
  );

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const sync = () => setSidebarWidth(Math.round(el.getBoundingClientRect().width));
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const openSettingsSection = (section?: string) => {
    sessionStorage.setItem("pre-settings-path", window.location.pathname);
    onNavigate(section ? `/settings/${section}` : "/settings");
  };

  const handleUserAction = (action: UserDropdownAction) => {
    switch (action) {
      case "settings":
        openSettingsSection();
        break;
      case "appearance":
      case "profile":
      case "notifications":
        openSettingsSection("profile-preferences");
        break;
      case "download":
        toast.message("You're already in the August desktop app.");
        break;
      case "whats-new":
      case "help":
      case "upgrade":
      case "referrals":
      case "switch":
      case "logout":
        toast.message("Coming soon");
        break;
      default:
        break;
    }
  };

  const sessions = useSessionsStore((s) => s.sessions);
  const folders = useSessionsStore((s) => s.folders);
  const sessionStates = useSessionsStore((s) => s.sessionStates);
  const activeChatSessions = useActiveChatStreamsStore((s) => s.active);
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  useEffect(() => {
    startChatActiveStreamsPoller();
  }, []);

  /** Confirm + delete with exit animation (store remove drives AnimatePresence). */
  const confirmDeleteSession = (s: Session) => {
    if (
      !confirm("Are you sure you want to permanently delete this chat?")
    ) {
      return;
    }
    // Drop pin entry so localStorage does not accumulate dead ids
    if (pinnedIds.has(s.id)) {
      const next = new Set(pinnedIds);
      next.delete(s.id);
      setPinnedIds(next);
      localStorage.setItem(SESSIONS_KEY, JSON.stringify([...next]));
    }
    deleteSession(s.id);
    if (activeId === s.id || activeId === s.workbenchSessionId) {
      const fallback = useSessionsStore
        .getState()
        .sessions.find((x) => x.id !== s.id && !x.isArchived);
      if (fallback) onSelect(fallback);
    }
  };

  // Merge the local per-session status with the live poller output so a
  // session that has a backend generation in progress shows the pulse
  // dot even when the user is on a different session. The local status
  // takes precedence when both are present.
  const mergedSessionStates: Record<string, SessionStatus> = (() => {
    const next: Record<string, SessionStatus> = { ...sessionStates };
    for (const [id, status] of Object.entries(activeChatSessions)) {
      if (!next[id]) next[id] = status;
    }
    return next;
  })();

  // Hidden file input for native folder picker (browser fallback)
  const dirInputRef = useRef<HTMLInputElement>(null);

  const handleFolderUploadClick = async (
    e: React.MouseEvent<HTMLButtonElement>,
  ) => {
    e.stopPropagation();

    let selectedPath: string | null = null;

    if (isTauri) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        selectedPath = await invoke<string | null>("select_directory");
      } catch (err) {
        console.error("Failed to open Tauri directory dialog:", err);
      }
    } else {
      dirInputRef.current?.click();
      return;
    }

    if (!selectedPath) return;
    selectedPath = selectedPath.trim();
    if (!selectedPath) return;

    // Normalize Windows backslashes
    const normalizedPath = selectedPath.replace(/\\/g, "/");
    const folderName = normalizedPath.split("/").pop() || "workspace";

    const toastId = toast.loading(`Connecting to workspace: ${folderName}...`);

    try {
      await api.get<{ files: Array<{ name: string; path: string; isDir: boolean }> }>(
        `/api/workspace/files?path=${encodeURIComponent(normalizedPath)}`,
      );

      // Find or auto‑create a session for this folder
      const { session, created } = findOrCreateSessionForPath(normalizedPath, folderName);
      if (created) {
        toast.success(`New session created for folder: ${folderName}`, { id: toastId });
      } else {
        toast.success(`Switched to session for folder: ${folderName}`, { id: toastId });
      }
      onNavigate(`/c/${session.id}`);
      window.dispatchEvent(new CustomEvent("august-open-right-sidebar"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Access failed: ${message}`, { id: toastId });
    }
  };

  const handleDirPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fullPath = file.path
      || file.webkitRelativePath.slice(0, file.webkitRelativePath.indexOf('/'));
    if (!fullPath) return;
    const normalizedPath = fullPath.replace(/\\/g, "/");
    const folderName = normalizedPath.split("/").pop() || "workspace";
    const toastId = toast.loading(`Connecting to workspace: ${folderName}...`);
    void (async () => {
      try {
        await api.get<{ files: Array<{ name: string; path: string; isDir: boolean }> }>(
          `/api/workspace/files?path=${encodeURIComponent(normalizedPath)}`,
        );
        // Find or auto‑create a session for this folder
        const { session, created } = findOrCreateSessionForPath(normalizedPath, folderName);
        if (created) {
          toast.success(`New session created for folder: ${folderName}`, { id: toastId });
        } else {
          toast.success(`Switched to session for folder: ${folderName}`, { id: toastId });
        }
        onNavigate(`/c/${session.id}`);
        window.dispatchEvent(new CustomEvent('august-open-right-sidebar'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Access failed: ${message}`, { id: toastId });
      }
    })();
    e.target.value = '';
  };

  const visible = sessions.filter(
    (s) =>
      !s.isArchived &&
      (!filter || s.title.toLowerCase().includes(filter.toLowerCase())),
  );

  // Get current workspace path for filtering
  const currentWorkspacePath = currentWorkspaceId
    ? workspaces.find(w => w.id === currentWorkspaceId)?.path ?? null
    : null;

  // Filter sessions by workspace if one is selected
  const workspaceFiltered = currentWorkspacePath
    ? visible.filter((s) => !s.workspacePath || s.workspacePath === currentWorkspacePath)
    : visible;
  const pinned = workspaceFiltered.filter((s) => pinnedIds.has(s.id));
  const others = workspaceFiltered.filter((s) => !pinnedIds.has(s.id));

  const togglePin = (id: string) => {
    const next = new Set(pinnedIds);
    void (next.has(id) ? next.delete(id) : next.add(id));
    setPinnedIds(next);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([...next]));
  };

  const handleCreateFolder = () => {
    const name = prompt("Enter folder name:");
    if (name && name.trim()) {
      createFolder(name.trim());
    }
  };

  const handleRenameFolder = (id: string, currentName: string) => {
    const name = prompt("Rename folder:", currentName);
    if (name && name.trim() && name.trim() !== currentName) {
      renameFolder(id, name.trim());
    }
  };

  const handleDeleteFolder = (id: string) => {
    if (
      confirm(
        "Are you sure you want to delete this folder? All sessions inside will be moved to uncategorized.",
      )
    ) {
      deleteFolder(id);
    }
  };

  const toggleUncategorizedCollapse = () => {
    const next = !uncategorizedCollapsed;
    setUncategorizedCollapsed(next);
    localStorage.setItem("august-uncategorized-collapsed", next ? "1" : "0");
  };

  const sessionRowHandlers = (s: Session) => ({
    onClick: () => onSelect(s),
    onTogglePin: () => togglePin(s.id),
    onRename: (newTitle: string) => renameSession(s.id, newTitle),
    onArchive: () => {
      archiveSession(s.id);
      if (activeId === s.id) {
        const fallback = sessions.find(
          (x) => x.id !== s.id && !x.isArchived,
        );
        if (fallback) onSelect(fallback);
      }
    },
    onMoveToFolder: (fId: string | null) => moveSessionToFolder(s.id, fId),
    onDelete: () => confirmDeleteSession(s),
  });

  return (
    <div ref={rootRef} className="flex h-full text-sm relative select-none bg-sidebar">
      <input
        ref={dirInputRef}
        type="file"
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={handleDirPicked}
      />
      <div className="flex-1 flex flex-col min-w-0 text-sm">
        <SessionListNav
          filter={filter}
          onFilterChange={setFilter}
          lastSession={workspaceFiltered[0]}
          onNew={onNew}
          onSelectLast={() => onSelect(workspaceFiltered[0])}
          onNavigate={onNavigate}
        />

        {/* Scrollable sessions area — Recents-first */}
        <div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-2.5">
          <Section
            title="Pinned"
            count={pinned.length}
            empty="Shift-click a chat to pin"
          >
            <LayoutGroup id="pinned-sessions">
              <AnimatePresence initial={false} mode="popLayout">
                {pinned.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={activeId === s.id}
                    pinned
                    status={mergedSessionStates[s.id]}
                    folders={folders}
                    {...sessionRowHandlers(s)}
                  />
                ))}
              </AnimatePresence>
            </LayoutGroup>
          </Section>

          <Section
            title="Recents"
            count={others.length}
            onNewFolder={handleCreateFolder}
            onUploadFolder={(e) => { void handleFolderUploadClick(e); }}
          >
            <div className="space-y-1.5">
              {/* Collapsible folders and their sessions */}
              {folders.map((folder) => {
                const folderSessions = others.filter(
                  (s) => s.folderId === folder.id,
                );
                const isCollapsed = folder.isCollapsed ?? false;

                return (
                  <div key={folder.id} className="space-y-0.5">
                    <FolderHeader
                      folder={folder}
                      count={folderSessions.length}
                      hasActiveSession={folderSessions.some(
                        (s) => mergedSessionStates[s.id] === "working" || mergedSessionStates[s.id] === "streaming",
                      )}
                      onToggleCollapse={() => toggleFolderCollapse(folder.id)}
                      onNewSession={() => onNewInFolder?.(folder.id)}
                      onRename={() =>
                        handleRenameFolder(folder.id, folder.name)
                      }
                      onDelete={() => handleDeleteFolder(folder.id)}
                    />

                    {!isCollapsed && (
                      <div className="pl-1 ml-4 space-y-px">
                        <AnimatePresence initial={false} mode="popLayout">
                          {folderSessions.map((s) => (
                            <SessionRow
                              key={s.id}
                              session={s}
                              active={activeId === s.id}
                              pinned={false}
                              status={mergedSessionStates[s.id]}
                              folders={folders}
                              {...sessionRowHandlers(s)}
                            />
                          ))}
                        </AnimatePresence>
                        {folderSessions.length === 0 && (
                          <p className="py-1 text-xs text-muted-foreground/30 italic pl-1.5">
                            Empty folder
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Sessions with no folder assignment */}
              {(() => {
                const uncategorizedSessions = others.filter((s) => !s.folderId);

                return (
                  <div className="space-y-0.5">
                    <UncategorizedHeader
                      count={uncategorizedSessions.length}
                      isCollapsed={uncategorizedCollapsed}
                      onToggleCollapse={toggleUncategorizedCollapse}
                    />

                    {!uncategorizedCollapsed && (
                      <div className="pl-1 ml-4 space-y-px">
                        <AnimatePresence initial={false} mode="popLayout">
                          {uncategorizedSessions.map((s) => (
                            <SessionRow
                              key={s.id}
                              session={s}
                              active={activeId === s.id}
                              pinned={false}
                              status={mergedSessionStates[s.id]}
                              folders={folders}
                              {...sessionRowHandlers(s)}
                            />
                          ))}
                        </AnimatePresence>
                        {uncategorizedSessions.length === 0 && (
                          <p className="py-1 text-xs text-muted-foreground/30 italic pl-1.5">
                            No other chats
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </Section>
        </div>

        {/* Settings at bottom — dropdown width tracks the live sidebar width */}
        <div className="px-2 pb-2 pt-1.5 border-t border-sidebar-border/40">
          <UserDropdown
            selectedStatus={userStatus}
            onStatusChange={(status) => setUserStatus(status as UserStatus)}
            onAction={handleUserAction}
            align="start"
            side="top"
            alignOffset={-8}
            contentWidth={sidebarWidth}
            user={{
              name: "August User",
              username: "@august",
              avatar:
                "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&fit=crop&crop=face",
              initials: "AU",
              status: userStatus,
            }}
            trigger={
              <button
                type="button"
                className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-sidebar-foreground/50 hover:bg-white/[0.03] hover:text-sidebar-foreground/75 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                title="Open settings"
                aria-label="Open settings"
              >
                <Settings className="size-3.5 opacity-60" />
                <span>Settings</span>
              </button>
            }
          />
        </div>
      </div>
    </div>
  );
}
