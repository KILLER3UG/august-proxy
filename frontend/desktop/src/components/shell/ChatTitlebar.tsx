import { useState, useEffect, useMemo } from "react";
import { PromptDialog } from '@/components/overlays/PromptDialog';
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
import { useSessionStream } from '@/sections/chat/hooks/useSessionStream';
import { collectArtifacts } from '@/lib/artifacts';
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
  // Rename goes through PromptDialog — window.prompt is a silent no-op in
  // some Tauri webviews and unstyled next to every other dialog.
  const [renameOpen, setRenameOpen] = useState(false);
  const location = useLocation();
  const stream = useSessionStream(session?.id ?? null);
  const artifactsCount = useMemo(
    () => collectArtifacts(stream?.messages ?? []).length,
    [stream?.messages],
  );

  /* Route-aware title (2026-09-16 UI scan B2): the bar used to render
   * `session?.title ?? "New chat"` on EVERY route, so Board/Runs/History/
   * Settings all wore a stale chat title (and Tauri inherits this label as
   * the OS window title). Session titles stay only on chat routes. */
  const barTitle = useMemo(() => {
    /* React Router matches case-INSENSITIVELY, and this comparison was not, so
     * `/Settings/general` opened the dialog correctly while the bar — and the OS
     * window title Tauri inherits from it — read "Settings" for General and
     * "August" for any other section. Section ids are lowercase by construction,
     * so lowercasing the segment loses no real case. */
    const path = location.pathname;
    const lowered = path.toLowerCase();
    if (path === "/" || lowered.startsWith("/c/")) return session?.title ?? "New chat";
    if (lowered.startsWith("/settings")) {
      const section = path.split("/")[2]?.toLowerCase();
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
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        setIsMaximized(await win.isMaximized());
        // External maximize (Win+Up, drag-to-edge, double-click on the drag
        // region) never routes through this component's toggle, so the
        // restore glyph stayed stale (2026-10-03 audit A1 §2).
        unlisten = await win.onResized(async () => {
          if (disposed) return;
          try {
            setIsMaximized(await win.isMaximized());
          } catch { /* silent */ }
        });
      } catch { /* silent */ }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
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
      className="august-titlebar h-[var(--shell-titlebar-h)] bg-background flex items-center justify-between shrink-0 select-none border-b border-border/25 px-2"
    >
      <div className="flex items-center min-w-0 gap-1" data-tauri-drag-region>
        {sidebarCollapsed && (
          <button
            onClick={onToggleSidebar}
            className="size-8 rounded-md flex items-center justify-center shrink-0 hover:bg-accent text-muted-foreground/80 hover:text-foreground transition mr-0.5"
            title="Show sidebar"
            aria-label="Show sidebar"
          >
            <PanelLeftClose className="size-3" />
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
            <ChevronLeft className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => window.history.forward()}
            className="size-7 rounded flex items-center justify-center hover:bg-accent hover:text-foreground transition"
            title="Forward"
            aria-label="Forward"
          >
            <ChevronRight className="size-3" />
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
                  title="Session menu" aria-label="Session menu"
                  data-testid="titlebar-session-trigger"
                >
                  <h1 className="text-[0.8125rem] font-medium text-foreground/90 min-w-0 truncate">
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
                <DropdownMenuItem onClick={() => setRenameOpen(true)}>
                  <Pencil className="size-3 mr-2" /> Rename chat…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void revealInFolder(session.workspacePath || '');
                  }}
                  disabled={!session.workspacePath}
                >
                  <ExternalLink className="size-3 mr-2" /> Open workspace folder
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    if (!session.workspacePath) return;
                    void navigator.clipboard.writeText(session.workspacePath);
                    toast.success('Workspace path copied');
                  }}
                  disabled={!session.workspacePath}
                >
                  <Copy className="size-3 mr-2" /> Copy workspace path
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <h1 className="text-[0.8125rem] font-medium text-foreground/90 min-w-0 flex-1 px-1">
              <MarqueeTitle
                text={barTitle}
                data-testid="session-bar-title"
                className="w-full"
              />
            </h1>
          )}

        </div>
      </div>

      <div className="flex items-center gap-1">
        <RightDrawerDropdown
          drawerOpen={rightDrawerOpen}
          onSelect={onSelectRightDrawerSection}
          workersBadge={workersBadge}
          artifactsCount={artifactsCount}
        />

        {/* Windows-style title bar buttons — Tauri only (dead no-ops in the
            mobile WebView). One height token, one width, token hover fills. */}
        {isTauri && (
          <div className="flex items-stretch ml-1 -mr-2 h-[var(--shell-titlebar-h)]">
            <button
              onClick={() => { void handleMinimize(); }}
              className="w-10 flex items-center justify-center text-muted-foreground/70 hover:bg-accent transition-colors"
              aria-label="Minimize"
            >
              <Minus className="size-3" />
            </button>
            <button
              onClick={() => { void handleToggleMaximize(); }}
              className="w-10 flex items-center justify-center text-muted-foreground/70 hover:bg-accent transition-colors"
              aria-label={isMaximized ? "Restore" : "Maximize"}
            >
              {isMaximized ? <Minimize2 className="size-3" /> : <Square className="size-3" />}
            </button>
            <button
              onClick={() => { void handleClose(); }}
              className="w-10 flex items-center justify-center text-muted-foreground/70 hover:bg-danger hover:text-danger-foreground transition-colors"
              aria-label="Close"
            >
              <X className="size-3" />
            </button>
          </div>
        )}
      </div>
      {session && (
        <PromptDialog
          open={renameOpen}
          title="Rename chat"
          label="Chat name"
          initialValue={session.title ?? ''}
          confirmLabel="Rename"
          onSubmit={(title) => {
            if (title !== session.title) renameSession(session.id, title);
            setRenameOpen(false);
          }}
          onCancel={() => setRenameOpen(false)}
        />
      )}
    </header>
  );
}
