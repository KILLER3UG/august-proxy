/* ── Session list nav — new chat, continue last, tools, search ─────── */

import { Plus, Search, MessageSquare, Wrench, Package } from "lucide-react";
import type { Session } from "@/store/sessions";

export interface SessionListNavProps {
  filter: string;
  onFilterChange: (value: string) => void;
  lastSession?: Session;
  onNew: () => void;
  onSelectLast: () => void;
  onNavigate: (path: string) => void;
}

/** Top nav actions and session search field above the pinned/sessions lists. */
export function SessionListNav({
  filter,
  onFilterChange,
  lastSession,
  onNew,
  onSelectLast,
  onNavigate,
}: SessionListNavProps) {
  return (
    <>
      {/* New session, continue last, skills, artifacts */}
      <div className="py-2.5 px-2 flex flex-col gap-0.5">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sidebar-foreground/80 hover:bg-white/5 hover:text-foreground transition"
        >
          <span className="flex items-center gap-2">
            <Plus className="size-3.5" /> New session
          </span>
          <kbd className="text-[10px] text-muted-foreground font-mono bg-muted/20 px-1 py-0.5 rounded border border-border/20">
            ctrl N
          </kbd>
        </button>
        {lastSession && (
          <button
            type="button"
            onClick={onSelectLast}
            className="w-full text-left rounded-md px-2.5 py-1.5 text-sidebar-foreground/80 hover:bg-white/5 hover:text-foreground transition flex items-center gap-2"
            title={lastSession.title}
            data-testid="continue-last-session"
          >
            <MessageSquare className="size-3.5" /> Continue last
            <span className="ml-auto truncate max-w-[7rem] text-[10px] text-muted-foreground">
              {lastSession.title}
            </span>
          </button>
        )}
        <button
          onClick={() => onNavigate("/settings?tab=mcp")}
          className="w-full text-left rounded-md px-2.5 py-1.5 text-sidebar-foreground/80 hover:bg-white/5 hover:text-foreground transition flex items-center gap-2"
        >
          <Wrench className="size-3.5" /> Skills & Tools
        </button>
        <button
          onClick={() => onNavigate("/settings?tab=overview")}
          className="w-full text-left rounded-md px-2.5 py-1.5 text-sidebar-foreground/80 hover:bg-white/5 hover:text-foreground transition flex items-center gap-2"
        >
          <Package className="size-3.5" /> Artifacts
        </button>
      </div>

      {/* Filter sessions by title */}
      <div className="px-2 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Search sessions..."
            className="w-full pl-8 pr-2 py-1 text-xs bg-white/5 rounded-md border border-transparent focus:border-white/10 focus:bg-white/10 outline-none transition text-sidebar-foreground placeholder:text-muted-foreground"
          />
        </div>
      </div>
    </>
  );
}
