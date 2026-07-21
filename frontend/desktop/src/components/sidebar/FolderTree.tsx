/* ── Folder tree — section labels, collapsible folders, Other Chats ── */

import { useState } from "react";
import {
  Plus,
  FolderPlus,
  ChevronRight,
  Edit3,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Folder } from "@/store/sessions";
import { WorkspaceBranchChip } from "@/components/workspace/WorkspaceBranchChip";

/** Section header for PINNED / RECENTS with optional folder create actions. */
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
      <div className="flex items-center justify-between mb-1 px-2">
        <div className="flex items-center gap-1">
          <h3 className="text-[11px] text-sidebar-foreground/40 font-normal">
            {title}
          </h3>
          {count > 0 && (
            <span className="text-[10px] text-sidebar-foreground/25 tabular-nums">
              {count}
            </span>
          )}
        </div>
        {(title === "Sessions" || title === "Recents" || title === "Repositories") && onNewFolder && onUploadFolder && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={onUploadFolder}
              className="text-sidebar-foreground/30 hover:text-sidebar-foreground/55 p-0.5 rounded transition-colors hover:bg-white/[0.03]"
              title="Open Workspace Folder"
            >
              <FolderPlus className="size-3" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onNewFolder();
              }}
              className="text-sidebar-foreground/30 hover:text-sidebar-foreground/55 p-0.5 rounded transition-colors hover:bg-white/[0.03]"
              title="Create Sidebar Folder"
            >
              <Plus className="size-3" />
            </button>
          </div>
        )}
      </div>
      {count === 0 && title === "Pinned" ? (
        <p className="px-2 py-0.5 text-[11px] text-sidebar-foreground/30">
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
  /** Session id used for git branch lookups when the folder is a workspace. */
  branchSessionId?: string | null;
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
  branchSessionId,
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
      className="flex items-center justify-between py-0.5 px-2 rounded-md hover:bg-white/[0.03] cursor-pointer group text-sidebar-foreground/55"
      onClick={onToggleCollapse}
    >
      <div className="flex items-center gap-1 min-w-0">
        <span
          className={cn(
            "flex items-center justify-center shrink-0 transition-transform duration-150 text-sidebar-foreground/35",
            folder.isCollapsed ? "rotate-0" : "rotate-90",
          )}
        >
          <ChevronRight className="size-3" />
        </span>
        <span className="truncate text-[12.5px] text-sidebar-foreground/60 group-hover:text-sidebar-foreground/80">
          {folder.name}
        </span>
        {folder.workspacePath ? (
          <span
            className="min-w-0 shrink"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <WorkspaceBranchChip
              sessionId={branchSessionId}
              repoPath={folder.workspacePath}
              className="scale-90 origin-left"
              menuPlacement="down"
            />
          </span>
        ) : null}
        {count > 0 && (
          <span className="text-[10px] text-sidebar-foreground/25 tabular-nums shrink-0">
            {count}
          </span>
        )}
      </div>
      <div
        className={cn(
          "flex items-center gap-0.5 shrink-0 transition-opacity",
          // Keep "+" visible on workspace folders so multi-chat-per-project is obvious.
          folder.workspacePath || isHovered ? "opacity-100" : "opacity-0",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onNewSession}
          className={cn(
            "p-0.5 hover:bg-white/[0.06] rounded text-sidebar-foreground/40 hover:text-sidebar-foreground/70",
            folder.workspacePath && "text-sidebar-foreground/55",
          )}
          title={`New chat in ${folder.name}`}
          aria-label={`New chat in ${folder.name}`}
        >
          <Plus className="size-2.5" />
        </button>
        <button
          onClick={onRename}
          className="p-0.5 hover:bg-white/[0.06] rounded text-sidebar-foreground/40 hover:text-sidebar-foreground/70"
          title="Rename Folder"
        >
          <Edit3 className="size-2.5" />
        </button>
        <button
          onClick={onDelete}
          className="p-0.5 hover:bg-white/[0.06] rounded text-destructive/70 hover:text-destructive"
          title="Delete Folder"
        >
          <Trash2 className="size-2.5" />
        </button>
      </div>
    </div>
  );
}

/** Collapsible header for sessions that are not in any folder. */
export function UncategorizedHeader({
  count,
  isCollapsed,
  onToggleCollapse,
  onDelete,
}: {
  count: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between py-0.5 px-2 rounded-md hover:bg-white/[0.03] cursor-pointer group text-sidebar-foreground/55"
      onClick={onToggleCollapse}
    >
      <div className="flex items-center gap-1 min-w-0">
        <span
          className={cn(
            "flex items-center justify-center shrink-0 transition-transform duration-150 text-sidebar-foreground/35",
            isCollapsed ? "rotate-0" : "rotate-90",
          )}
        >
          <ChevronRight className="size-3" />
        </span>
        <span className="truncate text-[12.5px] text-sidebar-foreground/60 group-hover:text-sidebar-foreground/80">
          Other chats
        </span>
        {count > 0 && (
          <span className="text-[10px] text-sidebar-foreground/25 tabular-nums shrink-0">
            {count}
          </span>
        )}
      </div>
      {count > 0 && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          className="p-0.5 rounded text-destructive/70 hover:bg-white/[0.06] hover:text-destructive"
          title="Delete all other chats"
          aria-label="Delete all other chats"
        >
          <Trash2 className="size-2.5" />
        </button>
      )}
    </div>
  );
}
