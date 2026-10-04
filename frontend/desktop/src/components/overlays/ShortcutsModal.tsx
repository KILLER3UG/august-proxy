/**
 * Keyboard shortcuts reference modal. Opened with `?` (when not typing) or
 * from the command palette. The list comes from lib/shortcuts.ts — the SAME
 * array App.tsx binds from, so a binding can no longer ship undocumented
 * (Ctrl+N lived a year+ missing from the hand-written list).
 *
 * Two search modes, ChatGPT-parity: type text to filter, or press a
 * combination to find what it does.
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Backdrop } from './Backdrop';
import { useShortcutsModalStore, closeShortcutsModal } from '@/store/shortcuts-modal';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { SHORTCUT_GROUPS, comboFor, findByCombo } from '@/lib/shortcuts';

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.4rem] items-center justify-center rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-2xs font-medium text-foreground/80 shadow-xs">
      {children}
    </kbd>
  );
}

export function ShortcutsModal() {
  const open = useShortcutsModalStore((s) => s.open);
  const trapRef = useFocusTrap<HTMLDivElement>();
  // Two search modes (ChatGPT parity): type to filter, or press a combination
  // to learn what it does.
  const [query, setQuery] = useState('');
  const [hitCombo, setHitCombo] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeShortcutsModal();
        return;
      }
      if (e.key === 'Tab' || e.key === 'Shift') return;
      const combo = comboFor(e);
      if (!findByCombo(combo)) return;
      // Only swallow the key when it IS a real binding, so the modal can
      // still be dismissed with Escape and typing keeps working.
      e.preventDefault();
      e.stopPropagation();
      setHitCombo(combo);
      setQuery('');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setHitCombo(null);
    }
  }, [open]);

  const hit = hitCombo ? findByCombo(hitCombo) : undefined;
  const needle = query.trim().toLowerCase();
  const groups = SHORTCUT_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) => !needle || i.label.toLowerCase().includes(needle) || i.keys.join('+').toLowerCase().includes(needle),
    ),
  })).filter((g) => g.items.length > 0);

  if (!open) return null;

  return (
    <Backdrop onClose={closeShortcutsModal} className="items-start pt-[12vh]">
      <div
        ref={trapRef}
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
            title="Close" aria-label="Close"
          >
            <X className="size-3" />
          </button>
        </div>
        <div className="border-b border-border px-4 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search, or press a combination…"
            aria-label="Search shortcuts"
            className="w-full rounded-md border border-border/70 bg-background/60 px-2.5 py-1.5 text-xs outline-none transition placeholder:text-muted-foreground/60 focus:border-primary/50"
            data-testid="shortcuts-search"
          />
          {hit && (
            <p className="mt-2 text-2xs text-muted-foreground" data-testid="shortcuts-hit">
              <KeyCap>{hit.keys.join(' + ')}</KeyCap>{' '}
              <span className="text-foreground/85">{hit.label}</span>
            </p>
          )}
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-4">
          {groups.map((group) => (
            <div key={group.heading}>
              <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
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
                            <span className="text-2xs text-muted-foreground/60">+</span>
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
          {groups.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground/70">
              No shortcut matches “{query}”.
            </p>
          )}
          <p className="pt-1 text-center text-2xs text-muted-foreground/70">
            Ctrl = ⌘ on macOS
          </p>
        </div>
      </div>
    </Backdrop>
  );
}
