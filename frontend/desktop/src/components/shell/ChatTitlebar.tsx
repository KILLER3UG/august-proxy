import { useState } from "react";
import {
  Volume2,
  Minus,
  Square,
  X,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
  Settings,
  GitBranch,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { gitApi } from "@/api/git";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Session } from "@/store/sessions";

interface ChatTitlebarProps {
  session: Session | null;
  sidebarCollapsed: boolean;
  showRightSidebar: boolean;
  onToggleSidebar: () => void;
  onToggleRightSidebar: () => void;
  onSettings: () => void;
}

export function ChatTitlebar({
  session,
  sidebarCollapsed,
  showRightSidebar,
  onToggleSidebar,
  onToggleRightSidebar,
  onSettings,
}: ChatTitlebarProps) {
  const [speaking, setSpeaking] = useState(false);
  const branch = useQuery({
    queryKey: ['git', 'branch', session?.id],
    queryFn: () => gitApi.branch(session?.id),
    refetchInterval: 30_000,
    retry: false,
  });
  const currentBranch = branch.data?.current;

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
    <header className="h-12 bg-background flex items-center justify-between shrink-0 select-none">
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
        <button
          onClick={onToggleRightSidebar}
          className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition"
          title="Toggle Workspace Explorer"
        >
          {showRightSidebar ? (
            <PanelRightClose className="size-4" />
          ) : (
            <PanelRight className="size-4" />
          )}
        </button>

        <div className="h-4 w-[1px] bg-border/40" />

        <div className="flex items-center gap-1.5 ml-1">
          <button
            className="size-6 flex items-center justify-center hover:bg-accent rounded text-muted-foreground hover:text-foreground transition"
            aria-label="Minimize"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            className="size-6 flex items-center justify-center hover:bg-accent rounded text-muted-foreground hover:text-foreground transition"
            aria-label="Maximize"
          >
            <Square className="size-2.5" />
          </button>
          <button
            className="size-6 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground rounded text-muted-foreground transition"
            aria-label="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
