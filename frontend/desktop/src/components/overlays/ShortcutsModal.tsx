/**
 * Keyboard shortcuts reference modal. Opened with `?` (when not typing)
 * or from the command palette. Static list — keep in sync with the real
 * handlers (AppShell palette keys, composer Enter/Shift+Enter, etc.).
 */

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { Backdrop } from './Backdrop';
import { useShortcutsModalStore, closeShortcutsModal } from '@/store/shortcuts-modal';

const SHORTCUT_GROUPS: Array<{
  heading: string;
  items: Array<{ keys: string[]; label: string }>;
}> = [
  {
    heading: 'Global',
    items: [
      { keys: ['Ctrl', 'K'], label: 'Command palette' },
      { keys: ['Ctrl', 'P'], label: 'Command palette' },
      { keys: [','], label: 'Settings' },
      { keys: ['?'], label: 'Keyboard shortcuts' },
    ],
  },
  {
    heading: 'Composer',
    items: [
      { keys: ['Enter'], label: 'Send message' },
      { keys: ['Shift', 'Enter'], label: 'New line' },
      { keys: ['↑', '↓'], label: 'Navigate @mention / command list' },
      { keys: ['Esc'], label: 'Close popovers' },
    ],
  },
  {
    heading: 'Approvals',
    items: [
      { keys: ['1', '2', '3'], label: 'Choose permission option' },
    ],
  },
  {
    heading: 'Git panel',
    items: [{ keys: ['Ctrl', 'Enter'], label: 'Commit' }],
  },
];

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.4rem] items-center justify-center rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground/80 shadow-xs">
      {children}
    </kbd>
  );
}

export function ShortcutsModal() {
  const open = useShortcutsModalStore((s) => s.open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeShortcutsModal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <Backdrop onClose={closeShortcutsModal} className="items-start pt-[12vh]">
      <div
        className="w-[min(90vw,480px)] rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
          <button
            onClick={closeShortcutsModal}
            className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            title="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-4">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.heading}>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.heading}
              </p>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <div
                    key={item.label + item.keys.join('')}
                    className="flex items-center justify-between gap-3 rounded px-2 py-1 text-sm"
                  >
                    <span className="text-foreground/85">{item.label}</span>
                    <span className="flex items-center gap-1">
                      {item.keys.map((key, i) => (
                        <span key={key} className="flex items-center gap-1">
                          {i > 0 && (
                            <span className="text-[10px] text-muted-foreground/60">+</span>
                          )}
                          <KeyCap>{key}</KeyCap>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="pt-1 text-center text-[11px] text-muted-foreground/70">
            Ctrl = ⌘ on macOS
          </p>
        </div>
      </div>
    </Backdrop>
  );
}
