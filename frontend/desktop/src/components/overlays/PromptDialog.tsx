import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cn } from '@/lib/utils';
import { Backdrop } from './Backdrop';

/**
 * PromptDialog — the styled replacement for `window.prompt`.
 *
 * `window.prompt` is unstyled next to the app's ConfirmDialogs, and it is a
 * silent no-op in some Tauri webviews (WKWebView-based builds, the mobile
 * WebView), where rename simply did nothing. Every text prompt in the shell
 * goes through this instead.
 *
 * Same contract as ConfirmDialog: Escape cancels (and consumes the event so
 * an enclosing overlay does not also close), Enter confirms, the input is
 * focused with its text preselected so typing replaces it.
 */
export function PromptDialog({
  open,
  title,
  label,
  initialValue = '',
  placeholder,
  confirmLabel = 'Save',
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** Accessible label for the input. */
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Receives the trimmed value. Empty values are not submitted. */
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);

  // Re-seed when (re)opened for a different target.
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // One Escape closes one layer (see ConfirmDialog).
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  useEffect(() => {
    if (!open) return;
    // Focus + full preselection: typing replaces, like window.prompt did.
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  return (
    <Backdrop onClose={onCancel} className="z-[70]">
      <div
        className="w-[min(92vw,400px)] rounded-2xl border border-border bg-card shadow-2xl px-5 pt-5 pb-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-dialog-title"
        data-testid="prompt-dialog"
      >
        <h2
          id="prompt-dialog-title"
          className="text-[0.9375rem] font-semibold tracking-tight text-foreground"
        >
          {title}
        </h2>
        <form onSubmit={handleFormSubmit}>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={label}
            placeholder={placeholder}
            maxLength={120}
            className={cn(
              'mt-3 w-full rounded-lg border border-border/70 bg-background/60 px-3 py-2 text-sm',
              'text-foreground placeholder:text-muted-foreground/50 outline-none transition',
              'focus:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/50',
            )}
            data-testid="prompt-dialog-input"
          />
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-border px-3.5 py-1.5 text-[0.8125rem] font-medium text-foreground/90 hover:bg-accent transition"
            >
              Cancel
              <span className="ml-1.5 text-muted-foreground/60 text-2xs">Esc</span>
            </button>
            <button
              type="submit"
              disabled={!value.trim()}
              className="rounded-lg bg-primary px-3.5 py-1.5 text-[0.8125rem] font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
              data-testid="prompt-dialog-confirm"
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </Backdrop>
  );
}