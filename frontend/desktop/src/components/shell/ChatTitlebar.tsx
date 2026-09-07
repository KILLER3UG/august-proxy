import { useState, useEffect } from "react";
import {
  Minus,
  Square,
  X,
  PanelLeftClose,
  Minimize2,
  Folder,
  MoreHorizontal,
  Pencil,
  Copy,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri-detect";
import { revealInFolder } from "@/lib/tauri-shell";
import { renameSession } from "@/store/sessions";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { RightDrawerDropdown } from "./RightDrawerLauncher";
import { MarqueeTitle } from "@/components/ui/MarqueeTitle";
import { WorkspaceBranchChip } from "@/components/workspace/WorkspaceBranchChip";
import type { Session } from "@/store/sessions";
import type { RightDrawerSectionId } from "./RightDrawerState";

interface ChatTitlebarProps {
  session: Session | null;
  sidebarCollapsed: boolean;
  rightDrawerOpen: boolean;
  onToggleSidebar: () => void;
  onSelectRightDrawerSection: (section: RightDrawerSectionId) => void;
  workersBadge?: number;
}

export function ChatTitlebar({
  session,
  sidebarCollapsed,
  rightDrawerOpen,
  onToggleSidebar,
  onSelectRightDrawerSection,
  workersBadge = 0,
}: ChatTitlebarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  // ── Window controls (Tauri only) ──
  useEffect(() => {
    if (!isTauri) return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        setIsMaximized(await win.isMaximized());
      } catch { /* silent */ }
    })();
  }, []);

  const handleMinimize = async () => {
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch { /* silent */ }
  };

  const handleToggleMaximize = async () => {
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.toggleMaximize();
      setIsMaximized(await win.isMaximized());
    } catch { /* silent */ }
  };

  const handleClose = async () => {
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch { /* silent */ }
  };

  return (
    <header data-tauri-drag-region className="august-titlebar h-11 bg-background flex items-center justify-between shrink-0 select-none border-b border-border/20">
      <div className="flex items-center min-w-0">
        {sidebarCollapsed && (
          <button
            onClick={onToggleSidebar}
            className="size-11 flex items-center justify-center shrink-0 hover:bg-accent text-muted-foreground/70 hover:text-foreground transition"
            title="Show sidebar"
            aria-label="Show sidebar"
          >
            <PanelLeftClose className="size-3.5" />
          </button>
        )}

        <div className={cn(
          "flex items-center gap-1.5 min-w-0 max-w-[min(48vw,32rem)]",
          sidebarCollapsed ? "px-1.5" : "pl-3 pr-1.5",
        )}>
          <h1 className="text-[13px] font-medium text-foreground/90 min-w-0 flex-1">
            <MarqueeTitle
              text={session?.title ?? "New chat"}
              data-testid="session-bar-title"
              className="w-full"
            />
          </h1>
          {/* Folder chip — the bound workspace's basename (ZCode parity:
              folder glyph + name, click reveals it in Explorer). Sits before
              the branch chip; hidden for chats without a bound folder. */}
          {session?.workspacePath ? (
            <button
              type="button"
              onClick={() => { void revealInFolder(session.workspacePath || ''); }}
              className="shrink-0 inline-flex items-center gap-1 h-6 px-1.5 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title={session.workspacePath}
              aria-label="Open workspace folder"
              data-testid="titlebar-folder-chip"
            >
              <Folder className="size-3" />
              <span className="max-w-[10rem] truncate">{session.workspacePath.split(/[\\/]/).filter(Boolean).pop()}</span>
            </button>
          ) : null}
          {/* Branch selector — also for sessions without a bound folder:
              the chip falls back to the app's current workspace path and
              hides itself when nothing resolves to a git work tree. */}
          {session ? (
            <WorkspaceBranchChip
              sessionId={session.id}
              repoPath={session.workspacePath || undefined}
              className="shrink-0"
              menuPlacement="down"
            />
          ) : null}
          {/* Session menu (ZCode's …): folder reveal, path copy, rename. */}
          {session ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="shrink-0 size-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  title="Session menu"
                  aria-label="Session menu"
                  data-testid="titlebar-session-menu"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-44">
                <DropdownMenuItem
                  onClick={() => {
                    void revealInFolder(session.workspacePath || '');
                  }}
                  disabled={!session.workspacePath}
                >
                  <ExternalLink className="size-3.5 mr-1.5" /> Open workspace folder
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    if (!session.workspacePath) return;
                    void navigator.clipboard.writeText(session.workspacePath);
                    toast.success('Workspace path copied');
                  }}
                  disabled={!session.workspacePath}
                >
                  <Copy className="size-3.5 mr-1.5" /> Copy workspace path
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    const next = window.prompt('Rename chat', session.title ?? '');
                    const trimmed = next?.trim();
                    if (trimmed && trimmed !== session.title) renameSession(session.id, trimmed);
                  }}
                >
                  <Pencil className="size-3.5 mr-1.5" /> Rename chat…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-0.5">
        <RightDrawerDropdown
          drawerOpen={rightDrawerOpen}
          onSelect={onSelectRightDrawerSection}
          workersBadge={workersBadge}
        />

        {/* Windows-style title bar buttons */}
        <div className="flex items-stretch">
          <button
            onClick={() => { void handleMinimize(); }}
            className="w-[42px] h-[28px] flex items-center justify-center text-muted-foreground/70 hover:bg-white/10 transition-colors"
            aria-label="Minimize"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            onClick={() => { void handleToggleMaximize(); }}
            className="w-[42px] h-[28px] flex items-center justify-center text-muted-foreground/70 hover:bg-white/10 transition-colors"
            aria-label={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? <Minimize2 className="size-3" /> : <Square className="size-3" />}
          </button>
          <button
            onClick={() => { void handleClose(); }}
            className="w-[46px] h-[28px] flex items-center justify-center text-muted-foreground/70 hover:bg-red-500 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
