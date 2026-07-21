/* ── PermissionRequiredCard ───────────────────────────────────────────── */
/* Cursor-style approval: preview + Allow / Always / Deny + Confirm.      */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Clock, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PERMISSION_COPY } from '@/lib/permission-copy';

export type PermissionChoice = 'allow' | 'always' | 'deny';

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
];

export type PermissionRequiredCardProps = {
  description: string;
  /** Inset preview: command box, DiffView, or plain text. */
  preview?: ReactNode;
  disabled?: boolean;
  confirming?: boolean;
  className?: string;
  onConfirm: (choice: PermissionChoice) => void | Promise<void>;
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
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedIndex = CHOICES.findIndex((c) => c.id === selected);

  const move = useCallback((delta: number) => {
    setSelected((prev) => {
      const i = CHOICES.findIndex((c) => c.id === prev);
      const next = (i + delta + CHOICES.length) % CHOICES.length;
      return CHOICES[next].id;
    });
  }, []);

  const confirm = useCallback(() => {
    if (disabled || confirming) return;
    void onConfirm(selected);
  }, [confirming, disabled, onConfirm, selected]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // Focus the card so arrow/Enter work without clicking first.
    if (!disabled) el.focus({ preventScroll: true });
  }, [disabled]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (disabled || confirming) return;
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        confirm();
      } else if (e.key === '1' || e.key === '2' || e.key === '3') {
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
        'rounded-xl border border-border/60 bg-card/80 outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
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
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground"
          data-testid="permission-awaiting-badge"
        >
          <Clock className="size-3 opacity-80" aria-hidden />
          {PERMISSION_COPY.awaiting}
        </div>
      </div>

      {preview != null ? (
        <div className="mx-4 mb-3 overflow-hidden rounded-lg border border-border/50 bg-black/25">
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
            <button
              key={choice.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              disabled={disabled || confirming}
              data-testid={`permission-choice-${choice.id}`}
              data-selected={isSelected ? 'true' : 'false'}
              className={cn(
                'flex w-full items-baseline gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
                isSelected
                  ? 'bg-muted/70 text-foreground'
                  : 'text-foreground/85 hover:bg-muted/40',
                (disabled || confirming) && 'opacity-60',
              )}
              onClick={() => setSelected(choice.id)}
              onDoubleClick={() => {
                setSelected(choice.id);
                if (!disabled && !confirming) void onConfirm(choice.id);
              }}
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
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border/40 px-4 py-2.5">
        <p className="flex min-w-0 items-start gap-1.5 text-[11px] text-muted-foreground leading-snug">
          <Info className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden />
          <span>{PERMISSION_COPY.confirmHint}</span>
        </p>
        <Button
          type="button"
          size="sm"
          data-testid="permission-confirm"
          disabled={disabled || confirming}
          className="h-8 shrink-0 bg-foreground px-3 text-xs font-medium text-background hover:bg-foreground/90"
          onClick={confirm}
        >
          {confirming ? '…' : PERMISSION_COPY.confirm}
        </Button>
      </div>

      {/* Screen-reader: announce selected index */}
      <span className="sr-only" aria-live="polite">
        Option {selectedIndex + 1} of {CHOICES.length}: {CHOICES[selectedIndex]?.label}
      </span>
    </div>
  );
}

export default PermissionRequiredCard;
