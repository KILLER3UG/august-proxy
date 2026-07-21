import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Command } from "cmdk";
import {
  Plus,
  RefreshCw,
  Sun,
  Moon,
  Settings,
  Copy,
  Undo2,
  GitBranch,
  Shrink,
  Shield,
  ListTodo,
  FileDiff,
  History,
} from "lucide-react";
import {
  useCommandPaletteStore,
  closeCommandPalette,
} from "@/store/command-palette";
import { useResolvedThemeStore, toggleTheme } from "@/store/theme";
import { SECTION_NAV_ITEMS, SETTINGS_TABS } from '@/routes';
import { Backdrop } from "./Backdrop";
import { useQueryClient } from "@tanstack/react-query";
import { dispatchUiAction } from "@/api/ui-events";

export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const theme = useResolvedThemeStore((s) => s.theme);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const location = useLocation();

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

  return (
    <Backdrop onClose={closeCommandPalette} className="items-start pt-[15vh]">
      <Command
        className="w-[min(90vw,600px)] rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        label="Command palette"
      >
        <Command.Input
          autoFocus
          placeholder="Type a command, search sessions, or jump to a section…"
          className="w-full bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground border-b border-border"
        />
        <Command.List className="max-h-[55vh] overflow-y-auto p-2">
          <Command.Empty className="py-6 text-center text-xs text-muted-foreground">
            No results found.
          </Command.Empty>

          <Command.Group
            heading="Chat"
            className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground"
          >
            <Command.Item
              value="action new chat"
              onSelect={run(() => { void navigate("/"); })}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <Plus className="size-3.5" /> New chat
            </Command.Item>
            <Command.Item
              value="action undo last turn"
              onSelect={run(() =>
                dispatchUiAction({ action: 'undo_last_turn', target: 'active' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <Undo2 className="size-3.5" /> Undo last turn
            </Command.Item>
            <Command.Item
              value="action branch chat fork"
              onSelect={run(() =>
                dispatchUiAction({ action: 'branch_session', target: 'active' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <GitBranch className="size-3.5" /> Branch this chat
            </Command.Item>
            <Command.Item
              value="action free up chat memory compact"
              onSelect={run(() =>
                dispatchUiAction({ action: 'compact_now', target: 'active' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <Shrink className="size-3.5" /> Free up chat memory
            </Command.Item>
            <Command.Item
              value="action restore save point checkpoint undo files"
              onSelect={run(() =>
                dispatchUiAction({ action: 'restore_checkpoint', target: 'latest' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <History className="size-3.5" /> Restore last save point
            </Command.Item>
            <Command.Item
              value="mode ask before changes"
              onSelect={run(() =>
                dispatchUiAction({ action: 'set_guard_mode', target: 'ask' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <Shield className="size-3.5" /> Mode: Ask before changes
            </Command.Item>
            <Command.Item
              value="mode edit automatically"
              onSelect={run(() =>
                dispatchUiAction({ action: 'set_guard_mode', target: 'edit' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <Shield className="size-3.5" /> Mode: Edit automatically
            </Command.Item>
            <Command.Item
              value="mode plan mode"
              onSelect={run(() =>
                dispatchUiAction({ action: 'set_guard_mode', target: 'plan' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <Shield className="size-3.5" /> Mode: Plan mode
            </Command.Item>
            <Command.Item
              value="mode full access"
              onSelect={run(() =>
                dispatchUiAction({ action: 'set_guard_mode', target: 'full' }),
              )}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
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
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
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
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
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
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <FileDiff className="size-3.5" /> Open diffs panel
            </Command.Item>
          </Command.Group>

          <Command.Separator className="my-2 border-t border-border" />

          <Command.Group
            heading="App"
            className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground"
          >
            <Command.Item
              value="action open settings"
              onSelect={run(() => { void navigate("/settings"); })}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <Settings className="size-3.5" /> Settings…
            </Command.Item>
            <Command.Item
              value="action refresh all data"
              onSelect={run(() => { void qc.invalidateQueries(); })}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <RefreshCw className="size-3.5" /> Refresh all data
            </Command.Item>
            <Command.Item
              value="action toggle theme"
              onSelect={run(toggleTheme)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
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
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
            >
              <Copy className="size-3.5" /> Copy current path
            </Command.Item>
          </Command.Group>

          <Command.Separator className="my-2 border-t border-border" />

          <Command.Group
            heading="Settings tabs"
            className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground"
          >
            {SETTINGS_TABS.map(({ key, label, Icon, path }) => (
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
            className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground"
          >
            {SECTION_NAV_ITEMS.filter((item) => item.to !== '/').map(({ to, label, Icon }) => (
              <Command.Item
                key={to}
                value={`tool ${label}`}
                onSelect={run(() => { void navigate(to); })}
                className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer aria-selected:bg-accent"
              >
                <Icon className="size-3.5" /> {label}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>

        <div className="border-t border-border px-3 py-2 flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
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
