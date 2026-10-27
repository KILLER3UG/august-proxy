import { useState, useEffect, useMemo } from "react";
import { PromptDialog } from '@/components/overlays/PromptDialog';
import { useLocation } from "react-router-dom";
import { Pencil, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { isTauri } from "@/lib/tauri-detect";
import { revealInFolder } from "@/lib/tauri-shell";
import { renameSession, useSessionsStore } from "@/store/sessions";
import { routeLabelFor } from "@/lib/route-labels";
import { toggleCommandPalette } from "@/store/command-palette";
import { setThemeMode, useThemeStore } from "@/lib/theme";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { RightDrawerDropdown } from "./RightDrawerLauncher";
import { closeRightDrawer, openRightDrawer, useRightDrawer } from "./RightDrawerState";
import { BackgroundJobsButton } from "./BackgroundJobsButton";
import { MarqueeTitle } from "@/components/ui/MarqueeTitle";
import { Button } from "@/components/ui/button";
import { SignalIcon } from "@/components/ui/SignalIcon";
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
   * the OS window title). Session titles stay only on chat routes.
   *
   * The rules live in lib/route-labels now, because the phone topbar prints
   * the same title: `/Settings/general` has to read "Settings · General" on
   * both chromes, and a second copy of this table is how one of them ends up
   * saying "August". */
  const barTitle = useMemo(
    () => routeLabelFor(location.pathname, session?.title),
    [location.pathname, session?.title],
  );


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
    <header data-tauri-drag-region className="titlebar">
      <div className="titlebar-left" data-tauri-drag-region>
        {sidebarCollapsed && (
          <Button variant="bare"
            type="button"
            onClick={onToggleSidebar}
            className="icon-button"
            title="Show sidebar"
            aria-label="Show sidebar"
          >
            <SignalIcon name="panel" />
          </Button>
        )}

        <div className="crumbs">
          {workspaceName ? (
            <>
              <span className="crumb-muted" title={session?.workspacePath || workspaceName}>
                {workspaceName}
              </span>
              <span className="crumb-slash">/</span>
            </>
          ) : null}
          {session ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="bare"
                  type="button"
                  className="crumb-title"
                  title="Session menu"
                  aria-label="Session menu"
                  data-testid="titlebar-session-trigger"
                >
                  <strong>
                    <MarqueeTitle text={barTitle} data-testid="session-bar-title" className="w-full" />
                  </strong>
                  <SignalIcon name="chev" />
                </Button>
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
            <strong className="crumb-title-static">
              <MarqueeTitle text={barTitle} data-testid="session-bar-title" className="w-full" />
            </strong>
          )}
        </div>

        {live && (
          <span className="live-pill">
            <span className="live-dot" />
            Live
          </span>
        )}
      </div>

      <div className="titlebar-actions">
        <Button variant="bare"
          type="button"
          className="cmd-button"
          onClick={() => toggleCommandPalette()}
          title="Search or run a command (Ctrl+K)"
          aria-label="Search or run"
          aria-keyshortcuts="Control+K"
        >
          <SignalIcon name="search" />
          <span>Search or run</span>
          <kbd>⌘K</kbd>
        </Button>

        <Button variant="bare"
          type="button"
          className="canvas-toggle"
          data-open={canvasActive}
          onClick={() => {
            if (canvasActive) closeRightDrawer();
            else openRightDrawer('canvas');
          }}
          title="Canvas"
          aria-label="Canvas"
          aria-pressed={canvasActive}
        >
          <SignalIcon name="panel" />
          Canvas
        </Button>

        <Button variant="bare"
          type="button"
          className="icon-button"
          onClick={toggleTheme}
          title={effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={effectiveTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          <SignalIcon name={effectiveTheme === 'dark' ? 'sun' : 'moon'} />
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
            mobile WebView). */}
        {isTauri && (
          <div className="window-controls">
            <Button variant="bare" onClick={() => { void handleMinimize(); }} aria-label="Minimize">
              <SignalIcon name="window-min" />
            </Button>
            <Button variant="bare"
              onClick={() => { void handleToggleMaximize(); }}
              aria-label={isMaximized ? 'Restore' : 'Maximize'}
            >
              <SignalIcon name="window-max" />
            </Button>
            <Button variant="bare" className="close" onClick={() => { void handleClose(); }} aria-label="Close">
              <SignalIcon name="close" />
            </Button>
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
