/* ── Session list ───────────────────────────────────────────────────── */
/* Top:   Collapse · New chat · Automations · Skills                       */
/* Middle: Pinned + Projects (folders / sessions)                           */
/* Bottom: Settings                                                        */

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { ChevronUp, Search, X } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { openFolderViaTauri, folderNameFromPath } from "@/api/folder";
import { isTauri } from "@/lib/tauri-detect";
import { t } from "@/lib/motion";
import { useAppUpdate } from "@/hooks/useAppUpdate";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useDefaultWorkspace } from "@/hooks/useDefaultWorkspace";
import { ConfirmDialog } from "@/components/overlays/ConfirmDialog";
import {
  useSessionsStore,
  renameSession,
  deleteSession,
  archiveSession,
  moveSessionToFolder,
  createFolder,
  renameFolder,
  deleteFolder,
  deleteUncategorizedSessions,
  getOrCreateEmptySession,
  toggleFolderCollapse,
  findOrCreateSessionForPath,
  type Session,
  type SessionStatus,
} from "@/store/sessions";
import { useActiveChatStreamsStore, startChatActiveStreamsPoller } from "@/store/chat-active-streams";
import {
  useAccountStore,
  GUEST_ACCOUNT_VIEW,
  logoutAccount,
  setAccountStatus,
} from "@/store/account";
import { toast } from "sonner";
import { api } from "@/api/client";
import { openExternal } from "@/lib/tauri-shell";
import { SessionListNav } from "./SessionListNav";
import { SessionRow } from "./SessionRow";
import { BotsRail } from "./BotsRail";
import { Section, FolderHeader, UncategorizedHeader } from "./FolderTree";
import {
  UserDropdown,
  type UserDropdownAction,
  type UserStatus,
} from "@/components/ui/user-dropdown";
import { WhatsNewModal } from "@/components/overlays/WhatsNewModal";
import { NotificationsPanel } from "@/components/overlays/NotificationsPanel";
import { SwitchAccountModal } from "@/components/overlays/SwitchAccountModal";

const SESSIONS_KEY = "august-pinned-sessions";
const STORAGE = (() => {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]") as string[];
  } catch {
    return [];
  }
})();

const settingsRowMotion = {
  rest: { x: 0 },
  hover: { x: 3, transition: t.fast },
  tap: { scale: 0.98, transition: t.fast },
};

/** Stable shape of the callbacks passed into every <SessionRow>. */
interface SessionRowHandlers {
  onClick: () => void;
  onTogglePin: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onMoveToFolder: (folderId: string | null) => void;
  onDelete: () => void;
}

interface Props {
  activeId?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (s: Session) => void;
  onNew: () => void;
  onNewInFolder?: (folderId: string | null) => void;
  onNavigate: (path: string) => void;
}

export function SessionList({
  activeId,
  collapsed: _collapsed,
  onToggleCollapsed,
  onSelect,
  onNew,
  onNewInFolder,
  onNavigate,
}: Props) {
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set(STORAGE));
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [switchAccountOpen, setSwitchAccountOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [uncategorizedCollapsed, setUncategorizedCollapsed] = useState(
    () => localStorage.getItem("august-uncategorized-collapsed") !== "0",
  );
  const [searchQuery, setSearchQuery] = useState("");

  // OS home directory — shown as the "Tasks" group tooltip (dynamic per user).
  const { path: defaultWorkspacePath } = useDefaultWorkspace();

  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const activeAccount =
    accounts.find((a) => a.id === activeAccountId) ?? null;
  const signedIn = activeAccount != null;
  const { available: updateAvailable } = useAppUpdate();
  const dropdownUser = activeAccount
    ? {
        name: activeAccount.displayName,
        username: activeAccount.username,
        avatar: activeAccount.avatar,
        initials: activeAccount.initials,
        status: activeAccount.status,
      }
    : GUEST_ACCOUNT_VIEW;

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
        openSettingsSection("appearance");
        break;
      case "notifications":
        setNotificationsOpen(true);
        break;
      case "update":
        openSettingsSection("app-updates");
        break;
      case "profile":
        openSettingsSection("account");
        break;
      case "create-account":
        setSwitchAccountOpen(true);
        break;
      case "download":
        toast.message("You're already in the desktop app.");
        break;
      case "whats-new":
        setWhatsNewOpen(true);
        break;
      case "help":
        void openExternal("https://github.com/KILLER3UG/august-proxy#readme");
        break;
      case "switch":
        if (accounts.length === 0) {
          openSettingsSection("account");
        } else {
          setSwitchAccountOpen(true);
        }
        break;
      case "logout":
        logoutAccount();
        toast.message("Signed out of local account");
        break;
      default:
        break;
    }
  };

  const sessions = useSessionsStore((s) => s.sessions);
  const folders = useSessionsStore((s) => s.folders);
  const sessionStates = useSessionsStore((s) => s.sessionStates);
  const activeChatSessions = useActiveChatStreamsStore((s) => s.active);

  useEffect(() => {
    startChatActiveStreamsPoller();
  }, []);

  const { state: confirmState, confirm: confirmStyled, handleConfirm, handleCancel } =
    useConfirmDialog();

  // Latest render values for the cached per-session row handlers. The handler
  // objects are memoized per session id (so React.memo on SessionRow can bail
  // out on unrelated re-renders), but their bodies must still act on the
  // current onSelect/activeId/pinnedIds — hence the indirection.
  const latest = useRef({ onSelect, onNavigate, activeId, sessions, pinnedIds });
  latest.current = { onSelect, onNavigate, activeId, sessions, pinnedIds };

  /** Confirm + delete with exit animation (store remove drives AnimatePresence). */
  const confirmDeleteSession = useCallback(async (s: Session) => {
    const ok = await confirmStyled({
      title: "Delete chat?",
      message: "This permanently deletes the chat. This cannot be undone.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) {
      return;
    }
    const { pinnedIds, activeId, onSelect, onNavigate } = latest.current;
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
      // No other chat to land on: leave the dead /c/<id> route before the
      // empty pane renders (white screen otherwise).
      else onNavigate('/');
    }
  }, [confirmStyled]);

  // Merge the local per-session status with the live poller output so a
  // session that has a backend generation in progress shows the pulse
  // dot even when the user is on a different session. The local status
  // takes precedence when both are present.
  // The live poller is authoritative: a stale local 'idle'/'done' must
  // never hide a background generation (rows showed Working only after
  // being clicked while the local status was refreshed).
  const mergedSessionStates = useMemo(() => {
    const next: Record<string, SessionStatus> = { ...sessionStates };
    for (const [id, status] of Object.entries(activeChatSessions)) {
      next[id] = status;
    }
    return next;
  }, [sessionStates, activeChatSessions]);

  /** Status for a session row: live maps are keyed by WORKBENCH id
   *  (realtime bridge writes wb_*); look up both id forms so the pulse
   *  dot shows for background work (audit finding). */
  const statusFor = (s: { id: string; workbenchSessionId?: string }): SessionStatus | undefined =>
    mergedSessionStates[s.id] ??
    (s.workbenchSessionId ? mergedSessionStates[s.workbenchSessionId] : undefined);

  // Hidden file input for native folder picker (browser fallback)
  const dirInputRef = useRef<HTMLInputElement>(null);

  const handleFolderUploadClick = async (
    e: React.MouseEvent<HTMLButtonElement>,
  ) => {
    e.stopPropagation();

    let selectedPath: string | null = null;

    if (isTauri) {
      try {
        const result = await openFolderViaTauri();
        if (result.cancelled || !result.path) return;
        selectedPath = result.path;
      } catch (err) {
        console.error("Failed to open Tauri directory dialog:", err);
        toast.error("Could not open folder picker");
        return;
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
    const folderName =
      folderNameFromPath(normalizedPath) ||
      normalizedPath.split("/").pop() ||
      "workspace";

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
      window.dispatchEvent(new CustomEvent('august:open-right-sidebar'));
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
        window.dispatchEvent(new CustomEvent('august:open-right-sidebar'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Access failed: ${message}`, { id: toastId });
      }
    })();
    e.target.value = '';
  };

  const visible = useMemo(() => sessions.filter((s) => !s.isArchived), [sessions]);

  // Multi-repo sidebar groups by folderId — do not hide other folders' sessions
  // when the global current workspace changes (that made folders look empty).
  const pinned = useMemo(() => visible.filter((s) => pinnedIds.has(s.id)), [visible, pinnedIds]);
  const others = useMemo(() => visible.filter((s) => !pinnedIds.has(s.id)), [visible, pinnedIds]);

  const togglePin = useCallback((id: string) => {
    const next = new Set(latest.current.pinnedIds);
    void (next.has(id) ? next.delete(id) : next.add(id));
    setPinnedIds(next);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([...next]));
  }, []);

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

  const handleDeleteFolder = async (id: string) => {
    const ok = await confirmStyled({
      title: "Delete folder?",
      message:
        "All sessions inside will be moved to uncategorized (Tasks).",
      confirmLabel: "Delete folder",
      variant: "destructive",
    });
    if (ok) {
      deleteFolder(id);
    }
  };

  const toggleUncategorizedCollapse = () => {
    const next = !uncategorizedCollapsed;
    setUncategorizedCollapsed(next);
    localStorage.setItem("august-uncategorized-collapsed", next ? "1" : "0");
  };

  const handleDeleteUncategorized = async () => {
    // Match the sidebar group: unfiled and not pinned (pinned lives under Pinned).
    const unfiled = useSessionsStore
      .getState()
      .sessions.filter(
        (session) =>
          !session.isArchived && !session.folderId && !pinnedIds.has(session.id),
      );
    if (!unfiled.length) return;
    const ok = await confirmStyled({
      title: "Delete all tasks?",
      message: `Permanently delete all ${unfiled.length} chat${unfiled.length === 1 ? "" : "s"} in Tasks?`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) {
      return;
    }
    const deletedIds = new Set(
      deleteUncategorizedSessions({ excludeIds: pinnedIds }),
    );
    if (activeId && deletedIds.has(activeId)) {
      const fallback =
        useSessionsStore.getState().sessions.find((session) => !session.isArchived) ??
        getOrCreateEmptySession(null);
      onSelect(fallback);
    }
  };

  const sessionRowHandlers = useMemo(() => {
    const map = new Map<string, SessionRowHandlers>();
    for (const s of visible) {
      map.set(s.id, {
        onClick: () => latest.current.onSelect(s),
        onTogglePin: () => togglePin(s.id),
        onRename: (newTitle: string) => renameSession(s.id, newTitle),
        onArchive: () => {
          archiveSession(s.id);
          const { activeId, onSelect, sessions } = latest.current;
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
    }
    return map;
    // Re-create the map when the visible set changes (sessions added/removed/
    // archived). The captured callbacks read `latest.current` for fresh
    // onSelect/activeId so we don't have to rebuild on every keystroke.
  }, [visible, togglePin, confirmDeleteSession]);

  // ── Session search — client-side title filter across every section ──
  const searchTrim = searchQuery.trim().toLowerCase();
  const searching = searchTrim.length > 0;
  const matchesSearch = useCallback(
    (s: Session) => !searching || (s.title || "").toLowerCase().includes(searchTrim),
    [searching, searchTrim],
  );
  // Bucketed views memoized on the search term so each keystroke costs one
  // O(n) pass instead of three (Pinned + Projects + uncategorized all filter
  // `others`/`pinned` independently). Without this, a typing-heavy search
  // re-rendered every SessionRow on every keypress (audit finding).
  const visiblePinned = useMemo(
    () => (searching ? pinned.filter(matchesSearch) : pinned),
    [searching, pinned, matchesSearch],
  );
  const searchMatchCount = useMemo(
    () =>
      searching
        ? sessions.filter((s) => !s.isArchived && matchesSearch(s)).length
        : 0,
    [searching, sessions, matchesSearch],
  );
  // Single pass to bucket `others` by folderId (and unfiled) for the JSX
  // below — the previous code called `others.filter(...)` per folder in the
  // render body, which was O(n×folders) on every render.
  const { othersByFolder, unfiledSessions } = useMemo(() => {
    const byFolder = new Map<string, Session[]>();
    let unfiled: Session[] = [];
    for (const s of others) {
      if (searching && !matchesSearch(s)) continue;
      if (s.folderId) {
        const list = byFolder.get(s.folderId);
        if (list) list.push(s);
        else byFolder.set(s.folderId, [s]);
      } else {
        unfiled.push(s);
      }
    }
    return { othersByFolder: byFolder, unfiledSessions: unfiled };
  }, [others, searching, matchesSearch]);

  return (
    <div ref={rootRef} className="august-session-list flex h-full text-sm relative select-none bg-sidebar">
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
          onNew={onNew}
          onNavigate={onNavigate}
          onToggleCollapsed={onToggleCollapsed}
          activePath={typeof window !== 'undefined' ? window.location.pathname : ''}
        />

        {/* Session search — filters titles across Pinned / folders / task */}
        <div className="px-1.5 pt-1.5">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-sidebar-foreground/30 pointer-events-none" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearchQuery("");
              }}
              placeholder="Search sessions…"
              aria-label="Search sessions"
              className="w-full rounded-md bg-white/[0.04] border border-sidebar-border/50 pl-7 pr-7 py-1 text-xs text-sidebar-foreground/80 placeholder:text-sidebar-foreground/25 outline-none focus:border-sidebar-ring/70 transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-sidebar-foreground/30 hover:text-sidebar-foreground/60 transition-colors"
                title="Clear search"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>

        {/* Scrollable sessions area — denser, drawer-only simplicity */}
        <div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-2">
          {searching && searchMatchCount === 0 && (
            <p className="py-4 text-center text-xs text-sidebar-foreground/30 italic">
              No sessions match “{searchQuery.trim()}”
            </p>
          )}
          {visiblePinned.length > 0 && (
          <Section
            title="Pinned"
            count={visiblePinned.length}
            empty="Shift-click a chat to pin"
          >
            <LayoutGroup id="pinned-sessions">
              <AnimatePresence initial={false} mode="popLayout">
                {visiblePinned.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={activeId === s.id}
                    pinned
                    status={statusFor(s)}
                    folders={folders}
                    {...sessionRowHandlers.get(s.id)!}
                  />
                ))}
              </AnimatePresence>
            </LayoutGroup>
          </Section>
          )}

          {/* Bot Mode Phase A: Bots roster (vertical rail — identicon avatars,
              presence dot, one canonical chat per Bot). */}
          {!searching && (
            <BotsRail
              activeSessionId={
                sessions.find((s) => s.id === activeId || s.workbenchSessionId === activeId)
                  ?.workbenchSessionId
              }
              onOpenSession={(sid) => {
                const ui = sessions.find((s) => s.workbenchSessionId === sid);
                if (ui) onSelect(ui);
              }}
            />
          )}

          <Section
            title="Projects"
            count={searching ? searchMatchCount - visiblePinned.length : others.length}
            onNewFolder={handleCreateFolder}
            onUploadFolder={(e) => { void handleFolderUploadClick(e); }}
          >
            <div className="space-y-1.5">
              {/* Collapsible folders and their sessions */}
              {folders.map((folder) => {
                const folderSessions = othersByFolder.get(folder.id) ?? [];
                // While searching, hide folders without matches and force-expand the rest.
                if (searching && folderSessions.length === 0) return null;
                const isCollapsed = folder.isCollapsed ?? false;

                return (
                  <div key={folder.id} className="august-project-group space-y-0.5">
                    <FolderHeader
                      folder={folder}
                      count={folderSessions.length}
                      hasActiveSession={folderSessions.some(
                        (s) => statusFor(s) === "working" || statusFor(s) === "streaming",
                      )}
                      onToggleCollapse={() => toggleFolderCollapse(folder.id)}
                      onNewSession={() => onNewInFolder?.(folder.id)}
                      onRename={() =>
                        handleRenameFolder(folder.id, folder.name)
                      }
                      onDelete={() => handleDeleteFolder(folder.id)}
                    />

                    {(!isCollapsed || searching) && (
                      <div className="august-project-sessions pl-1 ml-4 space-y-px">
                        <AnimatePresence initial={false} mode="popLayout">
                          {folderSessions.map((s) => (
                            <SessionRow
                              key={s.id}
                              session={s}
                              active={activeId === s.id}
                              pinned={false}
                              status={statusFor(s)}
                              folders={folders}
                              {...sessionRowHandlers.get(s.id)!}
                            />
                          ))}
                        </AnimatePresence>
                        {folderSessions.length === 0 && !searching && (
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
                if (searching && unfiledSessions.length === 0) return null;

                return (
                  <div className="space-y-0.5">
                    <UncategorizedHeader
                      count={unfiledSessions.length}
                      isCollapsed={uncategorizedCollapsed}
                      onToggleCollapse={toggleUncategorizedCollapse}
                      onNewSession={() => onNewInFolder?.(null)}
                      onDelete={handleDeleteUncategorized}
                      workspaceHint={defaultWorkspacePath}
                    />

                    {(!uncategorizedCollapsed || searching) && (
                      <div className="pl-1 ml-4 space-y-px">
                        <AnimatePresence initial={false} mode="popLayout">
                          {(searching
                            ? unfiledSessions
                            : uncategorizedCollapsed
                              ? unfiledSessions.slice(0, 5)
                              : unfiledSessions
                          ).map((s) => (
                            <SessionRow
                              key={s.id}
                              session={s}
                              active={activeId === s.id}
                              pinned={false}
                              status={statusFor(s)}
                              folders={folders}
                              {...sessionRowHandlers.get(s.id)!}
                            />
                          ))}
                        </AnimatePresence>
                        {!searching && unfiledSessions.length > 5 && (
                          <button
                            type="button"
                            onClick={() => setUncategorizedCollapsed((v) => !v)}
                            className="pl-1.5 py-1 text-[11px] text-muted-foreground/60 hover:text-foreground"
                          >
                            {uncategorizedCollapsed ? `Show ${unfiledSessions.length - 5} more` : 'Show less'}
                          </button>
                        )}
                        {unfiledSessions.length === 0 && !searching && (
                          <p className="py-1 text-xs text-muted-foreground/30 italic pl-1.5">
                            No tasks yet
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

        {/* Bottom: user identity row — Claude-style username + avatar icon
            that opens the selection list (profile / settings / notifications /
            what's-new / account). Falls back to Guest when signed out. */}
        <div className="px-2 pb-2 pt-1.5 border-t border-sidebar-border/40">
          <UserDropdown
            selectedStatus={dropdownUser.status}
            onStatusChange={(status) => {
              if (signedIn) setAccountStatus(status as UserStatus);
            }}
            onAction={handleUserAction}
            signedIn={signedIn}
            accounts={accounts.map((a) => ({
              id: a.id,
              name: a.displayName,
              avatar: a.avatar,
              initials: a.initials,
            }))}
            align="start"
            side="top"
            alignOffset={-8}
            contentWidth={sidebarWidth}
            user={dropdownUser}
            updateAvailable={updateAvailable}
            trigger={
              <motion.button
                type="button"
                initial="rest"
                whileHover="hover"
                whileTap="tap"
                variants={settingsRowMotion}
                className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 hover:bg-white/[0.03]"
                title={dropdownUser.name}
                aria-label={`Account menu — ${dropdownUser.name}`}
                data-testid="user-menu-trigger"
              >
                <Avatar className="size-6 shrink-0 border border-white/20">
                  {dropdownUser.avatar ? (
                    <AvatarImage src={dropdownUser.avatar} alt={dropdownUser.name} />
                  ) : null}
                  <AvatarFallback className="text-[10px]">{dropdownUser.initials}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-sidebar-foreground/80">
                  {dropdownUser.name}
                </span>
                {updateAvailable && (
                  <span
                    className="shrink-0 rounded-sm bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
                    title={`Update available: v${updateAvailable.version}`}
                  >
                    Update
                  </span>
                )}
                <ChevronUp className="size-3 shrink-0 text-muted-foreground/50" />
              </motion.button>
            }
          />
        </div>
      </div>

      <WhatsNewModal open={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
      <NotificationsPanel
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
      />
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        cancelLabel={confirmState.cancelLabel}
        variant={confirmState.variant}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
      <SwitchAccountModal
        open={switchAccountOpen}
        onClose={() => setSwitchAccountOpen(false)}
        onCreateNew={() => openSettingsSection("account")}
      />
    </div>
  );
}
