/* ── PermissionRequiredCard ───────────────────────────────────────────── */
/* Approval prompt shown before a gated tool call executes:                */
/* header + terminal-style preview + numbered choices (Allow / Always /   */
/* Deny / free-form instructions) + Confirm. Select with Tab/arrows or    */
/* click, then confirm with Enter or the Confirm button.                  */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Clock, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PERMISSION_COPY } from '@/lib/permission-copy';

export type PermissionChoice = 'allow' | 'always' | 'deny' | 'instructions';

const CHOICES: Array<{
  id: PermissionChoice;
  label: string;
  hint: string;
}> = [
  {
    id: 'allow',
    label: PERMISSION_COPY.allow,
    hint: PERMISSION_COPY.allowHint,
  },
  {
    id: 'always',
    label: PERMISSION_COPY.always,
    hint: PERMISSION_COPY.alwaysHint,
  },
  {
    id: 'deny',
    label: PERMISSION_COPY.deny,
    hint: PERMISSION_COPY.denyHint,
  },
  {
    id: 'instructions',
    label: PERMISSION_COPY.instructions,
    hint: PERMISSION_COPY.instructionsHint,
  },
];

export type PermissionRequiredCardProps = {
  description: string;
  /** Inset preview: terminal-style command block, DiffView, or plain text. */
  preview?: ReactNode;
  disabled?: boolean;
  confirming?: boolean;
  className?: string;
  /** Called with the selected choice; for 'instructions', the typed text. */
  onConfirm: (choice: PermissionChoice, instructions?: string) => void | Promise<void>;
};

export function PermissionRequiredCard({
  description,
  preview,
  disabled = false,
  confirming = false,
  className,
  onConfirm,
}: PermissionRequiredCardProps) {
  const [selected, setSelected] = useState<PermissionChoice>('allow');
  const [instructions, setInstructions] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedIndex = CHOICES.findIndex((c) => c.id === selected);
  const instructionsReady =
    selected !== 'instructions' || instructions.trim().length > 0;
  const canConfirm = !disabled && !confirming && instructionsReady;

  const move = useCallback((delta: number) => {
    setSelected((prev) => {
      const i = CHOICES.findIndex((c) => c.id === prev);
      const next = (i + delta + CHOICES.length) % CHOICES.length;
      return CHOICES[next].id;
    });
  }, []);

  const confirm = useCallback(() => {
    if (!canConfirm) return;
    void onConfirm(
      selected,
      selected === 'instructions' ? instructions.trim() : undefined,
    );
  }, [canConfirm, instructions, onConfirm, selected]);

  // Focus the card on mount so Tab/arrows/Enter work without clicking first.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || disabled) return;
    el.focus({ preventScroll: true });
  }, [disabled]);

  // Selecting the instructions row focuses its input.
  useEffect(() => {
    if (selected === 'instructions' && !disabled) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [selected, disabled]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (disabled || confirming) return;
      // The instructions input manages its own keys (Enter submits there).
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        confirm();
      } else if (e.key >= '1' && e.key <= '4') {
        const idx = Number(e.key) - 1;
        if (CHOICES[idx]) {
          e.preventDefault();
          setSelected(CHOICES[idx].id);
        }
      }
    };

    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [confirm, confirming, disabled, move]);

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role="group"
      aria-label={PERMISSION_COPY.title}
      data-testid="permission-required-card"
      className={cn(
        'rounded-xl border border-border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            {PERMISSION_COPY.title}
          </div>
          {description ? (
            <p className="mt-0.5 text-[13px] text-muted-foreground leading-snug">
              {description}
            </p>
          ) : null}
        </div>
        <div
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground"
          data-testid="permission-awaiting-badge"
        >
          <Clock className="size-3 opacity-80" aria-hidden />
          {PERMISSION_COPY.awaiting}
        </div>
      </div>

      {preview != null ? (
        <div
          className="mx-4 mb-3 overflow-hidden rounded-lg border border-border bg-code-block text-code-block"
          data-testid="permission-preview"
        >
          <div className="max-h-56 overflow-auto">{preview}</div>
        </div>
      ) : null}

      <div
        role="listbox"
        aria-label="Permission choice"
        className="px-2 pb-2"
        data-testid="permission-choices"
      >
        {CHOICES.map((choice, index) => {
          const isSelected = choice.id === selected;
          return (
            <div key={choice.id}>
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={disabled || confirming}
                data-testid={`permission-choice-${choice.id}`}
                data-selected={isSelected ? 'true' : 'false'}
                className={cn(
                  'flex w-full items-baseline gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
                  isSelected
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground hover:bg-muted',
                  (disabled || confirming) && 'opacity-60',
                )}
                onClick={() => setSelected(choice.id)}
              >
                <span className="w-4 shrink-0 tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="font-medium">{choice.label}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    {choice.hint}
                  </span>
                </span>
              </button>
              {choice.id === 'instructions' && isSelected ? (
                <div className="px-2.5 pb-2 pt-0.5">
                  <input
                    ref={inputRef}
                    type="text"
                    value={instructions}
                    disabled={disabled || confirming}
                    data-testid="permission-instructions-input"
                    placeholder={PERMISSION_COPY.instructionsPlaceholder}
                    className={cn(
                      'w-full rounded-md border border-input bg-background px-2.5 py-1.5',
                      'text-[13px] text-foreground outline-none placeholder:text-muted-foreground',
                      'focus-visible:ring-2 focus-visible:ring-ring',
                    )}
                    onChange={(e) => setInstructions(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        confirm();
                      } else if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        move(1);
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        move(-1);
                      }
                    }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
        <p className="flex min-w-0 items-start gap-1.5 text-[11px] text-muted-foreground leading-snug">
          <Info className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden />
          <span>{PERMISSION_COPY.confirmHint}</span>
        </p>
        <button
          type="button"
          data-testid="permission-confirm"
          disabled={!canConfirm}
          className={cn(
            'h-8 shrink-0 rounded-full bg-foreground px-4 text-xs font-medium text-background',
            'transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50',
          )}
          onClick={confirm}
        >
          {confirming ? '…' : PERMISSION_COPY.confirm}
        </button>
      </div>

      {/* Screen-reader: announce selected index */}
      <span className="sr-only" aria-live="polite">
        Option {selectedIndex + 1} of {CHOICES.length}: {CHOICES[selectedIndex]?.label}
      </span>
    </div>
  );
}

export default PermissionRequiredCard;
