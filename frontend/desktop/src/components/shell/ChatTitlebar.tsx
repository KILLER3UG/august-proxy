import { useState, useEffect, useRef } from "react";
import {
  Volume2,
  Minus,
  Square,
  X,
  PanelLeftClose,
  Minimize2,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri-detect";
import { toast } from "sonner";
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
}

export function ChatTitlebar({
  session,
  sidebarCollapsed,
  rightDrawerOpen,
  onToggleSidebar,
  onSelectRightDrawerSection,
}: ChatTitlebarProps) {
  const [speaking, setSpeaking] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!overflowOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (overflowRef.current && overflowRef.current.contains(target)) return;
      setOverflowOpen(false);
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
        {/* Expand only — collapse control lives in the sidebar header. */}
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
          {session?.workspacePath ? (
            <WorkspaceBranchChip
              sessionId={session.id}
              className="shrink-0"
              menuPlacement="down"
            />
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-0.5">
        <RightDrawerDropdown drawerOpen={rightDrawerOpen} onSelect={onSelectRightDrawerSection} />

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
