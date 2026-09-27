/* ── Surface — the one elevation ladder (audit P2#17) ────────────────────
 * Four rungs, four tokens, one component. Before this, "how far off the
 * page is this surface" was decided per call site — the composer carried a
 * `shadow-md` while every sibling surface used a 1px border, so two panels
 * sitting at the same depth did not read as the same depth. `--elev-*`
 * lives in src/styles/tokens.css and is also registered in
 * tailwind.config.cjs as `shadow-elev-*`, so the utility and the primitive
 * are the same shadow by construction.
 *
 *   flat     no shadow — the page itself, or a surface whose siblings all
 *            are flat
 *   ring     a 1px edge in the border colour — the rung that agrees with
 *            bordered siblings without adding a drop shadow
 *   raised   a card lifted off the page
 *   overlay  a popover / dialog / floating panel
 *
 * This is a thin wrapper, not a redesign: it applies the elevation and
 * nothing else, so a caller keeps full control of background, border,
 * radius and padding. Prefer it over a hand-written `shadow-*` utility or
 * an inline `boxShadow` whenever the question is only "how lifted is this".
 */
import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type SurfaceElevation = 'flat' | 'ring' | 'raised' | 'overlay';

const ELEV_CLASS: Record<SurfaceElevation, string> = {
  flat: 'shadow-elev-flat',
  ring: 'shadow-elev-ring',
  raised: 'shadow-elev-raised',
  overlay: 'shadow-elev-overlay',
};

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /** Rung of the elevation ladder. Defaults to `flat` (no shadow). */
  elev?: SurfaceElevation;
}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
  function Surface({ elev = 'flat', className, ...props }, ref) {
    return (
      <div ref={ref} className={cn(ELEV_CLASS[elev], className)} {...props} />
    );
  },
);
