import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** The mockup's mono kicker above the serif title ("Output / data",
   *  "Library / everything"). Rendered through `.page-eyebrow`, whose ::after
   *  draws the trailing hairline. */
  eyebrow?: string;
  className?: string;
}

/**
 * Standardized header used by every section.
 * Renders an icon-less title row + optional subtitle + optional right-aligned actions.
 * Section icons belong in the sidebar nav, not here.
 *
 * THE SETTINGS PAGE-HEADER STANDARD, in one place, because six panels
 * were taking FOUR title sizes and TWO weights between them:
 *
 *   title    20px semibold  (text-xl font-semibold tracking-tight)
 *   subtitle 13px muted     (text-[0.8125rem] text-muted-foreground)
 *
 * A panel that wants a different header does not roll its own <h2> with
 * its own icon and its own sizes - it uses this component, or
 * `SettingsSectionShell`, which is set to the same pair. The reference's
 * settings header is one shape, and the point of a shared component is
 * that the shape cannot drift.
 */
export function SectionHeader({ title, subtitle, actions, eyebrow, className }: Props) {
  return (
    <header className={cn('page-head', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h2 className="page-title">{title}</h2>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
