import { useEffect, type ReactNode } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Command } from "cmdk";
import { toast } from "sonner";
import { api } from "@/api/client";
import {
  Plus,
  RefreshCw,
  Sun,
  Moon,
  Settings,
  Copy,
  Brain,
  Asterisk,
  Clock,
  Network,
  Search,
  Undo2,
  GitBranch,
  Shrink,
  Shield,
  ListTodo,
  FileDiff,
  FileDown,
  Keyboard,
  StickyNote,
  Square,
  ArrowLeftRight,
  GalleryVertical,
} from "lucide-react";
import {
  useCommandPaletteStore,
  closeCommandPalette,
} from "@/store/command-palette";
import { openShortcutsModal } from "@/store/shortcuts-modal";
import { useSessionsStore } from "@/store/sessions";
import { useResolvedThemeStore, toggleTheme } from "@/store/theme";
import { SECTION_NAV_ITEMS, SETTINGS_TABS } from '@/routes';
import { Backdrop } from "./Backdrop";
import { useQueryClient } from "@tanstack/react-query";
import { dispatchUiAction, hasChatSurface, type UiAction } from "@/api/ui-events";
import { openConversationSearch } from "@/store/conversation-search";
import { useFocusTrap } from "@/hooks/useFocusTrap";

const UNIMPLEMENTED_SETTINGS_TAB_IDS = new Set<string>(['hooks', 'indexing']);

function CommandShortcut({ children }: { children: ReactNode }) {
  return (
    <kbd className="ml-auto rounded border border-border bg-muted px-1 py-0.5 font-mono text-xs leading-4 text-muted-foreground">
      {children}
    </kbd>
  );
}

export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const theme = useResolvedThemeStore((s) => s.theme);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const location = useLocation();
  const trapRef = useFocusTrap<HTMLDivElement>();
  const sessions = useSessionsStore((s) => s.sessions);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCommandPalette();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  const isDark = theme === "dark";
  const run = (fn: () => void) => () => {
    fn();
    closeCommandPalette();
  };

  /**
   * A command that acts on the conversation currently open in the chat thread.
   *
   * `useChatUiActions` and the composer's model picker are the only listeners for
   * these actions and both live inside ChatThread, which renders on the chat
   * route only — while this palette is mounted at app level and ChatLayout wraps
   * /settings, /board, /runs, /automations and /history too. So selecting Undo /
   * Stop / Branch / Free-up-chat-memory / Export / Copy / Switch model there
   * dispatched a CustomEvent into nothing: no error, no toast, no feedback.
   * Saying why is the same convention `stop_chat` already uses when nothing is
   * streaming.
   */
  const chatAction = (action: UiAction) =>
    run(() => {
      if (!hasChatSurface()) {
        toast.message('Open a conversation first — this acts on the current chat.');
        return;
      }
      dispatchUiAction({ action, target: 'active' });
    });

  return (
    <Backdrop onClose={closeCommandPalette} className="items-start pt-[15vh]">
      <Command
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="command-palette-dialog w-[min(90vw,640px)] rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        label="Command palette"
      >
        <Command.Input
          autoFocus
          placeholder="Type a command or action…"
          className="w-full bg-transparent px-4 py-3 text-sm outline-none placeholder:text-tier-3 border-b border-border/60"
        />
        <Command.List className="max-h-[60vh] overflow-y-auto p-2">
          <Command.Empty className="py-6 text-center text-xs text-muted-foreground">
            No results found.
          </Command.Empty>

          <Command.Group
            heading="Chat"
            className="px-3 pt-2 pb-1 text-xs font-medium text-tier-2 tracking-normal"
          >
            <Command.Item
              value="action new chat"
              onSelect={run(() => { void navigate("/"); })}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Plus className="size-3.5" /> New chat
              <CommandShortcut>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘N' : 'Ctrl+N'}</CommandShortcut>
            </Command.Item>
            <Command.Item
              value="action search conversations"
              onSelect={run(() => openConversationSearch())}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Search className="size-3.5" /> Search conversations…
            </Command.Item>
            <Command.Item
              value="action undo last turn"
              onSelect={chatAction('undo_last_turn')}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Undo2 className="size-3.5" /> Undo last turn
            </Command.Item>
            <Command.Item
              value="action stop generation"
              onSelect={chatAction('stop_chat')}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Square className="size-3.5" /> Stop generation
            </Command.Item>
            <Command.Item
              value="action switch model picker"
              onSelect={chatAction('open_model_picker')}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <ArrowLeftRight className="size-3.5" /> Switch model…
            </Command.Item>
            <Command.Item
              value="action branch chat fork"
              onSelect={chatAction('branch_session')}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <GitBranch className="size-3.5" /> Branch this chat
            </Command.Item>
            <Command.Item
              value="action free up chat memory compact"
              onSelect={chatAction('compact_now')}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Shrink className="size-3.5" /> Free up chat memory
            </Command.Item>
            <Command.Item
              value="action export conversation download markdown transcript"
              onSelect={chatAction('export_conversation')}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <FileDown className="size-3.5" /> Export conversation (Markdown)
            </Command.Item>
            <Command.Item
              value="action export conversation pdf print"
              onSelect={chatAction('export_conversation_pdf')}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <FileDown className="size-3.5" /> Export conversation (PDF)
            </Command.Item>
            <Command.Item
              value="action copy conversation clipboard markdown"
              onSelect={chatAction('copy_conversation')}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Copy className="size-3.5" /> Copy conversation
            </Command.Item>
            <Command.Item
              value="mode ask before changes"
              onSelect={run(() =>
                dispatchUiAction({ action: 'set_guard_mode', target: 'ask' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Shield className="size-3.5" /> Mode: Ask before changes
            </Command.Item>
            <Command.Item
              value="mode edit automatically"
              onSelect={run(() =>
                dispatchUiAction({ action: 'set_guard_mode', target: 'edit' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Shield className="size-3.5" /> Mode: Edit automatically
            </Command.Item>
            <Command.Item
              value="mode plan mode"
              onSelect={run(() =>
                dispatchUiAction({ action: 'set_guard_mode', target: 'plan' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Shield className="size-3.5" /> Mode: Plan mode
            </Command.Item>
            <Command.Item
              value="mode full access"
              onSelect={run(() =>
                dispatchUiAction({ action: 'set_guard_mode', target: 'full' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Shield className="size-3.5" /> Mode: Full access
            </Command.Item>
            <Command.Item
              value="open plan panel drawer"
              onSelect={run(() =>
                dispatchUiAction({
                  action: 'set_drawer_section',
                  target: 'plan',
                }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <ListTodo className="size-3.5" /> Open plan panel
            </Command.Item>
            <Command.Item
              value="open tasks todos panel drawer"
              onSelect={run(() =>
                dispatchUiAction({
                  action: 'set_drawer_section',
                  target: 'tasks',
                }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <ListTodo className="size-3.5" /> Open tasks panel
            </Command.Item>
            <Command.Item
              value="open diff changed files panel drawer"
              onSelect={run(() =>
                dispatchUiAction({
                  action: 'set_drawer_section',
                  target: 'diff',
                }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <FileDiff className="size-3.5" /> Open diffs panel
            </Command.Item>
            <Command.Item
              value="open notepad notes scratch panel drawer"
              onSelect={run(() =>
                dispatchUiAction({
                  action: 'set_drawer_section',
                  target: 'notes',
                }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <StickyNote className="size-3.5" /> Open notepad
            </Command.Item>
            <Command.Item
              value="open artifacts files gallery browse generated outputs"
              onSelect={run(() =>
                dispatchUiAction({
                  action: 'set_drawer_section',
                  target: 'artifacts',
                }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <GalleryVertical className="size-3.5" /> Artifacts — Browse generated outputs
            </Command.Item>
          </Command.Group>

          <Command.Separator className="my-2 border-t border-border" />

          <Command.Group
            heading="Knowledge & runs"
            className="px-3 pt-2 pb-1 text-xs font-medium text-tier-2 tracking-normal"
          >
            <Command.Item
              value="action memory profile"
              onSelect={run(() => { void navigate('/settings/memory-knowledge'); })}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Brain className="size-3.5" /> What the assistant knows about you
            </Command.Item>
            <Command.Item
              value="action brain pending skills"
              onSelect={run(() => { void navigate("/settings/skills"); })}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Asterisk className="size-3.5" /> Review pending skills
            </Command.Item>
            <Command.Item
              value="action subagent runs"
              onSelect={run(() => { void navigate('/runs'); })}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Network className="size-3.5" /> Sub-agent runs
            </Command.Item>
            <Command.Item
              value="action brain run consolidation"
              onSelect={run(() => {
                void api
                  .post("/api/brain/consolidation/run", {})
                  .then(() => toast.success("Sleep cycle finished"))
                  .catch((e: Error) => toast.error(e.message || "Consolidation failed"));
              })}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Clock className="size-3.5" /> Run sleep cycle now
            </Command.Item>
          </Command.Group>

          <Command.Separator className="my-2 border-t border-border" />

          <Command.Group
            heading="App"
            className="px-3 pt-2 pb-1 text-xs font-medium text-tier-2 tracking-normal"
          >
            <Command.Item
              value="action open settings"
              onSelect={run(() => { void navigate("/settings"); })}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Settings className="size-3.5" /> Settings…
              <CommandShortcut>,</CommandShortcut>
            </Command.Item>
            <Command.Item
              value="action refresh all data"
              onSelect={run(() => { void qc.invalidateQueries(); })}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <RefreshCw className="size-3.5" /> Refresh all data
            </Command.Item>
            <Command.Item
              value="action toggle theme"
              onSelect={run(toggleTheme)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              {isDark ? (
                <Sun className="size-3.5" />
              ) : (
                <Moon className="size-3.5" />
              )}{" "}
              Toggle theme
            </Command.Item>
            <Command.Item
              value="action copy current path"
              onSelect={run(
                () => void navigator.clipboard?.writeText(location.pathname),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Copy className="size-3.5" /> Copy current path
            </Command.Item>
            <Command.Item
              value="action keyboard shortcuts hotkeys help"
              onSelect={run(openShortcutsModal)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
            >
              <Keyboard className="size-3.5" /> Keyboard shortcuts
              <CommandShortcut>?</CommandShortcut>
            </Command.Item>
          </Command.Group>

          <Command.Separator className="my-2 border-t border-border" />

          <Command.Group
            heading="Settings tabs"
            className="px-3 pt-2 pb-1 text-xs font-medium text-tier-2 tracking-normal"
          >
            {SETTINGS_TABS
              .filter(({ key }) => !UNIMPLEMENTED_SETTINGS_TAB_IDS.has(key))
              .map(({ key, label, Icon, path }) => (
                <Command.Item
                  key={key}
                  value={`settings ${label}`}
                  onSelect={run(() => { void navigate(path); })}
                  className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
                >
                  <Icon className="size-3.5" /> {label}
                </Command.Item>
              ))}
          </Command.Group>

          <Command.Separator className="my-2 border-t border-border" />

          <Command.Group
            heading="Tools"
            className="px-3 pt-2 pb-1 text-xs font-medium text-tier-2 tracking-normal"
          >
            {SECTION_NAV_ITEMS.filter((item) => item.to !== '/').map(({ to, label, Icon }) => (
              <Command.Item
                key={to}
                value={`tool ${label}`}
                onSelect={run(() => { void navigate(to); })}
                className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
              >
                <Icon className="size-3.5" /> {label}
              </Command.Item>
            ))}
          </Command.Group>

          {sessions.length > 0 && (
            <Command.Group
              heading="Recent chats"
              className="px-3 pt-2 pb-1 text-xs font-medium text-tier-2 tracking-normal"
            >
              {sessions.slice(0, 8).filter((s) => !s.isArchived).map((s) => (
                <Command.Item
                  key={s.id}
                  value={`chat ${s.title} ${s.id}`}
                  onSelect={run(() => { void navigate(`/c/${s.id}`); })}
                  className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-primary/15 aria-selected:text-tier-1 data-[selected=true]:bg-primary/15"
                >
                  <Search className="size-3.5 opacity-60" />
                  <span className="truncate">{s.title || 'Untitled chat'}</span>
                  <span className="ml-auto text-xs text-muted-foreground/50 font-mono">{s.id.slice(0, 8)}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>

        <div className="border-t border-border px-3 py-2 flex items-center gap-3 text-xs text-muted-foreground font-mono">
          <span>
            <kbd className="rounded border border-border bg-muted px-1">↑↓</kbd>{" "}
            navigate
          </span>
          <span>
            <kbd className="rounded border border-border bg-muted px-1">↵</kbd>{" "}
            select
          </span>
          <span>
            <kbd className="rounded border border-border bg-muted px-1">
              esc
            </kbd>{" "}
            close
          </span>
          <span className="ml-auto">
            <kbd className="rounded border border-border bg-muted px-1">,</kbd>{" "}
            settings
          </span>
        </div>
      </Command>
    </Backdrop>
  );
}
