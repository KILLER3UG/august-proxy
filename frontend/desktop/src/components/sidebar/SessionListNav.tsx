/* ── Session list nav — brand, workspace, new thread, destinations ───── */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Archive,
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  History,
  Kanban,
  LineChart,
  MessageSquare,
  Mic,
  PackageOpen,
  PanelLeft,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { t } from "@/lib/motion";
import { toggleCommandPalette } from "@/store/command-palette";
import { Button } from "@/components/ui/button";

export interface SessionListNavProps {
  onNew: () => void;
  onNavigate: (path: string) => void;
  onToggleCollapsed: () => void;
  /** Current location pathname — the matching nav row gets aria-current. */
  activePath?: string;
  /** Workspace folder basename for the workspace card. */
  workspaceName?: string | null;
  /** Full workspace path, shown as the card's second line. */
  workspacePath?: string | null;
}

const rowMotion = {
  rest: { x: 0 },
  hover: { x: 2, transition: t.fast },
  tap: { scale: 0.98, transition: t.fast },
};

const plusIconMotion = {
  rest: { scale: 1, rotate: 0 },
  hover: { scale: 1.1, rotate: 90, transition: t.spring },
  tap: { scale: 0.9, rotate: 90, transition: t.fast },
};

/** Primary destinations. Charts joins this list with its page (phase 3). */
const PRIMARY = [
  { key: "threads", label: "Threads", Icon: MessageSquare, to: "/" },
  { key: "charts", label: "Charts", Icon: LineChart, to: "/charts" },
  { key: "artifacts", label: "Artifacts", Icon: PackageOpen, to: "/artifacts" },
  { key: "settings", label: "Settings", Icon: Settings, to: "/settings" },
] as const;

/** Every surface the mockup does not show stays reachable here. */
const MORE = [
  { label: "Automations", Icon: Bot, to: "/automations" },
  { label: "Runs", Icon: History, to: "/runs" },
  { label: "Board", Icon: Kanban, to: "/board" },
  { label: "Live", Icon: Mic, to: "/live" },
  { label: "History", Icon: Archive, to: "/history" },
  { label: "Learning", Icon: GraduationCap, to: "/learning" },
  { label: "Docs", Icon: BookOpen, to: "/docs" },
] as const;

function isActive(to: string, path: string): boolean {
  if (to === "/") return path === "/" || path === "" || path.startsWith("/c/");
  return path === to || path.startsWith(`${to}/`);
}

export function SessionListNav({
  onNew,
  onNavigate,
  onToggleCollapsed,
  activePath = "",
  workspaceName,
  workspacePath,
}: SessionListNavProps) {
  const moreActive = MORE.some((item) => isActive(item.to, activePath));
  const [moreOpen, setMoreOpen] = useState(moreActive);

  useEffect(() => {
    if (moreActive) setMoreOpen(true);
  }, [moreActive]);

  return (
    <div className="august-sidebar-nav flex flex-col shrink-0">
      <div
        className="august-sidebar-brand h-[var(--shell-titlebar-h)] border-b border-sidebar-border/30 flex items-center justify-between px-3 shrink-0 select-none"
        data-tauri-drag-region
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-editorial truncate text-[1.0625rem] font-medium tracking-[-0.015em] text-sidebar-foreground">
            August
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onToggleCollapsed}
          className="size-7 shrink-0 rounded-md text-sidebar-foreground/55 hover:bg-white/[0.06] hover:text-sidebar-foreground"
          title="Hide sidebar"
          aria-label="Hide sidebar"
        >
          <PanelLeft className="size-3" />
        </Button>
      </div>

      <div className="px-2.5 pt-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("august:open-project-picker"))
          }
          className="h-auto w-full items-center justify-start gap-2 rounded-lg border border-sidebar-border/55 bg-sidebar-accent/25 px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent/45"
          title={workspacePath || "Choose a workspace"}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.8125rem] font-medium text-sidebar-foreground">
              {workspaceName?.trim() || "No workspace"}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[0.625rem] text-sidebar-foreground/45">
              {workspacePath?.trim() || "Pick a project folder"}
            </span>
          </span>
          <ChevronDown className="size-3 shrink-0 text-sidebar-foreground/45" />
        </Button>

        <motion.button
          type="button"
          onClick={onNew}
          className="mt-2 flex h-10 w-full items-center gap-2.5 rounded-md bg-sidebar-primary px-2.5 text-left text-sidebar-primary-foreground transition-colors hover:brightness-105"
          initial="rest"
          whileHover="hover"
          whileTap="tap"
          variants={rowMotion}
        >
          <motion.span
            className="grid size-5 shrink-0 place-items-center rounded bg-black/10"
            variants={plusIconMotion}
          >
            <Plus className="size-3.5" />
          </motion.span>
          <span className="text-[0.8125rem] font-semibold">New thread</span>
        </motion.button>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => toggleCommandPalette()}
          className="mt-1.5 h-8 w-full items-center justify-start gap-2 rounded-md border border-sidebar-border/55 bg-white/[0.02] px-2.5 text-left text-[0.75rem] font-normal text-sidebar-foreground/55 transition-colors hover:bg-white/[0.05] hover:text-sidebar-foreground"
          title="Search or run a command (Ctrl+K)"
          aria-keyshortcuts="Control+K"
        >
          <Search className="size-3 shrink-0 opacity-80" />
          <span className="min-w-0 flex-1 truncate">Search or jump to…</span>
          <kbd className="shrink-0 border-sidebar-border/60 bg-transparent text-[0.625rem] text-sidebar-foreground/40">
            ⌘K
          </kbd>
        </Button>
      </div>

      <nav className="mt-2 px-2 space-y-0.5" aria-label="Workspace">
        {PRIMARY.map(({ key, label, Icon, to }) => {
          const active = isActive(to, activePath);
          return (
            <motion.button
              key={key}
              type="button"
              onClick={() => onNavigate(to)}
              aria-current={active ? "page" : undefined}
              initial="rest"
              whileHover="hover"
              whileTap="tap"
              variants={rowMotion}
              className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[0.78125rem] transition-colors ${
                active
                  ? "bg-sidebar-accent/65 text-sidebar-foreground"
                  : "text-sidebar-foreground/65 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
              }`}
            >
              <Icon className="size-3.5 shrink-0 opacity-85" />
              <span>{label}</span>
            </motion.button>
          );
        })}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setMoreOpen((open) => !open)}
          aria-expanded={moreOpen}
          className={`h-8 w-full items-center justify-start gap-2.5 rounded-md px-2.5 text-left text-[0.78125rem] font-normal transition-colors ${
            moreActive
              ? "text-sidebar-foreground"
              : "text-sidebar-foreground/55 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
          }`}
        >
          {moreOpen ? (
            <ChevronDown className="size-3.5 shrink-0 opacity-85" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 opacity-85" />
          )}
          <span>More</span>
        </Button>
        {moreOpen &&
          MORE.map(({ label, Icon, to }) => {
            const active = isActive(to, activePath);
            return (
              <Button
                key={to}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onNavigate(to)}
                aria-current={active ? "page" : undefined}
                className={`h-8 w-full items-center justify-start gap-2.5 rounded-md pl-8 pr-2.5 text-left text-[0.75rem] font-normal transition-colors ${
                  active
                    ? "bg-sidebar-accent/65 text-sidebar-foreground"
                    : "text-sidebar-foreground/55 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
                }`}
              >
                <Icon className="size-3.5 shrink-0 opacity-80" />
                <span>{label}</span>
              </Button>
            );
          })}
      </nav>
    </div>
  );
}
