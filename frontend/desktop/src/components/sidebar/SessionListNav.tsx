/* ── Session list nav — top actions ─────────────────────────────────── */
/* Collapse · New chat · Automations · Skills & Tools · Artifacts         */

import { motion } from "framer-motion";
import {
  Bot,
  Brain,
  Package,
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
}

const rowBase =
  "group w-full flex items-center gap-2 rounded-md px-2 text-left transition-colors";

const quietRow = cn(
  rowBase,
  "py-1 text-[12.5px] text-sidebar-foreground/50 hover:bg-white/[0.04] hover:text-sidebar-foreground/80",
);

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

const packageIconMotion = {
  rest: { scale: 1, y: 0 },
  hover: { scale: 1.12, y: -2, transition: t.spring },
  tap: { scale: 0.92, y: 0, transition: t.fast },
};

const brainIconMotion = {
  rest: { scale: 1, rotate: 0 },
  hover: { scale: 1.12, rotate: -6, transition: t.spring },
  tap: { scale: 0.92, transition: t.fast },
};

/** Top of the session sidebar: collapse control + primary nav rows. */
export function SessionListNav({
  onNew,
  onNavigate,
  onToggleCollapsed,
}: SessionListNavProps) {
  return (
    <div className="pt-1.5 pb-1 px-2 flex flex-col gap-0.5">
      <div className="flex items-center px-0.5 pb-0.5">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="size-7 flex items-center justify-center rounded-md text-sidebar-foreground/45 hover:text-sidebar-foreground/80 hover:bg-white/[0.04] transition"
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
        className={quietRow}
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
        onClick={() => onNavigate("/settings?tab=agents-automation&section=automations")}
        className={quietRow}
        initial="rest"
        whileHover="hover"
        whileTap="tap"
        variants={rowMotion}
      >
        <motion.span className="inline-flex shrink-0 opacity-60" variants={botIconMotion}>
          <Bot className="size-3.5" />
        </motion.span>
        <span>Automations</span>
      </motion.button>

      <motion.button
        type="button"
        onClick={() => onNavigate("/settings?tab=mcp")}
        className={quietRow}
        initial="rest"
        whileHover="hover"
        whileTap="tap"
        variants={rowMotion}
      >
        <motion.span className="inline-flex shrink-0 opacity-60" variants={wrenchIconMotion}>
          <Wrench className="size-3.5" />
        </motion.span>
        <span>Skills & Tools</span>
      </motion.button>

      <motion.button
        type="button"
        onClick={() => onNavigate("/settings?tab=overview")}
        className={quietRow}
        initial="rest"
        whileHover="hover"
        whileTap="tap"
        variants={rowMotion}
      >
        <motion.span className="inline-flex shrink-0 opacity-60" variants={packageIconMotion}>
          <Package className="size-3.5" />
        </motion.span>
        <span>Artifacts</span>
      </motion.button>
    </div>
  );
}
