/* ── Session list nav — brand, new chat, icon dock for destinations ─── */

import { motion } from "framer-motion";
import {
  ChevronDown,
  Bot,
  FolderOpen,
  PanelLeft,
  Plus,
} from "lucide-react";
import { addWorkspace, setCurrentWorkspace, useWorkspacesStore } from "@/store/workspaces";
import { openFolderViaTauri } from "@/api/folder";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/lib/motion";


export interface SessionListNavProps {
  onNew: () => void;
  onNavigate: (path: string) => void;
  onToggleCollapsed: () => void;
  /** Current location pathname — the matching nav row gets aria-current. */
  activePath?: string;
  /** Workspace folder basename shown as the sidebar brand label.
   *  When omitted, falls back to the app wordmark "August" — never the
   *  literal "Assistant" that collided with the default bot's display name
   *  (2026-09-16 UI scan §3.4). */
  workspaceName?: string | null;
}

const rowMotion = {
  rest: { x: 0 },
  hover: { x: 2, transition: t.fast },
  tap: { scale: 0.98, transition: t.fast },
};

const plusIconMotion = {
  rest: { scale: 1, rotate: 0 },
  hover: { scale: 1.15, rotate: 90, transition: t.spring },
  tap: { scale: 0.9, rotate: 90, transition: t.fast },
};

/** The sidebar is for what a chat is used for daily. Board and Learning were
 *  rows here; both are configuration-shaped surfaces now — the kanban lives in
 *  Settings as `agent-board`, and the human half of the learning loop is the
 *  Review Inbox section. Both routes stay in the command palette, so nothing is
 *  orphaned by this list shrinking. */
const PRIMARY_DESTINATIONS = [
  { to: '/automations', label: 'Automations', Icon: Bot },
] as const;


/** Top of the session sidebar: collapse control + new chat + destination dock. */
export function SessionListNav({
  onNew,
  onNavigate,
  onToggleCollapsed,
  activePath = '',
  workspaceName,
}: SessionListNavProps) {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);
  const selectedWorkspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const brandLabel = workspaceName?.trim() || 'August';
  const addWorkspaceFromPicker = async () => {
    try {
      const path = await openFolderViaTauri();
      if (path.path) addWorkspace(path.path);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open a workspace folder.');
    }
  };

  return (
    <div className="august-sidebar-nav flex flex-col shrink-0">
      {/* Brand bar — same height token as the ChatTitlebar */}
      <div
        className="august-sidebar-brand h-[var(--shell-titlebar-h)] border-b border-sidebar-border/30 flex items-center justify-between px-2.5 shrink-0 select-none"
        data-tauri-drag-region
      >
        <div className="flex min-w-0 items-center gap-2 px-0.5">
          <span
            className="truncate text-[0.84375rem] font-semibold tracking-[-0.01em] text-sidebar-foreground"
            title={brandLabel}
          >
            {brandLabel}
          </span>
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="size-7 shrink-0 flex items-center justify-center rounded-md text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-white/[0.06] transition"
          title="Hide sidebar"
          aria-label="Hide sidebar"
        >
          <PanelLeft className="size-3" />
        </button>
      </div>

      <div className="px-2 pt-2 pb-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-sidebar-foreground/80 transition hover:bg-sidebar-accent/50"
              aria-label="Switch workspace"
              data-testid="workspace-switcher"
            >
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{selectedWorkspace?.name ?? brandLabel}</span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {workspaces.length === 0 ? (
              <DropdownMenuItem disabled>No workspaces added yet</DropdownMenuItem>
            ) : workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                onSelect={() => setCurrentWorkspace(workspace.id)}
                className="flex items-center gap-2"
              >
                <FolderOpen className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {workspace.id === currentWorkspaceId ? <span aria-label="Current workspace">✓</span> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => void addWorkspaceFromPicker()}>
              <Plus className="mr-2 size-3.5" /> Add workspace…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* New chat — a ROW, not a primary CTA. It was a filled pill with a
          border and a shadow sitting above three quiet nav rows, which made it
          read as the app's main action and pushed every chat below the fold.
          Claude, Haze and KiloCode all draw it as one more nav row; the only
          thing that makes it primary is the + glyph. */}
      <div className="p-2 pb-1">
        <motion.button
          type="button"
          onClick={onNew}
          className="w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors text-sidebar-foreground/85 hover:text-sidebar-foreground hover:bg-sidebar-accent/40"
          initial="rest"
          whileHover="hover"
          whileTap="tap"
          variants={rowMotion}
        >
          <motion.span className="inline-flex shrink-0 opacity-80" variants={plusIconMotion}>
            <Plus className="size-3.5" />
          </motion.span>
          <span>New chat</span>
        </motion.button>
      </div>

      {/* Keep the primary work destinations visible; the full route set remains
          available from the command palette. Artifacts live in the right drawer. */}
      <div className="px-2 space-y-0.5 pb-1" role="navigation" aria-label="Workspace">
        {PRIMARY_DESTINATIONS.map(({ to, label, Icon }) => (
          <button
            key={to}
            type="button"
            onClick={() => onNavigate(to)}
            aria-current={activePath === to ? 'page' : undefined}
            className={`w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${activePath === to ? 'bg-sidebar-accent/70 text-sidebar-foreground' : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground'}`}
          >
            <Icon className="size-3.5 shrink-0" />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
