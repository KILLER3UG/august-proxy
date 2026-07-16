import { useState, useEffect, useRef } from "react";
import {
  Volume2,
  Minus,
  Square,
  X,
  PanelLeft,
  PanelLeftClose,
  Settings,
  GitBranch,
  Download,
  Minimize2,
  MoreHorizontal,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { gitApi } from "@/api/git";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri-detect";
import { toast } from "sonner";
import { RightDrawerDropdown } from "./RightDrawerLauncher";
import { BrainIndicator } from "./BrainIndicator";
import { MarqueeTitle } from "@/components/ui/MarqueeTitle";
import type { Session } from "@/store/sessions";
import type { RightDrawerSectionId } from "./RightDrawerState";

interface ChatTitlebarProps {
  session: Session | null;
  sidebarCollapsed: boolean;
  rightDrawerOpen: boolean;
  onToggleSidebar: () => void;
  onSelectRightDrawerSection: (section: RightDrawerSectionId) => void;
  onSettings: () => void;
}

export function ChatTitlebar({
  session,
  sidebarCollapsed,
  rightDrawerOpen,
  onToggleSidebar,
  onSelectRightDrawerSection,
  onSettings,
}: ChatTitlebarProps) {
  const [speaking, setSpeaking] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [updateAvailable, setUpdateAvailable] = useState<{
    version: string;
  } | null>(null);
  const [updating, setUpdating] = useState(false);

  const branch = useQuery({
    queryKey: ['git', 'branch', session?.id],
    queryFn: () => gitApi.branch(session?.id),
    refetchInterval: 30_000,
    retry: false,
  });
  const currentBranch = branch.data?.current;

  useEffect(() => {
    if (!overflowOpen) return;
    const onDown = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverflowOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [overflowOpen]);

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
  }, /* eslint-disable-line react-hooks/exhaustive-deps */ []);

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

  // ── Auto-update check (Tauri only) ──
  useEffect(() => {
    if (!isTauri) return;
    void (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (update) {
          setUpdateAvailable({ version: update.version });
        }
      } catch {
        // Silently ignore — update check is best-effort
      }
    })();
  }, /* eslint-disable-line react-hooks/exhaustive-deps */ []);

  const handleInstallUpdate = async () => {
    if (!isTauri || !updateAvailable) return;
    setUpdating(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        await update.downloadAndInstall();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message || "Failed to install update");
      setUpdating(false);
    }
  };

  const speakLatest = () => {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const lastMessage = sessionStorage.getItem("august_last_assistant_message");
    if (!lastMessage) {
      toast.info("No message to read");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(lastMessage);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  };

  return (
    <header data-tauri-drag-region className="h-11 bg-background flex items-center justify-between shrink-0 select-none border-b border-border/20">
      <div className="flex items-center min-w-0">
        <button
          onClick={onToggleSidebar}
          className="size-11 flex items-center justify-center shrink-0 hover:bg-accent text-muted-foreground/70 hover:text-foreground transition"
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          {sidebarCollapsed ? (
            <PanelLeftClose className="size-3.5" />
          ) : (
            <PanelLeft className="size-3.5" />
          )}
        </button>

        {updateAvailable && (
          <button
            onClick={() => { void handleInstallUpdate(); }}
            disabled={updating}
            className="flex items-center gap-1.5 px-2 py-0.5 mx-1 text-[11px] font-medium
              bg-amber-500/15 text-amber-400 hover:bg-amber-500/25
              rounded-md transition disabled:opacity-50"
            title={`Update to v${updateAvailable.version}`}
          >
            <Download className="size-3" />
            {updating ? "Updating…" : `v${updateAvailable.version}`}
          </button>
        )}

        <div className="flex items-center gap-1.5 px-1.5 min-w-0 max-w-[min(48vw,32rem)]">
          <h1 className="text-[13px] font-medium text-foreground/90 min-w-0 flex-1">
            <MarqueeTitle
              text={session?.title ?? "New chat"}
              data-testid="session-bar-title"
              className="w-full"
            />
          </h1>
        </div>
      </div>

      <div className="flex items-center gap-0.5">
        <button
          onClick={onSettings}
          className="p-1.5 hover:bg-accent rounded-md text-muted-foreground/60 hover:text-foreground transition"
          title="Open settings"
        >
          <Settings className="size-3.5" />
        </button>

        <RightDrawerDropdown drawerOpen={rightDrawerOpen} onSelect={onSelectRightDrawerSection} />

        {/* Secondary actions: branch, brain, TTS */}
        <div ref={overflowRef} className="relative">
          <button
            type="button"
            onClick={() => setOverflowOpen((v) => !v)}
            className={cn(
              "p-1.5 hover:bg-accent rounded-md transition",
              overflowOpen
                ? "bg-accent text-foreground"
                : "text-muted-foreground/60 hover:text-foreground",
            )}
            title="More"
            aria-expanded={overflowOpen}
            aria-haspopup="menu"
          >
            <MoreHorizontal className="size-3.5" />
          </button>

          {overflowOpen && (
            <div
              role="menu"
              className="absolute top-full mt-1 right-0 z-50 min-w-[200px] rounded-lg border border-border/50 bg-popover shadow-xl py-1 origin-top-right"
            >
              {currentBranch && (
                <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground font-mono border-b border-border/30 mb-0.5">
                  <GitBranch size={11} className="shrink-0 opacity-70" />
                  <span className="truncate" title={currentBranch}>{currentBranch}</span>
                </div>
              )}

              <div className="flex items-center gap-2 px-2 py-1">
                <span className="text-[12px] text-muted-foreground pl-1 flex-1">Brain</span>
                <BrainIndicator />
              </div>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  speakLatest();
                  setOverflowOpen(false);
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition",
                  speaking
                    ? "text-primary"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                )}
              >
                <Volume2 className={cn("size-3.5", speaking && "animate-pulse")} />
                {speaking ? "Stop reading" : "Read aloud"}
              </button>
            </div>
          )}
        </div>

        <div className="h-3.5 w-px bg-border/30 mx-1" />

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
            {isMaximized ? <Minimize2 className="size-3" /> : <Square className="size-2.5" />}
          </button>
          <button
            onClick={() => { void handleClose(); }}
            className="w-[42px] h-[28px] flex items-center justify-center text-muted-foreground/70 hover:bg-red-500 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
