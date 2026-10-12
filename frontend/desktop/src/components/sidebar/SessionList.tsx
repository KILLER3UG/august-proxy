/* ── Session list ───────────────────────────────────────────────────── */
/* Top:   Collapse · New chat · Automations · Skills                       */
/* Middle: Pinned + Projects (folders / sessions)                           */
/* Bottom: Settings                                                        */

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useQuery } from '@tanstack/react-query';
import { listBots } from '@/api/api-client';
import { useNeedsHandoffStore } from './needs-handoff-store';
import { PromptDialog } from '@/components/overlays/PromptDialog';
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { ChevronUp, Search, X, AlertCircle } from "lucide-react";
import { openConversationSearch } from "@/store/conversation-search";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { openFolderViaTauri, folderNameFromPath } from "@/api/folder";
import { isTauri } from "@/lib/tauri-detect";
import { t } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useAppUpdate } from "@/hooks/useAppUpdate";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
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
import { groupByDate } from "@/lib/date-group";
import {
  UserDropdown,
  type UserDropdownAction,
  type UserStatus,
} from "@/components/ui/user-dropdown";
import { WhatsNewModal } from "@/components/overlays/WhatsNewModal";
import { NotificationsPanel } from "@/components/overlays/NotificationsPanel";
import { SwitchAccountModal } from "@/components/overlays/SwitchAccountModal";
import { usageApi } from '@/api/usage';
import { SessionUsageProvider, NO_DELTAS } from './session-usage';

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

/** Rows rendered per group before the rest is held back. Each row is a
 *  framer-motion node with its own handlers, and the pool is unbounded — sessions
 *  accumulate in localStorage and nothing prunes them, so a long history used to
 *  mount all of it on first paint. Newest-first, so this hides the oldest, and
 *  ShownOfTotal names how many. */
const GROUP_RENDER_CAP = 60;
const capped = (list: Session[]): Session[] => list.slice(0, GROUP_RENDER_CAP);

/** Shown/total caption for a group header (Hermes "SESSIONS 150/884").
 *  Renders ONLY when the visible rows are a subset of the group — the search
 *  filter, or `GROUP_RENDER_CAP`. An unfiltered, uncapped group keeps its bare
 *  total instead of a redundant "40/40". */
function ShownOfTotal({ shown, total }: { shown: number; total: number }) {
  if (shown >= total) return null;
  return (
    <p
      className="px-2 pb-0.5 text-2xs tabular-nums text-sidebar-foreground/35"
      data-testid="group-shown-of-total"
    >
      {shown}/{total}
    </p>
  );
}

/** Date sub-heading INSIDE a leaf pool (a folder, or Unfiled).
 *
 *  Deliberately NOT a <Section>: `Section` gates its action buttons on the
 *  title string, so a date header rendered as one would either sprout
 *  irrelevant controls or force that component to learn a new title. The
 *  typography is copied from FolderTree's own heading so the two read as the
 *  same level of hierarchy.
 *
 *  Only rendered when date grouping is on, which the sort toggle controls —
 *  grouping by date is meaningless when rows are sorted by name. */
function DateGroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <h4
      className="px-2 pt-1.5 pb-0.5 text-2xs text-sidebar-foreground/45 font-medium tracking-wide uppercase"
      data-testid="date-group-header"
    >
      {label}
      {count > 0 && (
        <span className="ml-1 text-sidebar-foreground/30 tabular-nums">{count}</span>
      )}
    </h4>
  );
}


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
  
  onToggleCollapsed,
  onSelect,
  onNew,
  onNewInFolder,
  onNavigate,
}: Props) {
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set(STORAGE));
  // Hermes (R1 §3): "Bot Mode lives in the left sidebar as a TAB next to
  // your conversations — a Sessions | Bots tab strip — rather than a second
  // pane stacked below the session list." Persisted per install.
  // Read-only now: the tab strip that owned `setRailTab` is gone. `railTab`
  // still gates the body (`bots` roster vs session list), and the persisted
  // key is honoured so an install that last sat on Bots keeps landing there.
  // The `terminal` variant is dropped — that tab never switched the rail.
  const [railTab] = useState<'sessions' | 'bots'>(() =>
    localStorage.getItem('august-sidebar-tab') === 'bots' ? 'bots' : 'sessions',
  );
  // DeepSeek (R4 §3): "sort by Last updated (remembers choice)". August has
  // no drag order yet, so the remembered choice is Updated | Name.
  const [sortBy, setSortBy] = useState<'updated' | 'name'>(() =>
    localStorage.getItem('august-sidebar-sort') === 'name' ? 'name' : 'updated',
  );
  const botsQuery = useQuery({ queryKey: ['bots'], queryFn: listBots });
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [switchAccountOpen, setSwitchAccountOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Expanded by default: collapsed used to render an empty group, so a fresh
  // profile saw "Tasks 40" and zero rows — history looked deleted. An explicit
  // "1" from the header chevron still collapses it.
  const [uncategorizedCollapsed, setUncategorizedCollapsed] = useState(
    () => localStorage.getItem("august-uncategorized-collapsed") === "1",
  );
  const [searchQuery, setSearchQuery] = useState("");

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
  // DeepSeek parity: rows are ordered by the remembered choice — Last
  // updated (default) or Name. Applied to the unpinned pool; folders and
  // Pinned keep their own deliberate order.
  const others = useMemo(() => {
    const list = visible.filter((s) => !pinnedIds.has(s.id));
    const stamp = (x: (typeof list)[number]) => {
      const t = Date.parse(x.startedAt || '');
      return Number.isFinite(t) ? t : 0;
    };
    return list.sort((a, b) =>
      sortBy === 'name'
        ? (a.title || '').localeCompare(b.title || '')
        : stamp(b) - stamp(a),
    );
  }, [visible, pinnedIds, sortBy]);

  /** Date headers only make sense when rows are ordered by date. Under
   *  `sortBy === 'name'` the list is alphabetical, so a "Today" heading over
   *  alphabetically-adjacent rows would describe nothing. Grouping is gated on
   *  this rather than adding a second toggle the user has to keep in step.
   *
   *  OFF by default even so. Measured on a real 41-chat profile: the headers
   *  cost ten full rows (TODAY 2 / THURSDAY, OCT 8 1 / …) to label eight
   *  sessions, and they repeat the relative time the row already shows on its
   *  own line. None of the four references group a chat list by date — Claude
   *  and Haze show none, KiloCode nests sessions under a project instead. The
   *  rows still sort by recency; only the labels are gone. Flip
   *  `august-sidebar-date-groups` to '1' to get them back. */
  const groupDates =
    sortBy === 'updated' && localStorage.getItem('august-sidebar-date-groups') === '1';

  const togglePin = useCallback((id: string) => {
    const next = new Set(latest.current.pinnedIds);
    void (next.has(id) ? next.delete(id) : next.add(id));
    setPinnedIds(next);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([...next]));
  }, []);

  // Folder naming goes through PromptDialog: window.prompt is unstyled and
  // a silent no-op in some Tauri webviews (rename did nothing at all).
  const [folderPrompt, setFolderPrompt] = useState<
    { mode: 'create' } | { mode: 'rename'; id: string; currentName: string } | null
  >(null);

  const handleCreateFolder = () => setFolderPrompt({ mode: 'create' });
  const handleRenameFolder = (id: string, currentName: string) =>
    setFolderPrompt({ mode: 'rename', id, currentName });

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

  // ── Session search — title OR id, across every section ──
  // The model quotes session ids (handoffs, run ids, `forget(key=…)`); a
  // search that only matched titles made those unfindable (DeepSeek matches
  // both — R4 §3). One token AND-match over `title + id`.
  const searchTrim = searchQuery.trim().toLowerCase();
  const searching = searchTrim.length > 0;
  const searchTokens = useMemo(
    () => searchTrim.split(/\s+/).filter(Boolean),
    [searchTrim],
  );
  const matchesSearch = useCallback(
    (s: Session) => {
      if (!searching) return true;
      const haystack = `${(s.title || "").toLowerCase()} ${s.id.toLowerCase()}`;
      return searchTokens.every((t) => haystack.includes(t));
    },
    [searching, searchTokens],
  );
  // Bucketed views memoized on the search term so each keystroke costs one
  // O(n) pass instead of three (Pinned + Projects + uncategorized all filter
  // `others`/`pinned` independently). Without this, a typing-heavy search
  // re-rendered every SessionRow on every keypress (audit finding).
  // Needs-attention lane (Hermes "Active now" pattern): sessions with
  // workstreams waiting on a human decision, grouped at the top instead of
  // scattered amber dots (2026-10-03 spec §3.3.5).
  const attentionBySession = useNeedsHandoffStore((s) => s.bySession);
  const attentionSessions = useMemo(
    () =>
      Object.entries(attentionBySession)
        .filter(([, info]) => info.needs > 0)
        .map(([id]) => sessions.find((x) => x.id === id))
        .filter((x): x is Session => Boolean(x)),
    [attentionBySession, sessions],
  );

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
  const { othersByFolder, unfiledSessions, shownOthers } = useMemo(() => {
    const byFolder = new Map<string, Session[]>();
    const unfiled: Session[] = [];
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
    let shown = capped(unfiled).length;
    for (const list of byFolder.values()) shown += capped(list).length;
    return { othersByFolder: byFolder, unfiledSessions: unfiled, shownOthers: shown };
  }, [others, searching, matchesSearch]);

  // Pool sizes WITHOUT the search filter, for the shown/total caption. Only
  // walked while a filter can actually hide something, so the common
  // (unfiltered) render stays a single pass.
  const poolTotals = useMemo(() => {
    const byFolder = new Map<string, number>();
    let unfiled = 0;
    if (searching) {
      for (const s of others) {
        if (s.folderId) byFolder.set(s.folderId, (byFolder.get(s.folderId) ?? 0) + 1);
        else unfiled += 1;
      }
    }
    return { byFolder, unfiled };
  }, [searching, others]);

  /* ── Batched token deltas (Haze row signature) ────────────────────────
   * Every visible chat row shows `+input / −output`. Asking
   * `usageApi.session(id)` per row meant one request per row, each dragging
   * back a 500-event list the row never reads — a list render fanning out
   * over the network. This asks for every id ONCE, in the same capped shape
   * the JSX below mounts, so a 2,000-chat history still sends a bounded list.
   * Collapsed folders and a collapsed Tasks pool are excluded because those
   * rows are not on screen to show a delta. */
  const usageBatchIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (s: Session) => {
      // Usage is recorded against the workbench/SoT id, the same form the
      // batched per-row token delta reads (`usageApi.sessions`). The removed
      // status bar used to read it too; this is now the only consumer.
      const id = s.workbenchSessionId || s.id;
      if (!id || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };
    for (const s of visiblePinned) add(s);
    for (const folder of folders) {
      const pool = othersByFolder.get(folder.id);
      if (!pool?.length) continue;
      if (folder.isCollapsed && !searching) continue;
      for (const s of capped(pool)) add(s);
    }
    if (!uncategorizedCollapsed || searching) {
      for (const s of capped(unfiledSessions)) add(s);
    }
    return ids;
  }, [visiblePinned, folders, othersByFolder, unfiledSessions, uncategorizedCollapsed, searching]);

  // Keyed on the joined ids so the query is shared by every row and only
  // re-runs when the SET of visible chats changes — not on each reorder.
  const usageBatchKey = usageBatchIds.join(',');
  const usageBySession = useQuery({
    queryKey: ['usage', 'sessions', usageBatchKey],
    queryFn: () => usageApi.sessions(usageBatchKey ? usageBatchKey.split(',') : []),
    enabled: usageBatchKey.length > 0,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });

  return (
    <SessionUsageProvider value={usageBySession.data?.results ?? NO_DELTAS}>
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
          workspaceName={(() => {
            const s = sessions.find((x) => x.id === activeId || x.workbenchSessionId === activeId);
            return s?.workspacePath ? folderNameFromPath(s.workspacePath) : null;
          })()}
        />

        {/* Sessions | Bots tab strip (Hermes) — the roster gets its own
            surface instead of stacking into the session list. The sort toggle
            is a sibling of the tablist, not a child of it: a `role="tablist"`
            may only contain `role="tab"`, and axe fails the route critically
            when anything else sits inside — which this button did. */}
        {/* The `Sessions | Terminal | Bots` tab strip is REMOVED.

            * None of the four references has a rail tab strip. Claude has
            `+ New / Projects / Artifacts / Customize` and straight into the
            session list; only KiloCode has tabs, and the capture file
            explicitly exempts KiloCode from the selection rule.

            * It was not cosmetic either:
            * - `Terminal` never switched the rail (`{railTab !== 'bots' ?
            *   (entire session list) : null}` gated only bots), so it opened a
            *   BOTTOM DOCK in the main column and left Sessions showing.
            * - Every click threw an uncaught xterm `TypeError` on
            *   `Viewport._innerRefresh` and surfaced a red error toast.
            * - `Bots 2` printed the same number twice on one screen (tab badge
            *   + roster header), from the same `['bots']` query.
            *
            * The terminal is still reachable via the Workbench drawer, which
            * is its only other entry point; the bot roster likewise. */}

        {/* Session search — filters titles across Pinned / folders / task */}
        <div className="px-1.5 pt-1">
          <div className="relative">
            <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 size-3 text-tier-3 pointer-events-none" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearchQuery("");
              }}
              placeholder="Search sessions or ids…"
              aria-label="Search sessions"
              className="w-full rounded-md bg-white/[0.04] border border-sidebar-border/50 pl-6 pr-6 py-0.5 text-xs text-tier-1 placeholder:text-tier-3 outline-none focus:border-sidebar-ring/70 transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-tier-2 hover:text-tier-1 transition-colors"
                title="Clear search"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>

        {/* Scrollable sessions area — denser, drawer-only simplicity */}
        {railTab !== 'bots' ? (
        <div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-2">
          {searching && searchMatchCount === 0 && (
            <div className="py-4 text-center">
              <p className="text-xs text-tier-1">
                No sessions match “{searchQuery.trim()}”
              </p>
              {/* Teaches the two things this search really does: it matches ids
                  as well as titles, and Escape empties it (the input's own
                  onKeyDown). Nothing else is promised. */}
              <p className="mt-1 text-2xs text-tier-3" data-testid="search-empty-hint">
                Search matches titles and session ids · press Esc to clear
              </p>
            </div>
          )}
          {attentionSessions.length > 0 && (
            <div
              className="px-2 pb-1"
              role="region"
              aria-label="Sessions needing attention"
              data-testid="needs-attention-lane"
            >
              <div className="flex items-center gap-1.5 px-1 pb-1 text-2xs font-semibold uppercase tracking-wider text-warning-fg">
                <AlertCircle className="size-3" aria-hidden />
                Needs attention
                <span className="tabular-nums">{attentionSessions.length}</span>
              </div>
              {attentionSessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelect(s)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.78125rem] transition-colors',
                    activeId === s.id
                      ? 'bg-white/[0.08] text-sidebar-foreground'
                      : 'text-sidebar-foreground/75 hover:bg-white/[0.04] hover:text-sidebar-foreground',
                  )}
                  data-testid={`needs-attention-${s.id}`}
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{s.title || 'Untitled'}</span>
                  <span className="shrink-0 text-2xs tabular-nums text-warning-fg">
                    {attentionBySession[s.id].needs}
                  </span>
                </button>
              ))}
            </div>
          )}
          {/* Pinned renders only when it has something in it. It used to render
              always — header, count, and a two-line essay — which spent ~60px
              of the sidebar above the first real chat to explain a gesture that
              is right there on every row. Haze has no Pinned group at all;
              Claude only shows the heading once something is pinned. An active
              search that filtered pinned rows away still gets its line, because
              then the missing rows ARE the state. */}
          {(visiblePinned.length > 0 || (searching && pinned.length > 0)) && (
          <Section
            title="Pinned"
            count={visiblePinned.length}
            empty={searching ? 'No pinned chat matches' : undefined}
          >
            <ShownOfTotal shown={visiblePinned.length} total={pinned.length} />
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

          <Section
            title="Chats and tasks"
            count={searching ? shownOthers : others.length}
            onToggleSort={() => {
              const next = sortBy === 'updated' ? 'name' : 'updated';
              setSortBy(next);
              localStorage.setItem('august-sidebar-sort', next);
            }}
            onNewFolder={handleCreateFolder}
            onUploadFolder={(e) => { void handleFolderUploadClick(e); }}
          >
            <div className="space-y-1.5">
              <ShownOfTotal shown={shownOthers} total={others.length} />
              {/* Collapsible folders and their sessions */}
              {folders.map((folder) => {
                const folderSessions = othersByFolder.get(folder.id) ?? [];
                const renderable = capped(folderSessions);
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
                        <ShownOfTotal
                          shown={renderable.length}
                          total={poolTotals.byFolder.get(folder.id) ?? folderSessions.length}
                        />
                        <AnimatePresence initial={false} mode="popLayout">
                          {/* Cap FIRST, group second: the ShownOfTotal caption
                              above must stay honest about what is on screen,
                              and date headers over a truncated list would
                              describe rows that were never rendered. */}
                          {(groupDates
                            ? groupByDate(renderable, (s) => s.startedAt).map((g) => (
                                <div key={g.label} className="space-y-px">
                                  <DateGroupHeader label={g.label} count={g.items.length} />
                                  {g.items.map((s) => (
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
                                </div>
                              ))
                            : renderable.map((s) => (
                                <SessionRow
                                  key={s.id}
                                  session={s}
                                  active={activeId === s.id}
                                  pinned={false}
                                  status={statusFor(s)}
                                  folders={folders}
                                  {...sessionRowHandlers.get(s.id)!}
                                />
                              )))}
                        </AnimatePresence>
                        {/* No prose where a list is empty. Both headers carry
                            a `+` that starts a chat right there, and each row’s own
                            kebab does the rest — an italic sentence explaining it
                            added a line of noise per folder on a profile with many
                            of them, and no reference has one. */}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Sessions with no folder assignment */}
              {(() => {
                if (searching && unfiledSessions.length === 0) return null;
                const renderableUnfiled = capped(unfiledSessions);

                return (
                  <div className="space-y-0.5">
                    <UncategorizedHeader
                      count={unfiledSessions.length}
                      isCollapsed={uncategorizedCollapsed}
                      onToggleCollapse={toggleUncategorizedCollapse}
                      onNewSession={() => onNewInFolder?.(null)}
                      onDelete={handleDeleteUncategorized}
                    />

                    {(!uncategorizedCollapsed || searching) && (
                      <div className="pl-1 ml-4 space-y-px">
                        <ShownOfTotal
                          shown={renderableUnfiled.length}
                          // poolTotals is only walked while a filter is active, so
                          // off-search the group's own size is the total — and a
                          // total of 0 would hide the cap caption every time.
                          total={searching ? poolTotals.unfiled : unfiledSessions.length}
                        />
                        <AnimatePresence initial={false} mode="popLayout">
                          {/* Cap FIRST, group second — same rule as the folder
                              pool above, so the caption and the headers agree
                              about what is actually on screen. */}
                          {(groupDates
                            ? groupByDate(renderableUnfiled, (s) => s.startedAt).map((g) => (
                                <div key={g.label} className="space-y-px">
                                  <DateGroupHeader label={g.label} count={g.items.length} />
                                  {g.items.map((s) => (
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
                                </div>
                              ))
                            : renderableUnfiled.map((s) => (
                                <SessionRow
                                  key={s.id}
                                  session={s}
                                  active={activeId === s.id}
                                  pinned={false}
                                  status={statusFor(s)}
                                  folders={folders}
                                  {...sessionRowHandlers.get(s.id)!}
                                />
                              )))}
                        </AnimatePresence>
                        {/* No prose where a list is empty. Both headers carry
                            a `+` that starts a chat right there, and each row’s own
                            kebab does the rest — an italic sentence explaining it
                            added a line of noise per folder on a profile with many
                            of them, and no reference has one. */}
                      </div>
                    )}
                  </div>
                );
              })()}
              {!searching && (
                <div className="pt-2 pl-2 pb-1">
                  <button
                    type="button"
                    onClick={() => openConversationSearch()}
                    className="text-[0.71875rem] text-sidebar-foreground/50 hover:text-sidebar-foreground transition"
                  >
                    View all
                  </button>
                </div>
              )}
            </div>
          </Section>
        </div>
        ) : null}

        {/* Bots tab body — the roster owns the surface while its tab is
            active (Hermes: a tab strip, not a pane stacked below the list). */}
        {railTab === 'bots' ? (
          <div className="flex-1 overflow-y-auto">
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
          </div>
        ) : null}

        {/* Bottom: user identity row — Claude-style username + avatar icon
            that opens the selection list (profile / settings / notifications /
            what's-new / account). Falls back to Guest when signed out. */}
        <div className="px-2 pb-2 pt-1.5 border-t border-sidebar-border/40">
          <div className="min-w-0">
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
                  className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 hover:bg-white/[0.04]"
                  title={dropdownUser.name}
                  aria-label={`Account menu — ${dropdownUser.name}`}
                  data-testid="user-menu-trigger"
                >
                  <Avatar className="size-6 shrink-0 border border-white/20">
                    {dropdownUser.avatar ? (
                      <AvatarImage src={dropdownUser.avatar} alt={dropdownUser.name} />
                    ) : null}
                    <AvatarFallback className="text-2xs">{dropdownUser.initials}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1 truncate text-[0.78125rem]">
                    <span className="font-medium text-sidebar-foreground">{dropdownUser.name}</span>
                    
                  </div>
                  <ChevronUp className="size-3 shrink-0 text-muted-foreground/50" />
                </motion.button>
              }
            />
          </div>
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
      <PromptDialog
        open={folderPrompt !== null}
        title={folderPrompt?.mode === 'rename' ? 'Rename folder' : 'New folder'}
        label="Folder name"
        initialValue={folderPrompt?.mode === 'rename' ? folderPrompt.currentName : ''}
        placeholder="Folder name"
        confirmLabel={folderPrompt?.mode === 'rename' ? 'Rename' : 'Create'}
        onSubmit={(name) => {
          if (folderPrompt?.mode === 'rename' && name !== folderPrompt.currentName) {
            renameFolder(folderPrompt.id, name);
          } else if (folderPrompt?.mode === 'create') {
            createFolder(name);
          }
          setFolderPrompt(null);
        }}
        onCancel={() => setFolderPrompt(null)}
      />
    </div>
    </SessionUsageProvider>
  );
}
