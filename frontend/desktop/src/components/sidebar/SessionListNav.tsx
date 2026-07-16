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
  const quietRow =
    "w-full flex items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-sidebar-foreground/50 hover:bg-white/[0.03] hover:text-sidebar-foreground/75 transition-colors";

  return (
    <>
      <div className="pt-2 pb-0.5 px-2 flex flex-col">
        <button
          onClick={onNew}
          className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-sidebar-foreground/80 hover:bg-white/[0.04] hover:text-sidebar-foreground transition-colors"
        >
          <Plus className="size-3.5 opacity-70" />
          <span>New chat</span>
        </button>
        {lastSession && (
          <button
            type="button"
            onClick={onSelectLast}
            className={quietRow}
            title={lastSession.title}
            data-testid="continue-last-session"
          >
            <MessageSquare className="size-3.5 opacity-60" />
            <span className="truncate">Continue last</span>
          </button>
        )}
        <button
          onClick={() => onNavigate("/settings?tab=mcp")}
          className={quietRow}
        >
          <Wrench className="size-3.5 opacity-60" /> Skills & Tools
        </button>
        <button
          onClick={() => onNavigate("/settings?tab=overview")}
          className={quietRow}
        >
          <Package className="size-3.5 opacity-60" /> Artifacts
        </button>
      </div>

      <div className="px-2 py-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-sidebar-foreground/30" />
          <input
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Search chats…"
            className="w-full pl-7 pr-2 py-1 text-[12px] bg-transparent rounded-md outline-none transition text-sidebar-foreground/80 placeholder:text-sidebar-foreground/30 hover:bg-white/[0.02] focus:bg-white/[0.03]"
          />
        </div>
      </div>
    </>
  );
}
