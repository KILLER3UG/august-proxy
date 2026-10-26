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
  Search,
  Sun,
  Moon,
  PanelRight,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri-detect";
import { revealInFolder } from "@/lib/tauri-shell";
import { renameSession, useSessionsStore } from "@/store/sessions";
import { SETTINGS_SECTIONS } from "@/settings/settings-registry";
import { toggleCommandPalette } from "@/store/command-palette";
import { setThemeMode, useThemeStore } from "@/lib/theme";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { RightDrawerDropdown } from "./RightDrawerLauncher";
import { closeRightDrawer, openRightDrawer, useRightDrawer } from "./RightDrawerState";
import { BackgroundJobsButton } from "./BackgroundJobsButton";
import { MarqueeTitle } from "@/components/ui/MarqueeTitle";
import { useSessionStream } from '@/sections/chat/hooks/useSessionStream';
import { collectArtifacts } from '@/lib/artifacts';
import type { Session } from "@/store/sessions";

interface ChatTitlebarProps {
  session: Session | null;
  sidebarCollapsed: boolean;
  rightDrawerOpen: boolean;
  onToggleSidebar: () => void;
  workersBadge?: number;
}

export function ChatTitlebar({
  session,
  sidebarCollapsed,
  rightDrawerOpen,
  onToggleSidebar,
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

  const workspaceName = useMemo(() => {
    const path = session?.workspacePath;
    if (!path) return null;
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? null;
  }, [session?.workspacePath]);

  const sessionStatus = useSessionsStore((state) =>
    session ? state.sessionStates[session.id] : undefined,
  );
  const live =
    sessionStatus === 'streaming' ||
    sessionStatus === 'working' ||
    sessionStatus === 'awaiting';

  const themeMode = useThemeStore((state) => state.mode);
  const drawer = useRightDrawer();
  const canvasActive = drawer.open && drawer.activeSection === 'canvas';
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  const effectiveTheme = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode;
  const toggleTheme = () => setThemeMode(effectiveTheme === 'dark' ? 'light' : 'dark');

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
      "/learning": "Learning",
      "/artifacts": "Artifacts",
      "/charts": "Charts",
      "/docs": "Docs",
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
      <div className="flex items-center min-w-0 gap-1.5" data-tauri-drag-region>
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

        <div className="hidden xl:flex items-center gap-0.5 text-muted-foreground/50">
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
          "flex items-center gap-1.5 min-w-0 max-w-[min(54vw,42rem)] pl-1",
        )}>
          {workspaceName && (
            <div className="hidden lg:flex items-center gap-1.5 shrink-0 text-[0.75rem] text-muted-foreground/55">
              <Folder className="size-3 opacity-70" />
              <div className="max-w-[10rem] truncate" title={session?.workspacePath || workspaceName}>
                {workspaceName}
              </div>
              <span className="text-muted-foreground/30">/</span>
            </div>
          )}
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
          {live && (
            <span className="ml-1 inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border/50 px-2 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-muted-foreground/65">
              <span className="size-1.5 rounded-full bg-primary" aria-hidden />
              Live
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => toggleCommandPalette()}
          className="hidden sm:inline-flex h-8 items-center gap-2 rounded-md border border-border/45 bg-card/30 px-2.5 text-muted-foreground/65 transition-colors hover:bg-accent hover:text-foreground"
          title="Search or run a command (Ctrl+K)"
          aria-label="Search or run"
          aria-keyshortcuts="Control+K"
        >
          <Search className="size-3.5 shrink-0" />
          <span className="hidden min-[1180px]:inline text-[0.75rem]">Search or run</span>
          <kbd className="border-border/50 bg-transparent text-[0.625rem] text-muted-foreground/45">⌘K</kbd>
        </Button>
        <Button
          type="button"
          variant={canvasActive ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => {
            if (canvasActive) closeRightDrawer();
            else openRightDrawer('canvas');
          }}
          className="h-8 items-center gap-1.5 rounded-md px-2 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
          title="Canvas"
          aria-label="Canvas"
          aria-pressed={canvasActive}
        >
          <PanelRight className="size-3.5" />
          <span className="hidden min-[1180px]:inline text-[0.75rem]">Canvas</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={toggleTheme}
          className="size-8 rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground"
          title={effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {effectiveTheme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
        </Button>
        {/* The global door to the background job tray. It renders nothing when
            there is no job, so the chrome stays quiet. */}
        <BackgroundJobsButton />
        <RightDrawerDropdown
          drawerOpen={rightDrawerOpen}
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
