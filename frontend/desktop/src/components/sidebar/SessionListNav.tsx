/* ── Session list nav — brand, new chat, icon dock for destinations ─── */

import { motion } from "framer-motion";
import {
  Bot,
  Brain,
  History,
  Kanban,
  ListTodo,
  PanelLeft,
  Plus,
  Wrench,
} from "lucide-react";
import { t } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface SessionListNavProps {
  onNew: () => void;
  onNavigate: (path: string) => void;
  onToggleCollapsed: () => void;
  /** Current location pathname — the matching nav row gets aria-current. */
  activePath?: string;
}

const rowBase =
  "group w-full flex items-center gap-2 rounded-md px-2 text-left transition-colors";

const primaryRow = cn(
  rowBase,
  "py-1.5 text-[13px] text-sidebar-foreground/80 hover:bg-white/[0.05] hover:text-sidebar-foreground",
);

const rowMotion = {
  rest: { x: 0 },
  hover: { x: 3, transition: t.fast },
  tap: { scale: 0.98, transition: t.fast },
};

const plusIconMotion = {
  rest: { scale: 1, rotate: 0 },
  hover: { scale: 1.15, rotate: 90, transition: t.spring },
  tap: { scale: 0.9, rotate: 90, transition: t.fast },
};

const DESTINATIONS = [
  { path: "/automations", label: "Automations", testId: "sidebar-nav-automations", Icon: Bot },
  { path: "/runs", label: "Runs", testId: "sidebar-nav-runs", Icon: ListTodo },
  { path: "/board", label: "Board", testId: "sidebar-nav-board", Icon: Kanban },
  { path: "/history", label: "History", testId: "sidebar-nav-history", Icon: History },
] as const;

/** Top of the session sidebar: collapse control + new chat + destination dock. */
export function SessionListNav({
  onNew,
  onNavigate,
  onToggleCollapsed,
  activePath = '',
}: SessionListNavProps) {
  const isActive = (path: string) => activePath.startsWith(path);
  return (
    <div className="august-sidebar-nav pt-1.5 pb-1 px-2 flex flex-col gap-0.5">
      <div className="august-sidebar-brand flex items-center justify-between px-0.5 pb-2">
        <div className="flex items-center gap-2 px-1">
          <span className="text-[15px] font-semibold tracking-[-0.02em] text-sidebar-foreground/90">Assistant</span>
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="size-7 flex items-center justify-center rounded-lg text-sidebar-foreground/45 hover:text-sidebar-foreground/80 hover:bg-white/[0.05] transition"
          title="Hide sidebar"
          aria-label="Hide sidebar"
        >
          <PanelLeft className="size-3.5" />
        </button>
      </div>

      <motion.button
        type="button"
        onClick={onNew}
        className={primaryRow}
        initial="rest"
        whileHover="hover"
        whileTap="tap"
        variants={rowMotion}
      >
        <motion.span className="inline-flex shrink-0 opacity-70" variants={plusIconMotion}>
          <Plus className="size-3.5" />
        </motion.span>
        <span>New chat</span>
      </motion.button>

      <div className="mt-2 flex flex-col gap-1 text-[11px]" role="navigation" aria-label="Workspace">
        <button
          type="button"
          onClick={() => onNavigate('/history')}
          data-testid="sidebar-nav-history"
          className={cn('flex items-center gap-2 rounded-md px-2 py-1 text-left', isActive('/history') ? 'bg-white/[0.06] text-sidebar-foreground' : 'text-sidebar-foreground/55 hover:bg-white/[0.03] hover:text-sidebar-foreground/80')}
        >
          <History className="size-3" /> Scheduled
        </button>
        <button
          type="button"
          onClick={() => onNavigate('/skills')}
          data-testid="sidebar-nav-skills"
          className={cn('flex items-center gap-2 rounded-md px-2 py-1 text-left', isActive('/skills') ? 'bg-white/[0.06] text-sidebar-foreground' : 'text-sidebar-foreground/55 hover:bg-white/[0.03] hover:text-sidebar-foreground/80')}
        >
          <Wrench className="size-3" /> Plugins
        </button>
      </div>
    </div>
  );
}
