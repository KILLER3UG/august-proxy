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
import { Button } from "@/components/ui/button";
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
import { useSessionReadState } from './session-read-state';

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

/** Compact token count for the sidebar usage card (18.4M, 912k). */
function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

/** Project sub-heading INSIDE a leaf pool (a folder, or Unfiled).
 *
 *  Deliberately NOT a <Section>: `Section` gates its action buttons on the
 *  title string, so a project header rendered as one would either sprout
 *  irrelevant controls or force that component to learn a new title. The
 *  typography is copied from FolderTree's own heading so the two read as the
 *  same level of hierarchy.
 *
 *  Only rendered when project grouping is on, which the chat view menu
 *  controls. It replaced a date sub-heading: a chat list is already ordered by
 *  recency, so date buckets repeated what the row's own relative time said,
 *  while the project a chat belongs to is a fact the row does not carry.
 *
 *  Its label is SENTENCE CASE, like the section header it sits under. It used
 *  to be `uppercase tracking-wide`, which shouted a group label in a rail
 *  whose every other group label is quiet — the reference measures those
 *  labels as "small, muted, sentence case — NOT uppercase"
 *  (docs/plans/2026-10-11-ui-reference-capture.md §5, "Left nav"), and
 *  `FolderTree`'s own `Section` heading was already sentence case, so the
 *  project label was the one voice in the rail that did not match. */
function ProjectGroupHeader({
  label,
  count,
  path,
}: {
  label: string;
  count: number;
  path?: string;
}) {
  return (
    <h4
      className="flex items-center gap-1 px-2 pt-1.5 pb-0.5 text-2xs text-sidebar-foreground/45 font-medium"
      data-testid="project-group-header"
      title={path || label}
    >
      {/* `truncate` needs a BLOCK CONTAINER: `overflow` and `text-overflow`
          do not apply to an inline box, so on the bare span it was inert and
          a long group name ran past the sidebar edge. The h4 is a flex row,
          so the label is a flex item — blockified — and the count stays
          beside it. */}
      <span className="min-w-0 truncate">{label}</span>
      {count > 0 && (
        <span className="shrink-0 text-sidebar-foreground/30 tabular-nums">{count}</span>
      )}
    </h4>
  );
}

/** One project bucket for the "Group by project" view: every chat whose
 *  `workspacePath` resolves to the same directory. Chats with no workspace are
 *  collected into a single trailing group rather than scattered — the group is
 *  the pool's own order (active first), so the first group is always the one
 *  holding the row that just moved.
 *
 *  The path is normalized (backslashes, trailing separators) because the same
 *  workspace arrives from the backend as `C:\Dev\x` and from the folder picker
 *  as `C:/Dev/x`. */
interface ProjectBucket {
  key: string;
  label: string;
  items: Session[];
}

function groupByProject(items: readonly Session[]): ProjectBucket[] {
  const buckets = new Map<string, ProjectBucket>();
  const noProject: Session[] = [];
  for (const s of items) {
    const path = (s.workspacePath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!path) {
      noProject.push(s);
      continue;
    }
    const existing = buckets.get(path);
    if (existing) existing.items.push(s);
    else
      buckets.set(path, {
        key: path,
        label: folderNameFromPath(path) || path,
        items: [s],
      });
  }
  const out = [...buckets.values()];
  if (noProject.length) out.push({ key: '', label: 'No project', items: noProject });
  return out;
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
  // Which list the sidebar shows. Read AND written again — see the switch's own
  // comment below for what the read-only version cost. Persisted per install
  // (Hermes R1 §3).
  const [railTab, setRailTab] = useState<'sessions' | 'bots'>(() =>
    localStorage.getItem('august-sidebar-tab') === 'bots' ? 'bots' : 'sessions',
  );
  const switchRailTab = (next: 'sessions' | 'bots') => {
    setRailTab(next);
    localStorage.setItem('august-sidebar-tab', next);
  };
  // DeepSeek (R4 §3): "sort by Last updated (remembers choice)". August has
  // no drag order yet, so the remembered choice is Newest | Name.
  //
  // "Newest" now means last activity, which is what this comment used to say it
  // could not mean: `Session` carries `updatedAt` as of 2026-10-17 (the SoT has
  // always sent it; the sidebar just was not reading it), so ordering by
  // `startedAt` was the only option then and would be a quiet lie now — a chat
  // answered this morning would sit under one opened three days ago.
  const [sortBy, setSortBy] = useState<'updated' | 'name'>(() =>
    localStorage.getItem('august-sidebar-sort') === 'name' ? 'name' : 'updated',
  );
  // Deliberately NOT bound to a variable: the `Bots 2` tab badge that used to
  // read it is gone (see the Sessions|Bots switch below), but the query is
  // still worth mounting — it shares `['bots']` with `BotsRail`, so the roster
  // is warm by the time the switch is flipped to Bots. An unassigned call says
  // "prefetch" where `const botsQuery = useQuery(...)` said "dead code", which
  // is what the lint budget reported every run.
  useQuery({ queryKey: ['bots'], queryFn: listBots });
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

  /** One pool's rows, flat or grouped by project.
   *
   *  Both leaf pools (a folder's chats, and the unfiled "Tasks" pool) render
   *  through this. The cap is applied by the caller BEFORE this, so the
   *  shown/total caption above and the group headers describe the same set of
   *  rows. */
  const renderPool = (items: Session[], poolKey: string) => {
    const buckets = groupProjects ? groupByProject(items) : [];
    // A single "No project" bucket is every chat in the pool — a header that
    // labels nothing. Grouping only earns its line when it splits the pool.
    const grouped = buckets.length > 1 || (buckets.length === 1 && buckets[0].key !== '');
    return (
      <AnimatePresence initial={false} mode="popLayout">
        {grouped
          ? buckets.map((group) => (
              <div key={`${poolKey}:${group.key || '-'}`} className="space-y-px">
                <ProjectGroupHeader
                  label={group.label}
                  count={group.items.length}
                  path={group.key || undefined}
                />
                {group.items.map((s) => (
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
          : items.map((s) => (
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
    );
  };

  // Latest render values for the cached per-session row handlers. The handler
  // objects are memoized per session id (so React.memo on SessionRow can bail
  // out on unrelated re-renders), but their bodies must still act on the
  // current onSelect/activeId/pinnedIds — hence the indirection.
  const latest = useRef({ onSelect, onNavigate, activeId, sessions, pinnedIds });
  latest.current = { onSelect, onNavigate, activeId, sessions, pinnedIds };

  /** Confirm + delete; the row leaves the list as soon as the store drops it. */
  const confirmDeleteSession = useCallback(async (s: Session) => {
    const ok = await confirmStyled({
      title: "Delete chat?",
      // HistoryPage and Archive name the composer; this is the third way a chat
      // is deleted and it goes through the same `deleteSession`, which discards
      // whatever is still unsent in that composer along with the transcript.
      // A confirmation that under-describes what it removes is not one.
      message:
        "This permanently deletes the chat, its history and anything still " +
        "unsent in its composer. This cannot be undone.",
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
  /** Live status for a row, keyed by both id forms (the realtime bridge writes
   *  `wb_*`). Local — `statusFor` is re-created every render, so a memo that
   *  closed over it could never bail out. */
  const liveStatus = useCallback(
    (s: Session): SessionStatus | undefined =>
      mergedSessionStates[s.id] ??
      (s.workbenchSessionId ? mergedSessionStates[s.workbenchSessionId] : undefined),
    [mergedSessionStates],
  );
  const isLive = useCallback(
    (st: SessionStatus | undefined) => st === 'working' || st === 'streaming',
    [],
  );

  /** When each live chat was last seen doing work, in ms.
   *
   *  The backend's `updatedAt` only refreshes on the 60s reconcile, which is
   *  too coarse for "two chats are generating, which one moved last". This
   *  stamps a row the moment it starts working (and again whenever the backend
   *  reports newer activity), so the two swap places as they progress. A row
   *  that is not live is ignored entirely — its place comes from the sort
   *  preference, not from this clock. */
  const [activeStamp, setActiveStamp] = useState<Record<string, number>>({});
  useEffect(() => {
    const now = Date.now();
    let next: Record<string, number> | null = null;
    for (const s of sessions) {
      if (!isLive(liveStatus(s))) continue;
      const fromBackend = Date.parse(s.updatedAt || '') || 0;
      const seen = activeStamp[s.id] ?? 0;
      if (seen && fromBackend <= seen) continue;
      (next ??= { ...activeStamp })[s.id] = Math.max(fromBackend, now);
    }
    if (next) setActiveStamp(next);
  }, [sessions, liveStatus, isLive, activeStamp]);

  /** When this chat last moved, in ms — ONE definition, because both the sort
   *  below and the unread test compare against it. The three stamps are merged
   *  with max because each covers a gap in the others: `updatedAt` is the SoT
   *  but only refreshes on the 60s reconcile, `activeStamp` covers the seconds
   *  in between, and `startedAt` is all a local draft that has never synced has.
   *
   *  A second, slightly different recency for "is this unread" would make a row
   *  flip groups for reasons the list order says nothing about. */
  const recencyOf = useCallback(
    (s: Session) =>
      Math.max(
        activeStamp[s.id] ?? 0,
        Date.parse(s.updatedAt || '') || 0,
        Date.parse(s.startedAt || '') || 0,
      ),
    [activeStamp],
  );

  // DeepSeek parity: rows are ordered by the remembered choice — Newest
  // (default) or Name — applied to the unpinned pool. Folders and Pinned keep
  // their own deliberate order.
  //
  // Work in progress leads its OWN pool: a chat that is generating sorts above
  // the idle ones around it, and among several live chats the one that moved
  // most recently leads. This comparator is global but the pool split happens
  // afterwards (othersByFolder), which preserves relative order — so the
  // reordering is per folder and never crosses a folder boundary.
  const others = useMemo(() => {
    const list = visible.filter((s) => !pinnedIds.has(s.id));
    // "Newest first" is LAST ACTIVITY, not creation: a chat you replied to a
    // minute ago belongs at the top even if you opened it last week.
    const recency = recencyOf;
    const live = (x: Session) => isLive(liveStatus(x));
    return list.sort((a, b) => {
      const aLive = live(a);
      const bLive = live(b);
      // Work in progress leads its own pool; among live chats the one that
      // moved most recently leads, which is what makes two generating chats
      // swap places as they progress.
      if (aLive !== bLive) return aLive ? -1 : 1;
      if (aLive && bLive) {
        const delta = recency(b) - recency(a);
        if (delta !== 0) return delta;
      }
      return sortBy === 'name'
        ? (a.title || '').localeCompare(b.title || '')
        : recency(b) - recency(a);
    });
  }, [visible, pinnedIds, sortBy, recencyOf, liveStatus, isLive]);

  // ── New / Read ────────────────────────────────────────────────────────
  // The reference's second group is "Read", which is only a real group because
  // the app also knows which chats you have NOT read. That stamp lives in
  // ./session-read-state.
  const { readMap, markRead, backfill } = useSessionReadState();

  /** Unread = it moved after you last opened it. The chat on screen is never
   *  unread: you are looking at it. */
  const isUnread = useCallback(
    (s: Session) => s.id !== activeId && recencyOf(s) > (readMap[s.id] ?? 0),
    [activeId, readMap, recencyOf],
  );

  // A chat appears in exactly ONE group, so opening one moves it out of New and
  // back into its folder under Read rather than leaving a copy behind.
  const { unreadOthers, readOthers } = useMemo(
    () => ({
      unreadOthers: others.filter(isUnread),
      readOthers: others.filter((s) => !isUnread(s)),
    }),
    [others, isUnread],
  );

  // Chats that predate this feature are stamped with the activity they ALREADY
  // have, so shipping the grouping cannot paint every old chat as new.
  useEffect(() => {
    backfill(visible.map((s) => [s.id, recencyOf(s)] as [string, number]));
  }, [visible, recencyOf, backfill]);

  // Opening a chat reads it — and a reply that lands while it is on screen
  // keeps it read, because the stamp follows `updatedAt`. Without that second
  // half the chat you are watching would announce itself as something you
  // missed the moment it answered.
  const activeUpdatedAt = sessions.find((s) => s.id === activeId)?.updatedAt;
  useEffect(() => {
    if (activeId) markRead(activeId);
  }, [activeId, activeUpdatedAt, markRead]);

  /** Group each pool by project — the workspace a chat runs in — instead of by
   *  date. Persisted per install; ON by default because the pool already
   *  carries folders, and a project header is the one grouping the rows cannot
   *  express themselves.
   *
   *  What this replaced: date headers over an already-recency-ordered list. On
   *  a real 41-chat profile they cost ten rows to label eight sessions and
   *  repeated the relative time every row already prints. `lib/date-group.ts`
   *  stays for the History page, which really is a chronological view. */
  const [groupProjectsPref, setGroupProjectsPref] = useState(
    () => localStorage.getItem('august-sidebar-group-projects') !== '0',
  );
  const changeGroupProjects = (next: boolean) => {
    setGroupProjectsPref(next);
    localStorage.setItem('august-sidebar-group-projects', next ? '1' : '0');
  };
  const groupProjects = groupProjectsPref;

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
      // `deleteUncategorizedSessions` clears each chat's composer draft along
      // with its transcript, so the count has to cover the unsent words too.
      message: `Permanently delete all ${unfiled.length} chat${unfiled.length === 1 ? "" : "s"} in Tasks, with their history and anything still unsent in their composers?`,
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
  // Single pass to bucket the READ pool by folderId (and unfiled) for the JSX
  // below — the previous code called `others.filter(...)` per folder in the
  // render body, which was O(n×folders) on every render.
  const { othersByFolder, unfiledSessions, shownOthers } = useMemo(() => {
    const byFolder = new Map<string, Session[]>();
    const unfiled: Session[] = [];
    for (const s of readOthers) {
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
  }, [readOthers, searching, matchesSearch]);

  const visibleUnread = useMemo(
    () => (searching ? unreadOthers.filter(matchesSearch) : unreadOthers),
    [searching, unreadOthers, matchesSearch],
  );

  // Pool sizes WITHOUT the search filter, for the shown/total caption. Only
  // walked while a filter can actually hide something, so the common
  // (unfiltered) render stays a single pass.
  //
  // The READ pool, not every unpinned chat: a folder's "3 of 5" that counted
  // two chats currently sitting up under New would be a total the reader can
  // never arrive at by looking at that folder.
  const poolTotals = useMemo(() => {
    const byFolder = new Map<string, number>();
    let unfiled = 0;
    if (searching) {
      for (const s of readOthers) {
        if (s.folderId) byFolder.set(s.folderId, (byFolder.get(s.folderId) ?? 0) + 1);
        else unfiled += 1;
      }
    }
    return { byFolder, unfiled };
  }, [searching, readOthers]);

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

  // Keyed on the SORTED ids. The comment here used to claim the key was
  // set-based while `join(',')` kept the render order — so every re-sort by
  // startedAt or title re-ran the batch for the same set of chats.
  // The list is also capped twice over: `capped()` per group for what is
  // rendered, and `usageApi.sessions` bounds the request by id COUNT and by
  // encoded LENGTH. A chat past either bound simply shows no delta, which is
  // the intended degradation of a decorative readout.
  const usageBatchKey = [...usageBatchIds].sort().join(',');
  const usageBySession = useQuery({
    queryKey: ['usage', 'sessions', usageBatchKey],
    queryFn: () => usageApi.sessions(usageBatchKey ? usageBatchKey.split(',') : []),
    enabled: usageBatchKey.length > 0,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });

  // Sidebar usage card — the same /api/usage/stats door the Usage page reads,
  // one 30-day aggregate. It is the only sidebar query that is not per chat.
  const usageStats = useQuery({
    queryKey: ['usage', 'stats', '30d'],
    queryFn: () => usageApi.stats('30d'),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });

  const activeSession = sessions.find(
    (s) => s.id === activeId || s.workbenchSessionId === activeId,
  );
  const activeWorkspacePath = activeSession?.workspacePath ?? null;
  const activeWorkspaceName = activeWorkspacePath
    ? folderNameFromPath(activeWorkspacePath)
    : null;

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
          workspaceName={activeWorkspaceName}
          workspacePath={activeWorkspacePath}
        />

        {/* Sessions | Bots — a two-state switch, and the WRITER for
            `august-sidebar-tab`.

            The three-tab strip (`Sessions | Terminal | Bots`, with a `Bots 2`
            badge) was removed here and STAYS removed: none of the four
            references has a rail tab strip (only KiloCode has tabs, and the
            capture file exempts it from the selection rule); `Terminal` never
            switched the rail — it opened a bottom dock and left Sessions
            showing — and every click threw an uncaught xterm `TypeError`;
            `Bots 2` printed a number the roster header already printed, from
            the same `['bots']` query; and the sort control that used to sit in
            this tablist was not a `role="tab"`, which `d4d383f1` moved out
            because axe fails a tablist containing anything else.

            What the removal left behind was worse than the strip. `railTab`
            was still READ by both branches and never written, and `BotsRail`
            is rendered on the `bots` branch and NOWHERE else in the app (a
            repo-wide `<BotsRail` search finds this call site and its own
            tests). So the read-only version meant: every install whose key was
            not already 'bots' had no door at all to the roster, its create-Bot
            modal, its hidden-Bot toggles and its rooms — and an install that
            HAD persisted 'bots' could never see its chats again. The previous
            comment here claimed "the bot roster likewise" survived via the
            Workbench drawer; that is true of the per-Bot routines pane
            (`[bot:<name>]`), which needs a Bot id, and false of the roster.

            Both halves are the same missing setter, and this is it: two states,
            no Terminal, no count badge, and the session search below renders
            only for the sessions view (the roster carries its own), so nothing
            in either state is inert. */}
        <div className="flex items-center gap-1 px-1.5 pt-1.5" role="tablist" aria-label="Sidebar view">
          <Button
            type="button"
            role="tab"
            variant="ghost"
            size="sm"
            aria-selected={railTab === 'sessions'}
            onClick={() => switchRailTab('sessions')}
            data-testid="sidebar-tab-sessions"
            // `Button` for the focus ring it carries; padding and colours are
            // overridden because a view switch is a tab, not a form action.
            className={cn(
              'px-2 py-1 transition-colors',
              railTab === 'sessions'
                ? 'bg-sidebar-accent/70 text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-foreground'
                : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground',
            )}
          >
            Sessions
          </Button>
          <Button
            type="button"
            role="tab"
            variant="ghost"
            size="sm"
            aria-selected={railTab === 'bots'}
            onClick={() => switchRailTab('bots')}
            data-testid="sidebar-tab-bots"
            className={cn(
              'px-2 py-1 transition-colors',
              railTab === 'bots'
                ? 'bg-sidebar-accent/70 text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-foreground'
                : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground',
            )}
          >
            Bots
          </Button>
        </div>

        {/* Session search — filters titles across Pinned / folders / task.
            Sessions view only: `searchQuery` filters the session store, so on
            the Bots view it would be a text box that does nothing (the roster
            has its own). */}
        {railTab === 'sessions' && (
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
        )}

        {/* Scrollable sessions area — denser, drawer-only simplicity */}
        {railTab === 'sessions' && (
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
              <div className="flex items-center gap-1.5 px-1 pb-1 text-2xs font-medium text-warning-fg">
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

          {/* New renders only when something actually moved since you last
              opened it — same rule the Pinned heading follows, and the reason
              the heading below can honestly be called "Read". */}
          {visibleUnread.length > 0 && (
            <Section title="New" count={visibleUnread.length}>
              <LayoutGroup id="unread-sessions">
                <AnimatePresence initial={false} mode="popLayout">
                  {visibleUnread.map((s) => (
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
              </LayoutGroup>
            </Section>
          )}

          <Section
            title="Recent"
            count={searching ? shownOthers : readOthers.length}
            viewOptions={{
              sortBy,
              onSortChange: (next) => {
                setSortBy(next);
                localStorage.setItem('august-sidebar-sort', next);
              },
              groupProjects: groupProjectsPref,
              onGroupProjectsChange: changeGroupProjects,
            }}
            onNewFolder={handleCreateFolder}
            onUploadFolder={(e) => { void handleFolderUploadClick(e); }}
          >
            <div className="space-y-1.5">
              <ShownOfTotal shown={shownOthers} total={readOthers.length} />
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
                        {/* Cap FIRST, group second: the ShownOfTotal caption
                            above must stay honest about what is on screen, and
                            project headers over a truncated list would describe
                            rows that were never rendered. */}
                        {renderPool(renderable, `folder:${folder.id}`)}
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
                        {/* Cap FIRST, group second — same rule as the folder
                            pool above, so the caption and the headers agree
                            about what is actually on screen. */}
                        {renderPool(renderableUnfiled, 'unfiled')}
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
        )}

        {/* Bots view — the roster owns the sidebar while the switch above is
            on Bots. It is the roster's only render site in the app. */}
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

        {/* Usage strip + identity — the mockup's sidebar footer. The usage
            number is the same 30-day aggregate the Usage page reads, not a
            second accounting of the per-row deltas. */}
        <div className="px-2 pb-1.5 pt-2 border-t border-sidebar-border/40">
          <div className="rounded-lg border border-sidebar-border/45 bg-sidebar-accent/20 px-2.5 py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[0.625rem] text-sidebar-foreground/45">Last 30 days</span>
              <span className="font-mono text-[0.75rem] tabular-nums text-sidebar-foreground">
                {usageStats.data ? formatCompactTokens(usageStats.data.totalTokens) : '—'}
              </span>
            </div>
            <div className="mt-0.5 text-[0.625rem] text-sidebar-foreground/35">
              tokens{usageStats.data ? ` · ${usageStats.data.sessions} chats` : ''}
            </div>
          </div>
        </div>

        {/* Bottom: user identity row — Claude-style username + avatar icon
            that opens the selection list (profile / settings / notifications /
            what's-new / account). Falls back to Guest when signed out. */}
        <div className="px-2 pb-2 pt-1 border-t border-sidebar-border/40">
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
                  <div className="min-w-0 flex-1 text-[0.78125rem]">
                    <span className="block truncate font-medium text-sidebar-foreground">{dropdownUser.name}</span>
                    <span className="block truncate text-[0.625rem] text-sidebar-foreground/40">
                      {signedIn ? 'Signed in' : 'Local workspace'}
                    </span>
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
