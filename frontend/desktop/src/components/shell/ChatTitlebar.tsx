import { useState, useEffect } from "react";
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
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { gitApi } from "@/api/git";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri-detect";
import { toast } from "sonner";
import { RightDrawerDropdown } from "./RightDrawerLauncher";
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

  // ── Window controls (Tauri only) ──
  useEffect(() => {
    if (!isTauri) return;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        setIsMaximized(await win.isMaximized());
      } catch {}
    })();
  }, [isTauri]);

  const handleMinimize = async () => {
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch {}
  };

  const handleToggleMaximize = async () => {
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.toggleMaximize();
      setIsMaximized(await win.isMaximized());
    } catch {}
  };

  const handleClose = async () => {
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {}
  };

  // ── Auto-update check (Tauri only) ──
  useEffect(() => {
    if (!isTauri) return;
    (async () => {
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
  }, [isTauri]);

  const handleInstallUpdate = async () => {
    if (!isTauri || !updateAvailable) return;
    setUpdating(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        await update.downloadAndInstall();
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to install update");
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
    <header data-tauri-drag-region className="h-12 bg-background flex items-center justify-between shrink-0 select-none">
      <div className="flex items-center min-w-0">
        <button
          onClick={onToggleSidebar}
          className="size-12 flex items-center justify-center shrink-0 hover:bg-accent text-muted-foreground hover:text-foreground transition"
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          {sidebarCollapsed ? (
            <PanelLeftClose className="size-4" />
          ) : (
            <PanelLeft className="size-4" />
          )}
        </button>

        {/* Update notification button */}
        {updateAvailable && (
          <button
            onClick={handleInstallUpdate}
            disabled={updating}
            className="flex items-center gap-1.5 px-2.5 py-1 mx-1 text-xs font-medium 
              bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 
              rounded-md transition disabled:opacity-50"
            title={`Update to v${updateAvailable.version}`}
          >
            <Download className="size-3" />
            {updating ? "Updating…" : `v${updateAvailable.version} available`}
          </button>
        )}

        <div className="flex items-center gap-2 px-2 min-w-0">
          <h1 className="text-[13px] font-medium text-foreground truncate">
            {session?.title ?? "General Assistance Conversation Started"}
          </h1>
          {currentBranch && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground/80 bg-white/[0.04] border border-white/[0.06] px-1.5 py-0.5 rounded-md"
              title={`Current git branch`}
            >
              <GitBranch size={10} />
              {currentBranch}
            </span>
          )}
          <button
            onClick={onSettings}
            className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition"
            title="Open settings"
          >
            <Settings className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={speakLatest}
          className={cn(
            "p-1 hover:bg-accent rounded transition",
            speaking
              ? "text-primary animate-pulse"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={speaking ? "Stop reading" : "Read latest response"}
        >
          <Volume2 className="size-4" />
        </button>
        <RightDrawerDropdown drawerOpen={rightDrawerOpen} onSelect={onSelectRightDrawerSection} />

        <div className="h-4 w-[1px] bg-border/40" />

        {/* Windows-style title bar buttons */}
        <div className="flex items-stretch ml-1">
          <button
            onClick={handleMinimize}
            className="w-[46px] h-[32px] flex items-center justify-center text-muted-foreground hover:bg-white/10 transition-colors"
            aria-label="Minimize"
          >
            <Minus className="size-4" />
          </button>
          <button
            onClick={handleToggleMaximize}
            className="w-[46px] h-[32px] flex items-center justify-center text-muted-foreground hover:bg-white/10 transition-colors"
            aria-label={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? <Minimize2 className="size-3.5" /> : <Square className="size-3" />}
          </button>
          <button
            onClick={handleClose}
            className="w-[46px] h-[32px] flex items-center justify-center text-muted-foreground hover:bg-red-500 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
