/* ── Session list nav — brand, new chat, and the reference's destinations ── */

import { motion } from "framer-motion";
import { Archive, FolderOpen, PanelLeft, Plus, Settings } from "lucide-react";
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

/** The reference's four quiet top rows. Projects and Artifacts are actions
 *  into the chat surfaces (the project picker in the composer and the right
 *  artifacts drawer), not new routes; Customize is the existing Settings. */
const DESTINATIONS = [
  { key: 'projects', label: 'Projects', Icon: FolderOpen, action: 'projects' },
  { key: 'artifacts', label: 'Artifacts', Icon: Archive, action: 'artifacts' },
  { key: 'customize', label: 'Customize', Icon: Settings, action: 'settings' },
] as const;

export function SessionListNav({
  onNew,
  onNavigate,
  onToggleCollapsed,
  activePath = '',
  workspaceName,
}: SessionListNavProps) {
  const brandLabel = workspaceName?.trim() || 'August';

  return (
    <div className="august-sidebar-nav flex flex-col shrink-0">
      {/* Brand bar — same height token as the ChatTitlebar. */}
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

      <div className="px-2 pt-1.5 pb-0.5">
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
          <span>New</span>
        </motion.button>
      </div>

      <div className="px-2 space-y-0.5 pb-0.5" role="navigation" aria-label="Workspace">
        {DESTINATIONS.map(({ key, label, Icon, action }) => {
          const active = action === 'settings' && activePath === '/settings';
          return (
            <motion.button
              key={key}
              type="button"
              onClick={() => {
                if (action === 'projects') {
                  window.dispatchEvent(new CustomEvent('august:open-project-picker'));
                } else if (action === 'artifacts') {
                  // A page now, not the in-chat drawer: the drawer shows one
                  // chat's artifacts, the page browses every chat's.
                  onNavigate('/artifacts');
                } else {
                  onNavigate('/settings');
                }
              }}
              aria-current={active ? 'page' : undefined}
              initial="rest"
              whileHover="hover"
              whileTap="tap"
              variants={rowMotion}
              className={`w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${active ? 'bg-sidebar-accent/70 text-sidebar-foreground' : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground'}`}
            >
              <Icon className="size-3.5 shrink-0" />
              <span>{label}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
