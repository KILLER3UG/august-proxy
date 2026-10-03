import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('rounded-lg border border-border bg-card text-card-foreground shadow-sm', className)}
        {...props}
      />
    );
  },
);
export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return <div ref={ref} className={cn('flex flex-col gap-1.5 px-5 py-4 border-b border-border', className)} {...props} />;
  },
);
export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...props }, ref) {
    return <h3 ref={ref} className={cn('text-sm font-semibold leading-none', className)} {...props} />;
  },
);
export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn('px-5 py-4', className)} {...props} />;
  },
);

/* ── Surface — the one elevation ladder ──────────────────────────────────
 * Four rungs, four tokens (`--elev-*` in styles/tokens.css, registered in
 * tailwind.config.cjs as `shadow-elev-*`), one primitive:
 *   flat     no shadow — the page itself, or a surface whose siblings all
 *            are flat
 *   ring     a 1px edge in the border colour — the rung that agrees with
 *            bordered siblings without adding a drop shadow
 *   raised   a card lifted off the page
 *   overlay  a popover / dialog / floating panel
 * A thin wrapper: it applies the elevation and nothing else, so a caller
 * keeps full control of background, border, radius and padding. Prefer it
 * over a hand-written `shadow-*` utility whenever the question is only
 * "how lifted is this".
 */
export type SurfaceElevation = 'flat' | 'ring' | 'raised' | 'overlay';

const ELEV_CLASS: Record<SurfaceElevation, string> = {
  flat: 'shadow-elev-flat',
  ring: 'shadow-elev-ring',
  raised: 'shadow-elev-raised',
  overlay: 'shadow-elev-overlay',
};

export const Surface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { elev?: SurfaceElevation }>(
  function Surface({ elev = 'flat', className, ...props }, ref) {
    return <div ref={ref} className={cn(ELEV_CLASS[elev], className)} {...props} />;
  },
);
