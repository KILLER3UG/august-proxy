/* ── Session list nav — new chat, tools, search ─────────────────────── */

import { motion } from "framer-motion";
import { Plus, Search, Wrench, Package } from "lucide-react";
import { t } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface SessionListNavProps {
  filter: string;
  onFilterChange: (value: string) => void;
  onNew: () => void;
  onNavigate: (path: string) => void;
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

/** Top nav actions and session search field above the pinned/sessions lists. */
export function SessionListNav({
  filter,
  onFilterChange,
  onNew,
  onNavigate,
}: SessionListNavProps) {
  return (
    <>
      <div className="pt-2 pb-0.5 px-2 flex flex-col gap-0.5">
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
