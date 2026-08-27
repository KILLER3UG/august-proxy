/* ── DocumentBadge ─ big square letter badge for document rows ────── */
/* ZCode-reference deliverable glyph: a 56×56 rounded square with a short   */
/* two/three-letter mark (`M↓`, `PDF`, `IMG`), tone keyed off the file kind */
/* (plan §4.5). Used by ChangesCard document rows.                          */

import { cn } from '@/lib/utils';
import type { FileKind } from '@/lib/file-kind';

const TONE_CLASSES: Record<FileKind, string> = {
  document: 'bg-amber-500/15 text-amber-500',
  pdf: 'bg-rose-500/15 text-rose-400',
  image: 'bg-sky-500/15 text-sky-400',
  video: 'bg-fuchsia-500/15 text-fuchsia-400',
  code: 'bg-muted text-muted-foreground',
};

export function DocumentBadge({
  text,
  tone,
  size = 56,
  className,
}: {
  /** Short glyph, e.g. `M↓`, `PDF`. */
  text: string;
  tone: FileKind;
  /** Square edge in px (reference uses 56). */
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-xl border border-white/[0.06] font-semibold tracking-tight',
        TONE_CLASSES[tone],
        text.length > 2 ? 'text-[13px]' : 'text-[17px]',
        className,
      )}
      style={{ width: size, height: size }}
      data-testid="document-badge"
      data-tone={tone}
      aria-hidden="true"
    >
      {text}
    </span>
  );
}
