import { useState, useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import {
  Minus,
  Square,
  X,
  PanelLeftClose,
  Minimize2,
  Folder,
  Pencil,
  Copy,
  ExternalLink,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Share2,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri-detect";
import { revealInFolder } from "@/lib/tauri-shell";
import { renameSession } from "@/store/sessions";
import { SETTINGS_SECTIONS } from "@/settings/settings-registry";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
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
  const location = useLocation();

  /* Route-aware title (2026-09-16 UI scan B2): the bar used to render
   * `session?.title ?? "New chat"` on EVERY route, so Board/Runs/History/
   * Settings all wore a stale chat title (and Tauri inherits this label as
   * the OS window title). Session titles stay only on chat routes. */
  const barTitle = useMemo(() => {
    const path = location.pathname;
    if (path === "/" || path.startsWith("/c/")) return session?.title ?? "New chat";
    if (path.startsWith("/settings")) {
      const section = path.split("/")[2];
      if (!section) return "Settings";
      const hit = SETTINGS_SECTIONS.find((s) => s.id === section);
      return hit ? `Settings · ${hit.label}` : "Settings";
    }
    const routeLabels: Record<string, string> = {
      "/automations": "Automations",
      "/runs": "Runs",
      "/board": "Board",
      "/live": "Live",
      "/history": "History",
      "/_design": "Design system",
    };
    return routeLabels[path] ?? "August";
  }, [location.pathname, session?.title]);


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
    <header
      data-tauri-drag-region
      className="august-titlebar h-10 bg-background flex items-center justify-between shrink-0 select-none border-b border-border/25 px-2"
    >
      <div className="flex items-center min-w-0 gap-1" data-tauri-drag-region>
        {sidebarCollapsed && (
          <button
            onClick={onToggleSidebar}
            className="size-8 rounded-md flex items-center justify-center shrink-0 hover:bg-accent text-muted-foreground/80 hover:text-foreground transition mr-0.5"
            title="Show sidebar"
            aria-label="Show sidebar"
          >
            <PanelLeftClose className="size-3.5" />
          </button>
        )}

        <div className="flex items-center gap-0.5 text-muted-foreground/60">
          <button
            type="button"
            onClick={() => window.history.back()}
            className="size-7 rounded flex items-center justify-center hover:bg-accent hover:text-foreground transition"
            title="Back"
            aria-label="Back"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => window.history.forward()}
            className="size-7 rounded flex items-center justify-center hover:bg-accent hover:text-foreground transition"
            title="Forward"
            aria-label="Forward"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>

        <div className={cn(
          "flex items-center gap-1.5 min-w-0 max-w-[min(48vw,32rem)] pl-1",
        )}>
          {session ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="group flex items-center gap-1 px-2 py-1 rounded-md hover:bg-accent/60 text-left transition-colors min-w-0"
                  title="Session menu"
                  data-testid="titlebar-session-trigger"
                >
                  <h1 className="text-[13px] font-medium text-foreground/90 min-w-0 truncate">
                    <MarqueeTitle
                      text={barTitle}
                      data-testid="session-bar-title"
                      className="w-full"
                    />
                  </h1>
                  <ChevronDown className="size-3 text-muted-foreground/70 group-hover:text-foreground shrink-0 transition-transform" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-48">
                <DropdownMenuItem
                  onClick={() => {
                    const next = window.prompt('Rename chat', session.title ?? '');
                    const trimmed = next?.trim();
                    if (trimmed && trimmed !== session.title) renameSession(session.id, trimmed);
                  }}
                >
                  <Pencil className="size-3.5 mr-2" /> Rename chat…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void revealInFolder(session.workspacePath || '');
                  }}
                  disabled={!session.workspacePath}
                >
                  <ExternalLink className="size-3.5 mr-2" /> Open workspace folder
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    if (!session.workspacePath) return;
                    void navigator.clipboard.writeText(session.workspacePath);
                    toast.success('Workspace path copied');
                  }}
                  disabled={!session.workspacePath}
                >
                  <Copy className="size-3.5 mr-2" /> Copy workspace path
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <h1 className="text-[13px] font-medium text-foreground/90 min-w-0 flex-1 px-1">
              <MarqueeTitle
                text={barTitle}
                data-testid="session-bar-title"
                className="w-full"
              />
            </h1>
          )}

          {/* Folder chip */}
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

          {/* Branch selector */}
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

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onSelectRightDrawerSection('artifacts')}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md hover:bg-accent text-xs text-muted-foreground hover:text-foreground transition"
          title="Open Artifacts"
        >
          <FileText className="size-3.5" />
          <span>Artifacts</span>
        </button>

        <button
          type="button"
          onClick={() => {
            if (session) {
              void navigator.clipboard.writeText(window.location.href);
              toast.success('Chat link copied to clipboard');
            }
          }}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md hover:bg-accent text-xs text-muted-foreground hover:text-foreground transition"
          title="Share / Copy Link"
        >
          <Share2 className="size-3.5" />
          <span>Share</span>
        </button>

        <RightDrawerDropdown
          drawerOpen={rightDrawerOpen}
          onSelect={onSelectRightDrawerSection}
          workersBadge={workersBadge}
        />

        {/* Windows-style title bar buttons */}
        <div className="flex items-stretch ml-1 -mr-2">
          <button
            onClick={() => { void handleMinimize(); }}
            className="w-[38px] h-10 flex items-center justify-center text-muted-foreground/70 hover:bg-white/10 transition-colors"
            aria-label="Minimize"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            onClick={() => { void handleToggleMaximize(); }}
            className="w-[38px] h-10 flex items-center justify-center text-muted-foreground/70 hover:bg-white/10 transition-colors"
            aria-label={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? <Minimize2 className="size-3" /> : <Square className="size-3" />}
          </button>
          <button
            onClick={() => { void handleClose(); }}
            className="w-[42px] h-10 flex items-center justify-center text-muted-foreground/70 hover:bg-red-500 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
