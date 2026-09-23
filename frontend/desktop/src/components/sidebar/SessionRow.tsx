/* ── Session row — title, status pulse, pin, and kebab actions ─────── */

import { useState, useEffect, useRef, memo, useId } from "react";
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
import { useNeedsAttention } from "./needs-handoff-store";
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
  const attention = useNeedsAttention(session.id);
  const needsHandoff = attention?.needs ?? 0;
  const [showMenu, setShowMenu] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(session.title);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

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
      <button
        onClick={() => {
          if (status === "done") clearSessionStatus(session.id);
          onClick();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onTogglePin();
        }}
        className="relative w-full text-left px-2.5 py-1.5 flex flex-col gap-0.5 pr-8 min-w-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        title="Right click or use three-dots menu to pin"
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
              "flex-1 min-w-0 session-list-title text-[12.5px]",
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
          {/* Plan §5.2: relative date in the list, absolute on hover. */}
          {session.startedAt && (
            <span
              className="shrink-0 text-xs tabular-nums text-tier-2 transition-colors group-hover:text-tier-1"
              title={absoluteDate(session.startedAt)}
              data-testid="session-row-date"
            >
              {timeAgo(session.startedAt)}
            </span>
          )}
          {needsHandoff > 0 && (
            <span
              className="inline-block size-1.5 rounded-full bg-warning shrink-0"
              title={`${needsHandoff} workstream${needsHandoff === 1 ? "" : "s"} need${needsHandoff === 1 ? "s" : ""} a handoff`}
              aria-label={`${needsHandoff} workstream${needsHandoff === 1 ? "" : "s"} need${needsHandoff === 1 ? "s" : ""} a handoff`}
            />
          )}
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
            setShowMenu((v) => !v);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
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
