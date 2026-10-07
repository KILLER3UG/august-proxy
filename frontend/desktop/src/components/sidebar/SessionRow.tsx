/* ── Session row — title, status pulse, pin, and kebab actions ─────── */

import { useState, useEffect, useRef, memo, useId } from "react";
import { useNeedsAttention } from './needs-handoff-store';
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Pin,
  EllipsisVertical,
  Folder as FolderIcon,
  ChevronRight,
  Edit3,
  Trash2,
  Archive,
} from "lucide-react";
import { cn, timeAgo, absoluteDate } from "@/lib/utils";
import { sessionRow, hoverScale } from "@/lib/motion";
import { MarqueeTitle } from "@/components/ui/MarqueeTitle";
import {
  clearSessionStatus,
  type Session,
  type Folder,
  type SessionStatus,
} from "@/store/sessions";
import {
  selectSessionLiveActivity,
  useLiveActivityStore,
} from "@/store/liveActivity";
import { modelDisplayParts } from "@/sections/chat/ChatThread";

export interface SessionRowProps {
  session: Session;
  active: boolean;
  pinned: boolean;
  status?: SessionStatus;
  folders: Folder[];
  onClick: () => void;
  onTogglePin: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onMoveToFolder: (folderId: string | null) => void;
  onDelete: () => void;
}

/* ── Hover / focus preview (DeepSeek R4: title + relative time + one status
 *  word beside the row) ───────────────────────────────────────────────────
 *  The card reads ONLY what the row already receives as props — no fetch, no
 *  extra store subscription. Geometry lives here so the flip/clamp math and the
 *  card width cannot drift apart. */
const PREVIEW_W = 268;
const PREVIEW_H = 132;
/** Long enough to skip the cards that flash past while the pointer travels the
 *  list, short enough to feel instant once it stops. */
const PREVIEW_DELAY_MS = 220;

const STATUS_WORD: Record<SessionStatus, string> = {
  idle: "Idle",
  working: "Working",
  streaming: "Streaming",
  done: "Done",
  awaiting: "Waiting for you",
  error: "Error",
};

/** Same token families as the row's own status dot, so the card and the row
 *  can never disagree about what a session is doing. */
const STATUS_DOT: Record<SessionStatus, string> = {
  idle: "bg-sidebar-foreground/35",
  working: "bg-warning",
  streaming: "bg-warning animate-pulse",
  done: "bg-success",
  awaiting: "bg-info",
  error: "bg-danger",
};

/** One chat in the sidebar list: status, title, pin control, and actions menu. */
function SessionRowInner({
  session,
  active,
  pinned,
  status,
  folders,
  onClick,
  onTogglePin,
  onRename,
  onArchive,
  onMoveToFolder,
  onDelete,
}: SessionRowProps) {
  const liveHeadline = useLiveActivityStore(
    (s) => selectSessionLiveActivity(s, session.id).headline,
  );
  const [showMenu, setShowMenu] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(session.title);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const attention = useNeedsAttention(session.id);
  const needsHandoff = attention?.needs ?? 0;
  const kebabRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  /* ── Preview card state ─────────────────────────────────────────────── */
  const [previewPos, setPreviewPos] = useState<{ top: number; left: number } | null>(null);
  const previewTimer = useRef<number | null>(null);
  const previewId = `${menuId}-preview`;

  const hidePreview = () => {
    if (previewTimer.current) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    setPreviewPos(null);
  };

  const schedulePreview = () => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      const el = rowRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Beside the row, never over it: the row's own kebab (z-40) and its
      // portal menu (z-100) stay uncovered, and the card is pointer-events-none
      // so it cannot swallow a click even where it overlaps.
      let left = r.right + 10;
      let top = r.top;
      if (left + PREVIEW_W > window.innerWidth - 8) {
        // No room outside the sidebar (docked right, narrow window): drop BELOW
        // the row rather than covering its action menu.
        left = Math.max(8, Math.min(r.left, window.innerWidth - PREVIEW_W - 8));
        top = r.bottom + 6;
      }
      setPreviewPos({
        top: Math.max(8, Math.min(top, window.innerHeight - PREVIEW_H - 8)),
        left,
      });
    }, PREVIEW_DELAY_MS);
  };

  // The pending timer must not fire into an unmounted row.
  useEffect(
    () => () => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
    },
    [],
  );

  /* A fixed card does not scroll with the list — dismiss it rather than leave
   * it floating over a row that has moved away. */
  useEffect(() => {
    if (!previewPos) return;
    const onMove = () => hidePreview();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [previewPos]);

  const closeMenu = () => {
    setShowMenu(false);
    kebabRef.current?.focus();
  };

  useEffect(() => {
    if (!showMenu) {
      setFolderOpen(false);
      return;
    }

    const previouslyFocused = document.activeElement;
    const place = () => {
      const el = kebabRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const menuW = 144;
      const left = Math.min(
        Math.max(8, r.right - menuW),
        window.innerWidth - menuW - 8,
      );
      setMenuPos({ top: r.bottom + 4, left });
    };
    place();
    const focusTimer = window.setTimeout(() => {
      menuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus();
    }, 0);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || kebabRef.current?.contains(t)) return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowMenu(false);
        if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
        return;
      }
      if (e.key === "ArrowDown" && document.activeElement === kebabRef.current) {
        e.preventDefault();
        setShowMenu(true);
        return;
      }
      if (!menuRef.current?.contains(e.target as Node)) return;
      if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
      e.preventDefault();
      const items = Array.from(
        menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      );
      if (items.length === 0) return;
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex = e.key === "ArrowDown"
        ? (currentIndex + 1 + items.length) % items.length
        : (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showMenu]);

  const handleSaveRename = () => {
    if (editTitle.trim() && editTitle.trim() !== session.title) {
      onRename(editTitle.trim());
    }
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <motion.div
        layout
        variants={sessionRow}
        initial="initial"
        animate="animate"
        exit="exit"
        className="w-full px-2 py-0.5 flex items-center gap-1.5 overflow-hidden"
      >
        <input
          autoFocus
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSaveRename();
            if (e.key === "Escape") {
              setEditTitle(session.title);
              setIsEditing(false);
            }
          }}
          onBlur={handleSaveRename}
          onClick={(e) => e.stopPropagation()}
          className="bg-white/[0.04] border border-white/[0.08] px-1.5 py-0.5 rounded text-xs w-full outline-none text-sidebar-foreground"
        />
      </motion.div>
    );
  }

  const hasStatus = status && status !== "idle";

  /* ── Preview payload: everything below is already on `session` / props ── */
  const previewStatusWord =
    needsHandoff > 0 ? "Needs handoff" : STATUS_WORD[status ?? "idle"];
  const previewDotClass =
    needsHandoff > 0 ? "bg-warning" : STATUS_DOT[status ?? "idle"];
  const previewFolder = session.folderId
    ? folders.find((f) => f.id === session.folderId)?.name
    : undefined;
  const previewTime = timeAgo(session.startedAt);
  // Rows restored from an older localStorage shape can lack the counter (the
  // schema field is optional), and "0 messages" would then state a fact that
  // was never measured — absence renders as no count at all.
  const previewMessages = Number.isFinite(session.messageCount) ? session.messageCount : null;

  const preview =
    previewPos && !showMenu
      ? createPortal(
          <div
            id={previewId}
            role="tooltip"
            className="pointer-events-none fixed z-[95] w-[268px] animate-in fade-in zoom-in-95 duration-100 rounded-lg border border-border/60 bg-popover px-3 py-2 shadow-2xl"
            style={{ top: previewPos.top, left: previewPos.left }}
            data-testid="session-row-preview"
          >
            <p className="line-clamp-2 text-xs font-medium leading-snug text-popover-foreground">
              {session.title || "Untitled"}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-2xs tabular-nums text-muted-foreground">
              <span className={cn("size-1.5 shrink-0 rounded-full", previewDotClass)} aria-hidden />
              <span>{previewStatusWord}</span>
              {previewTime ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{previewTime}</span>
                </>
              ) : null}
            </p>
            {(previewMessages !== null || previewFolder) && (
              <p className="mt-0.5 text-2xs tabular-nums text-muted-foreground/70">
                {previewMessages === null
                  ? null
                  : previewMessages === 1
                    ? '1 message'
                    : `${previewMessages} messages`}
                {previewFolder
                  ? `${previewMessages === null ? '' : ' · '}${previewFolder}`
                  : null}
              </p>
            )}
            {session.lastMessage ? (
              <p className="mt-1 line-clamp-2 text-2xs leading-snug text-muted-foreground/80">
                {session.lastMessage}
              </p>
            ) : null}
          </div>,
          document.body,
        )
      : null;

  const menu =
    showMenu &&
    menuPos &&
    createPortal(
      <div
        ref={menuRef}
        role="menu"
        id={menuId}
        className="fixed z-[100] w-36 bg-popover rounded-md shadow-2xl border border-border/50 py-1 text-xs animate-in fade-in zoom-in-95 duration-100"
        style={{ top: menuPos.top, left: menuPos.left }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onTogglePin();
            closeMenu();
          }}
          className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-foreground/90 transition"
        >
          <Pin className="size-3 text-muted-foreground" />
          {pinned ? "Unpin Chat" : "Pin Chat"}
        </button>

        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setIsEditing(true);
            closeMenu();
          }}
          className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-foreground/90 transition"
        >
          <Edit3 className="size-3 text-muted-foreground" />
          Rename Chat
        </button>

        <div className="relative">
          <button
            type="button"
            role="menuitem"
            onClick={() => setFolderOpen((v) => !v)}
            className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center justify-between gap-1.5 text-foreground/90 transition"
          >
            <span className="flex items-center gap-1.5">
              <FolderIcon className="size-3 text-muted-foreground" />
              Move to Folder
            </span>
            <ChevronRight
              className={cn(
                "size-2.5 text-muted-foreground transition-transform",
                folderOpen && "rotate-90",
              )}
            />
          </button>
          {folderOpen && (
            <div className="mt-0.5 mx-1 mb-1 max-h-40 overflow-y-auto rounded-md border border-border/40 bg-popover/95 py-1">
              <button
                type="button"
                onClick={() => {
                  onMoveToFolder(null);
                  closeMenu();
                }}
                className={cn(
                  "w-full text-left px-2.5 py-1 hover:bg-white/5 truncate transition",
                  !session.folderId
                    ? "text-primary font-medium"
                    : "text-foreground/80",
                )}
              >
                No Folder
              </button>
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    onMoveToFolder(f.id);
                    closeMenu();
                  }}
                  className={cn(
                    "w-full text-left px-2.5 py-1 hover:bg-white/5 truncate transition",
                    session.folderId === f.id
                      ? "text-primary font-medium"
                      : "text-foreground/80",
                  )}
                  title={f.name}
                >
                  {f.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onArchive();
            closeMenu();
          }}
          className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-warning hover:text-warning/80 transition"
        >
          <Archive className="size-3 text-warning/80" />
          Archive Chat
        </button>

        <div className="h-[1px] bg-border/40 my-1" />

        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onDelete();
            closeMenu();
          }}
          className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-destructive hover:text-destructive/90 transition"
        >
          <Trash2 className="size-3 text-destructive/80" />
          Delete Chat
        </button>
      </div>,
      document.body,
    );

  return (
    <motion.div
      layout
      variants={sessionRow}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn(
        "august-session-row group relative rounded-md",
        active ? "august-session-row-active bg-white/[0.05]" : "hover:bg-white/[0.03]",
      )}
    >
      {/* Preview triggers: hover AND keyboard focus, Escape to dismiss. Deliberately
          no native `title=` on this row — a browser tooltip cannot be styled,
          themed, timed or read on demand, and it would fight the card. The pin
          gesture its old `title` advertised is now taught by the Pinned empty
          state in SessionList. */}
      <button
        ref={rowRef}
        onClick={() => {
          if (status === "done") clearSessionStatus(session.id);
          hidePreview();
          onClick();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onTogglePin();
        }}
        onMouseEnter={schedulePreview}
        onMouseLeave={hidePreview}
        onFocus={schedulePreview}
        onBlur={hidePreview}
        onKeyDown={(e) => {
          if (e.key === "Escape") hidePreview();
        }}
        aria-describedby={previewPos ? previewId : undefined}
        className="relative w-full text-left px-2.5 py-1.5 flex flex-col gap-0.5 pr-8 min-w-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <div className="flex items-center gap-2 min-w-0">
          {hasStatus ? (
            <span
              className={cn(
                "inline-block size-1.5 rounded-full shrink-0 transition-colors",
                status === "working" && "bg-warning",
                status === "streaming" && "bg-warning animate-pulse",
                status === "done" && "bg-success",
                status === "awaiting" && "bg-info",
                status === "error" && "bg-danger",
              )}
            />
          ) : active ? (
            <span className="inline-block size-1.5 rounded-full bg-sidebar-foreground shrink-0" />
          ) : (
            <span className="inline-block size-1.5 rounded-full border border-sidebar-foreground/35 shrink-0" />
          )}
          {session.workspacePath && (
            <FolderIcon className="size-3 text-tier-3 shrink-0" />
          )}
          <div
            className={cn(
              "flex-1 min-w-0 session-list-title text-[0.78125rem]",
              active
                ? "font-medium text-sidebar-foreground"
                : "text-sidebar-foreground/70 group-hover:text-sidebar-foreground",
            )}
          >
            <MarqueeTitle
              text={session.title}
              data-testid="session-list-title"
              className="w-full"
            />
          </div>
          {/* DeepSeek parity: a pending human interaction REPLACES the
              timestamp with its own warning label (R4 §3: "pending
              interactions replace the timestamp with a warning dot +
              label"). The date returns the moment nothing is pending. */}
          {needsHandoff > 0 ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-warning/15 px-1 text-2xs font-medium text-warning-fg"
              title={`${needsHandoff} workstream${needsHandoff === 1 ? '' : 's'} need${needsHandoff === 1 ? 's' : ''} a handoff`}
              data-testid="session-row-needs-handoff"
            >
              <span className="size-1.5 rounded-full bg-warning" aria-hidden />
              Needs handoff
            </span>
          ) : session.startedAt ? (
            <span
              className="shrink-0 text-xs tabular-nums text-tier-2 transition-colors group-hover:text-tier-1"
              title={absoluteDate(session.startedAt)}
              data-testid="session-row-date"
            >
              {timeAgo(session.startedAt)}
            </span>
          ) : null}

        </div>
        <AnimatePresence>
          {(status === "working" || status === "streaming") && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center gap-1.5 ml-3 min-w-0 overflow-hidden"
              data-slot="session-live-status"
            >
              <span className="text-xs text-warning/80 font-medium shrink-0">
                {modelDisplayParts(session.model).name}
              </span>
              <span className="text-xs text-warning/40 shrink-0" aria-hidden>
                ·
              </span>
              <span
                className="text-xs text-warning/65 font-medium truncate session-list-meta"
                title={liveHeadline || undefined}
              >
                {liveHeadline?.trim() ||
                  (status === "streaming"
                    ? "Running in background"
                    : "Working…")}
              </span>
            </motion.div>
          )}
          {status === "done" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center gap-1.5 ml-3 min-w-0 overflow-hidden"
            >
              <span className="text-xs text-success/80 font-medium shrink-0">
                {modelDisplayParts(session.model).name}
              </span>
              <span className="text-xs text-success/40 shrink-0" aria-hidden>
                ·
              </span>
              <span className="text-xs text-success/60 font-medium">Done</span>
            </motion.div>
          )}
          {status === "error" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center gap-1.5 ml-3 min-w-0 overflow-hidden"
            >
              <span className="text-xs text-danger/80 font-medium shrink-0">
                {modelDisplayParts(session.model).name}
              </span>
              <span className="text-xs text-danger/40 shrink-0" aria-hidden>
                ·
              </span>
              <span className="text-xs text-danger/60 font-medium">Error</span>
            </motion.div>
          )}
        </AnimatePresence>
      </button>

      {/* Kebab — hover-revealed controls on the session row */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "absolute right-1 top-1/2 -translate-y-1/2 z-40 flex items-center gap-px opacity-100 transition-opacity focus-within:opacity-100",
        )}
      >
        <motion.button
          ref={kebabRef}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            // The action menu wins: never let the preview sit under it.
            hidePreview();
            setShowMenu((v) => !v);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              hidePreview();
              setShowMenu(true);
            }
          }}
          whileHover={hoverScale.whileHover}
          whileTap={hoverScale.whileTap}
          className="rounded p-0.5 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          aria-label="More options"
          aria-expanded={showMenu}
          aria-haspopup="menu"
          aria-controls={menuId}
        >
          <EllipsisVertical className="size-2.5 text-tier-2 transition hover:text-tier-1" />
        </motion.button>
      </div>

      {menu}
      {preview}
    </motion.div>
  );
}

/**
 * memoized wrapper — SessionList now passes a stable handler map (keyed by
 * session id) so the only re-render triggers are actual session/status/folder
 * changes. The shallow comparator is enough; the callback references in
 * `handlers` are stable per-session-id from SessionList's cached map.
 */
export const SessionRow = memo(SessionRowInner);
