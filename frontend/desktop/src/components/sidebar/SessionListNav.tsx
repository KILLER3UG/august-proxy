/* ── Session list nav — top actions ─────────────────────────────────── */
/* Collapse · New chat · Automations · Skills & Tools · Runs              */

import { motion } from "framer-motion";
import {
  Bot,
  Brain,
  History,
  Kanban,
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

const quietRow = cn(
  rowBase,
  "py-1 text-[12.5px] text-sidebar-foreground/50 hover:bg-white/[0.04] hover:text-sidebar-foreground/80",
);

const activeRow = cn(quietRow, "bg-white/[0.06] text-sidebar-foreground/90");

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

const botIconMotion = {
  rest: { scale: 1, y: 0 },
  hover: { scale: 1.12, y: -1, transition: t.spring },
  tap: { scale: 0.92, transition: t.fast },
};

const wrenchIconMotion = {
  rest: { scale: 1, rotate: 0 },
  hover: { scale: 1.12, rotate: -18, transition: t.spring },
  tap: { scale: 0.92, transition: t.fast },
};

const brainIconMotion = {
  rest: { scale: 1, rotate: 0 },
  hover: { scale: 1.12, rotate: -6, transition: t.spring },
  tap: { scale: 0.92, transition: t.fast },
};

const historyIconMotion = {
  rest: { scale: 1, rotate: 0 },
  hover: { scale: 1.12, rotate: -12, transition: t.spring },
  tap: { scale: 0.92, transition: t.fast },
};

const kanbanIconMotion = {
  rest: { scale: 1, rotate: 0 },
  hover: { scale: 1.12, rotate: -6, transition: t.spring },
  tap: { scale: 0.92, transition: t.fast },
};

/** Top of the session sidebar: collapse control + primary nav rows. */
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
          <span className="text-[15px] font-semibold tracking-[-0.02em] text-sidebar-foreground/90">August</span>
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

      <motion.button
        type="button"
        onClick={() => onNavigate("/brain")}
        className={isActive("/brain") ? activeRow : quietRow}
        aria-current={isActive("/brain") ? "page" : undefined}
        initial="rest"
        whileHover="hover"
        whileTap="tap"
        variants={rowMotion}
        data-testid="sidebar-nav-brain"
      >
        <motion.span className="inline-flex shrink-0 opacity-60" variants={brainIconMotion}>
          <Brain className="size-3.5" />
        </motion.span>
        <span>Brain</span>
      </motion.button>

      <motion.button
        type="button"
        onClick={() => onNavigate("/automations")}
        className={isActive("/automations") ? activeRow : quietRow}
        aria-current={isActive("/automations") ? "page" : undefined}
        initial="rest"
        whileHover="hover"
        whileTap="tap"
        variants={rowMotion}
        data-testid="sidebar-nav-automations"
      >
        <motion.span className="inline-flex shrink-0 opacity-60" variants={botIconMotion}>
          <Bot className="size-3.5" />
        </motion.span>
        <span>Automations</span>
      </motion.button>

      <motion.button
        type="button"
        onClick={() => onNavigate("/skills")}
        className={isActive("/skills") ? activeRow : quietRow}
        aria-current={isActive("/skills") ? "page" : undefined}
        initial="rest"
        whileHover="hover"
        whileTap="tap"
        variants={rowMotion}
        data-testid="sidebar-nav-skills"
      >
        <motion.span className="inline-flex shrink-0 opacity-60" variants={wrenchIconMotion}>
          <Wrench className="size-3.5" />
        </motion.span>
        <span>Skills & Tools</span>
      </motion.button>

      <motion.button
        type="button"
        onClick={() => onNavigate("/runs")}
        className={isActive("/runs") ? activeRow : quietRow}
        aria-current={isActive("/runs") ? "page" : undefined}
        initial="rest"
        whileHover="hover"
        whileTap="tap"
        variants={rowMotion}
        data-testid="sidebar-nav-runs"
      >
        <motion.span className="inline-flex shrink-0 opacity-60" variants={historyIconMotion}>
          <History className="size-3.5" />
        </motion.span>
        <span>Runs</span>
      </motion.button>

      <motion.button
        type="button"
        onClick={() => onNavigate("/board")}
        className={isActive("/board") ? activeRow : quietRow}
        aria-current={isActive("/board") ? "page" : undefined}
        initial="rest"
        whileHover="hover"
        whileTap="tap"
        variants={rowMotion}
        data-testid="sidebar-nav-board"
      >
        <motion.span className="inline-flex shrink-0 opacity-60" variants={kanbanIconMotion}>
          <Kanban className="size-3.5" />
        </motion.span>
        <span>Board</span>
      </motion.button>

      <motion.button
        type="button"
        onClick={() => onNavigate("/history")}
        className={isActive("/history") ? activeRow : quietRow}
        aria-current={isActive("/history") ? "page" : undefined}
        initial="rest"
        whileHover="hover"
        whileTap="tap"
        variants={rowMotion}
        data-testid="sidebar-nav-history"
      >
        <motion.span className="inline-flex shrink-0 opacity-60" variants={historyIconMotion}>
          <History className="size-3.5" />
        </motion.span>
        <span>History</span>
      </motion.button>

    </div>
  );
}
