import { useState, useEffect } from "react";
import {
  Minus,
  Square,
  X,
  PanelLeftClose,
  Minimize2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri-detect";
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
