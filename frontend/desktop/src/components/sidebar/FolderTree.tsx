/* ── Folder tree — section labels, collapsible folders, Other Chats ── */

import { useState } from "react";
import {
  Plus,
  MessageSquare,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  Edit3,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Folder } from "@/store/sessions";

/** Section header for PINNED / SESSIONS with optional folder create actions. */
export function Section({
  title,
  count,
  empty,
  onNewFolder,
  onUploadFolder,
  children,
}: {
  title: string;
  count: number;
  empty?: string;
  onNewFolder?: () => void;
  onUploadFolder?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 px-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[11px] uppercase tracking-caps text-muted-foreground/75 font-semibold">
            {title}
          </h3>
          <span className="text-xs text-muted-foreground/50 font-mono">
            ({count})
          </span>
        </div>
        {title === "SESSIONS" && onNewFolder && onUploadFolder && (
          <div className="flex items-center gap-1">
            <button
              onClick={onUploadFolder}
              className="text-muted-foreground/50 hover:text-foreground p-0.5 rounded transition hover:bg-white/5"
              title="Open Workspace Folder"
            >
              <FolderPlus className="size-3" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onNewFolder();
              }}
              className="text-muted-foreground/50 hover:text-foreground p-0.5 rounded transition hover:bg-white/5"
              title="Create Sidebar Folder"
            >
              <Plus className="size-3" />
            </button>
          </div>
        )}
      </div>
      {count === 0 && title === "PINNED" ? (
        <p className="px-2 py-1 text-xs text-muted-foreground/40 italic">
          {empty ?? "No items"}
        </p>
      ) : (
        <div className="space-y-0.5">{children}</div>
      )}
    </div>
  );
}

export interface FolderHeaderProps {
  folder: Folder;
  count: number;
  hasActiveSession?: boolean;
  onToggleCollapse: () => void;
  onNewSession: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/** Collapsible folder row with new-session, rename, and delete on hover. */
export function FolderHeader({
  folder,
  count,
  hasActiveSession: _hasActiveSession,
  onToggleCollapse,
  onNewSession,
  onRename,
  onDelete,
}: FolderHeaderProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-white/5 cursor-pointer group text-sidebar-foreground/80 font-medium"
      onClick={onToggleCollapse}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={cn(
            "size-1 rounded-full shrink-0 transition-colors",
            folder.isCollapsed ? "bg-muted-foreground/40" : "bg-primary",
          )}
        />
        {folder.isCollapsed ? (
          <FolderIcon className="size-3.5 text-muted-foreground/70 shrink-0" />
        ) : (
          <FolderOpen className="size-3.5 text-muted-foreground/70 shrink-0" />
        )}
        <span className="truncate text-sm font-semibold text-foreground/85">
          {folder.name}
        </span>
        <span className="text-xs text-muted-foreground/50 font-mono">
          ({count})
        </span>
      </div>
      <div
        className="flex items-center gap-0.5 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        {isHovered && (
          <>
            <button
              onClick={onNewSession}
              className="p-0.5 hover:bg-white/10 rounded text-muted-foreground hover:text-foreground"
              title={`New session in ${folder.name}`}
            >
              <Plus className="size-2.5" />
            </button>
            <button
              onClick={onRename}
              className="p-0.5 hover:bg-white/10 rounded text-muted-foreground hover:text-foreground"
              title="Rename Folder"
            >
              <Edit3 className="size-2.5" />
            </button>
            <button
              onClick={onDelete}
              className="p-0.5 hover:bg-white/10 rounded text-destructive hover:text-destructive-foreground"
              title="Delete Folder"
            >
              <Trash2 className="size-2.5" />
            </button>
          </>
        )}
        <span
          className={cn(
            "size-3.5 flex items-center justify-center rounded transition-all duration-150",
            folder.isCollapsed
              ? "rotate-0 text-muted-foreground/60"
              : "rotate-90 text-muted-foreground/60",
            !isHovered && "opacity-60",
          )}
        >
          <ChevronRight className="size-3" />
        </span>
      </div>
    </div>
  );
}

/** Collapsible header for sessions that are not in any folder. */
export function UncategorizedHeader({
  count,
  isCollapsed,
  onToggleCollapse,
}: {
  count: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-white/5 cursor-pointer group text-sidebar-foreground/80 font-medium"
      onClick={onToggleCollapse}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={cn(
            "size-1 rounded-full shrink-0 transition-colors",
            isCollapsed ? "bg-muted-foreground/40" : "bg-primary",
          )}
        />
        <MessageSquare className="size-3.5 text-muted-foreground/70 shrink-0" />
        <span className="truncate text-sm font-semibold text-foreground/85">
          Other Chats
        </span>
        <span className="text-xs text-muted-foreground/50 font-mono">
          ({count})
        </span>
      </div>
      <span
        className={cn(
          "size-3.5 flex items-center justify-center rounded transition-all duration-150 shrink-0",
          isCollapsed
            ? "rotate-0 text-muted-foreground/60"
            : "rotate-90 text-muted-foreground/60",
          "opacity-60 group-hover:opacity-100",
        )}
      >
        <ChevronRight className="size-3" />
      </span>
    </div>
  );
}
