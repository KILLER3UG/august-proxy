/* ── Session list nav — brand, new chat, icon dock for destinations ─── */

import { motion } from "framer-motion";
import {
  FileText,
  PanelLeft,
  Plus,
  Settings,
} from "lucide-react";
import { SECTION_NAV_ITEMS } from "@/routes";
import { addRightDrawerSection } from "@/components/shell/RightDrawerState";
import { t } from "@/lib/motion";
import { cn } from "@/lib/utils";

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

const DESTINATIONS = SECTION_NAV_ITEMS.filter((item) => item.to !== '/');
/* The dock is derived from the route table, not restated here. It used to
 * hardcode four paths while routes.ts declared six nav destinations, which is
 * how /live ended up reachable only through the command palette. Chat (`/`) is
 * excluded because "New chat" above already performs that action. */

/** Top of the session sidebar: collapse control + new chat + destination dock. */
export function SessionListNav({
  onNew,
  onNavigate,
  onToggleCollapsed,
  activePath = '',
  workspaceName,
}: SessionListNavProps) {
  const isActive = (path: string) =>
    activePath === path || activePath.startsWith(`${path}/`);
  const brandLabel = workspaceName?.trim() || 'August';

  return (
    <div className="august-sidebar-nav flex flex-col shrink-0">
      {/* Top 40px bar aligned with main ChatTitlebar */}
      <div
        className="august-sidebar-brand h-10 border-b border-sidebar-border/30 flex items-center justify-between px-2.5 shrink-0 select-none"
        data-tauri-drag-region
      >
        <div className="flex min-w-0 items-center gap-2 px-0.5">
          <span
            className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-sidebar-foreground"
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
          <PanelLeft className="size-3.5" />
        </button>
      </div>

      {/* Primary + New button */}
      <div className="p-2 pb-1">
        <motion.button
          type="button"
          onClick={onNew}
          className="w-full flex items-center gap-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] px-3 py-1.5 text-left text-[13px] font-medium text-sidebar-foreground transition-colors shadow-sm"
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

      {/* Core navigation: Artifacts, Customize.
          There is no `/projects` route — a "Projects" row used to sit here
          pointing at `/board`, whose page is titled "Board" and which the dock
          below already links, so the row could only ever mislabel a duplicate. */}
      <div className="px-2 space-y-0.5 pb-1">
        <button
          type="button"
          onClick={() => {
            // Open the section itself, the way ComposerToolbar does. The
            // `august:open-right-sidebar` event only reveals a panel whose
            // store is already open, so dispatching it with nothing in the
            // drawer is reverted by ChatLayout's sync effect — a dead button.
            addRightDrawerSection('artifacts');
          }}
          className="w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-sidebar-foreground/70 hover:bg-white/[0.04] hover:text-sidebar-foreground transition-colors"
        >
          <FileText className="size-3.5 text-muted-foreground shrink-0" />
          <span>Artifacts</span>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('/settings')}
          className={cn(
            'w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
            isActive('/settings')
              ? 'bg-white/[0.08] text-sidebar-foreground font-medium'
              : 'text-sidebar-foreground/70 hover:bg-white/[0.04] hover:text-sidebar-foreground',
          )}
        >
          <Settings className="size-3.5 text-muted-foreground shrink-0" />
          <span>Customize</span>
        </button>
      </div>

      {/* Destination icon dock */}
      <div className="px-2 pb-1.5 pt-0.5 flex items-center gap-1" role="navigation" aria-label="Workspace">
        {DESTINATIONS.map(({ to: path, label, Icon }) => (
          <button
            key={path}
            type="button"
            onClick={() => onNavigate(path)}
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
              isActive(path)
                ? 'bg-white/[0.07] text-sidebar-foreground'
                : 'text-sidebar-foreground/55 hover:bg-white/[0.04] hover:text-sidebar-foreground/80',
            )}
            aria-current={isActive(path) ? 'page' : undefined}
            title={label}
            aria-label={label}
            data-testid={`sidebar-nav-${path.replace(/^\//, '')}`}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}
