/* ── Session row — title, status pulse, pin, and kebab actions ─────── */

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Pin,
  MoreHorizontal,
  Folder as FolderIcon,
  ChevronRight,
  Edit3,
  Trash2,
  Archive,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { sessionRow, hoverScale } from "@/lib/motion";
import { MarqueeTitle } from "@/components/ui/MarqueeTitle";
import {
  clearSessionStatus,
  type Session,
  type Folder,
  type SessionStatus,
} from "@/store/sessions";
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
export function SessionRow({
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
  const [showMenu, setShowMenu] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(session.title);

  useEffect(() => {
    if (!showMenu) return;
    const handleClose = () => setShowMenu(false);
    window.addEventListener("click", handleClose);
    return () => window.removeEventListener("click", handleClose);
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
          className="bg-white/[0.04] border border-white/[0.08] px-1.5 py-0.5 rounded text-[12.5px] w-full outline-none text-sidebar-foreground"
        />
      </motion.div>
    );
  }

  const hasStatus = status && status !== "idle";

  return (
    <motion.div
      layout
      variants={sessionRow}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn(
        "group relative rounded-md overflow-hidden",
        active ? "bg-white/[0.05]" : "hover:bg-white/[0.03]",
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
        className="relative w-full text-left px-2 py-1 flex flex-col gap-0.5 pr-10 min-w-0"
        title="Right click or use three-dots menu to pin"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {hasStatus && (
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
          )}
          {pinned && (
            <Pin className="size-2.5 text-sidebar-foreground/35 shrink-0" />
          )}
          {session.workspacePath && (
            <FolderIcon className="size-3 text-sidebar-foreground/30 shrink-0" />
          )}
          <div
            className={cn(
              "flex-1 min-w-0 session-list-title",
              active
                ? "text-sidebar-foreground"
                : "text-sidebar-foreground/65",
            )}
          >
            <MarqueeTitle
              text={session.title}
              data-testid="session-list-title"
              className="w-full"
            />
          </div>
        </div>
        <AnimatePresence>
          {status === "streaming" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center gap-1 ml-3 overflow-hidden"
            >
              <span className="text-xs text-warning/80 font-medium">
                {modelDisplayParts(session.model).name}
              </span>
              <motion.span
                className="text-xs text-warning/60 font-medium"
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 1.5, repeat: Infinity }}
              >
                running in background
              </motion.span>
            </motion.div>
          )}
          {status === "working" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center gap-1 ml-3 overflow-hidden"
            >
              <span className="text-xs text-warning/80 font-medium">
                {modelDisplayParts(session.model).name}
              </span>
              <span className="text-xs text-warning/50">is</span>
              <span className="flex items-center gap-px">
                {["w", "o", "r", "k", "i", "n", "g"].map((ch, i) => (
                  <motion.span
                    key={i}
                    className="text-xs text-warning/70 font-medium inline-block"
                    animate={{ opacity: [0.3, 1, 0.3], y: [1, -1, 1] }}
                    transition={{
                      duration: 0.8,
                      repeat: Infinity,
                      delay: i * 0.08,
                    }}
                  >
                    {ch}
                  </motion.span>
                ))}
              </span>
            </motion.div>
          )}
          {status === "done" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center gap-1 ml-3 overflow-hidden"
            >
              <span className="text-xs text-success/80 font-medium">
                {modelDisplayParts(session.model).name}
              </span>
              <motion.span
                className="text-xs text-success/60 font-medium"
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 1.5, repeat: Infinity }}
              >
                done
              </motion.span>
            </motion.div>
          )}
          {status === "error" && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center gap-1 ml-3 overflow-hidden"
            >
              <span className="text-xs text-danger/80 font-medium">
                {modelDisplayParts(session.model).name}
              </span>
              <span className="text-xs text-danger/60 font-medium">
                error
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </button>

      {/* Pin and kebab — hover-revealed controls on the session row */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "absolute right-1 top-1/2 -translate-y-1/2 transition-opacity flex items-center gap-px z-40",
          active || showMenu ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <motion.button
          onClick={onTogglePin}
          whileHover={hoverScale.whileHover}
          whileTap={hoverScale.whileTap}
          className="p-0.5 hover:bg-white/[0.06] rounded"
          aria-label={pinned ? "Unpin" : "Pin"}
        >
          <Pin
            className={cn(
              "size-2.5 text-sidebar-foreground/40 hover:text-sidebar-foreground/70",
              pinned && "text-sidebar-foreground/60",
            )}
          />
        </motion.button>
        <motion.button
          onClick={() => setShowMenu(!showMenu)}
          whileHover={hoverScale.whileHover}
          whileTap={hoverScale.whileTap}
          className="p-0.5 hover:bg-white/[0.06] rounded"
          aria-label="More options"
        >
          <MoreHorizontal className="size-2.5 text-sidebar-foreground/40 hover:text-sidebar-foreground/70" />
        </motion.button>
      </div>

      {/* Kebab menu — pin, rename, move to folder, archive, delete */}
      {showMenu && (
        <div
          className="absolute right-1 top-7 z-50 w-36 bg-popover rounded-md shadow-2xl py-1 text-xs animate-in fade-in slide-in-from-top-1 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              onTogglePin();
              setShowMenu(false);
            }}
            className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-foreground/90 transition"
          >
            <Pin className="size-3 text-muted-foreground" />
            {pinned ? "Unpin Chat" : "Pin Chat"}
          </button>

          <button
            onClick={() => {
              setIsEditing(true);
              setShowMenu(false);
            }}
            className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-foreground/90 transition"
          >
            <Edit3 className="size-3 text-muted-foreground" />
            Rename Chat
          </button>

          {/* Nested list of folders to move this session into */}
          <div className="relative group/sub">
            <button className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center justify-between gap-1.5 text-foreground/90 transition">
              <span className="flex items-center gap-1.5">
                <FolderIcon className="size-3 text-muted-foreground" />
                Move to Folder
              </span>
              <ChevronRight className="size-2.5 text-muted-foreground" />
            </button>
            <div className="absolute left-full top-0 ml-0.5 hidden group-hover/sub:block w-32 bg-popover rounded-md shadow-2xl py-1 z-50 animate-in fade-in slide-in-from-left-1 duration-100">
              <button
                onClick={() => {
                  onMoveToFolder(null);
                  setShowMenu(false);
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
                  onClick={() => {
                    onMoveToFolder(f.id);
                    setShowMenu(false);
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
          </div>

          <button
            onClick={() => {
              onArchive();
              setShowMenu(false);
            }}
            className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-warning hover:text-warning/80 transition"
          >
            <Archive className="size-3 text-warning/80" />
            Archive Chat
          </button>

          <div className="h-[1px] bg-border/40 my-1" />

          <button
            onClick={() => {
              onDelete();
              setShowMenu(false);
            }}
            className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-destructive hover:text-destructive/90 transition"
          >
            <Trash2 className="size-3 text-destructive/80" />
            Delete Chat
          </button>
        </div>
      )}
    </motion.div>
  );
}
