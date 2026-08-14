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
  { path: "/brain", label: "Brain", testId: "sidebar-nav-brain", Icon: Brain },
  { path: "/automations", label: "Automations", testId: "sidebar-nav-automations", Icon: Bot },
  { path: "/skills", label: "Skills & Tools", testId: "sidebar-nav-skills", Icon: Wrench },
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

      <div
        className="mt-1.5 flex items-center justify-between gap-0.5 rounded-xl bg-white/[0.03] px-1 py-1"
        role="navigation"
        aria-label="Workspace"
      >
        {DESTINATIONS.map(({ path, label, testId, Icon }) => (
          <button
            key={path}
            type="button"
            onClick={() => onNavigate(path)}
            className={cn(
              'flex size-7 items-center justify-center rounded-lg transition',
              isActive(path)
                ? 'bg-white/[0.08] text-sidebar-foreground'
                : 'text-sidebar-foreground/45 hover:bg-white/[0.05] hover:text-sidebar-foreground/80',
            )}
            aria-current={isActive(path) ? 'page' : undefined}
            title={label}
            aria-label={label}
            data-testid={testId}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}
