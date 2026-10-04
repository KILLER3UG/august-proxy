/* ── Session list nav — brand, new chat, icon dock for destinations ─── */

import { motion } from "framer-motion";
import {
  FileText,
  PanelLeft,
  Plus,
  Settings,
} from "lucide-react";
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


/** Top of the session sidebar: collapse control + new chat + destination dock. */
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

      {/* Primary + New button */}
      <div className="p-2 pb-1">
        <motion.button
          type="button"
          onClick={onNew}
          className="w-full flex items-center gap-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] px-3 py-1.5 text-left text-[0.8125rem] font-medium text-sidebar-foreground transition-colors shadow-sm"
          initial="rest"
          whileHover="hover"
          whileTap="tap"
          variants={rowMotion}
        >
          <motion.span className="inline-flex shrink-0 opacity-80" variants={plusIconMotion}>
            <Plus className="size-3" />
          </motion.span>
          <span>New chat</span>
        </motion.button>
      </div>

      {/* Chat-first sidebar. Deep dive against the four references: Hermes
          keeps FOUR durable pages in chrome (Chat/Skills/Messaging/
          Artifacts) and routes the rest through ⌘K; DeepSeek's sidebar
          carries brand + New Session + workspaces + a BOTTOM-pinned
          Settings seat; Claude keeps New Chat + history + an account
          footer; only ChatGPT lists many rows, and those are consumer
          content (Library/Sora/GPTs) rather than tool surfaces. So the
          sidebar keeps exactly what belongs to a conversation — Artifacts
          (mirrored by the composer + titlebar triggers). Automations,
          Runs, Board, Live, History and Learning live in the ⌘K palette's
          Tools group, exactly like Hermes' launcher-only pattern, and
          Customize (Settings) is bottom-pinned above the account row. */}
      <div className="px-2 space-y-0.5 pb-1" role="navigation" aria-label="Workspace">
        <button
          type="button"
          onClick={() => {
            // Open the section itself, the way ComposerToolbar does. The
            // `august:open-right-sidebar` event only reveals a panel whose
            // store is already open, so dispatching it with nothing in the
            // drawer is reverted by ChatLayout's sync effect — a dead button.
            addRightDrawerSection('artifacts');
          }}
          className="w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[0.78125rem] text-sidebar-foreground/70 hover:bg-white/[0.04] hover:text-sidebar-foreground transition-colors"
        >
          <FileText className="size-3 text-muted-foreground shrink-0" />
          <span>Artifacts</span>
        </button>

      </div>
    </div>
  );
}
