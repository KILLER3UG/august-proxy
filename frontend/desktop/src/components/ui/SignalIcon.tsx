/* ── SignalIcon — the mockup's icon vocabulary ─────────────────────────
 *
 * The ported surfaces do not use lucide. The mockup draws 48 symbols with a
 * consistent 24px grid, 1.6 stroke and square caps, and swapping in a
 * different icon set changes the chrome's weight even when every size is
 * identical. SIGNAL_SPRITE is the mockup's own sprite, copied verbatim.
 *
 * <SignalSprite/> must be mounted once (ChatLayout renders it); <SignalIcon/>
 * is a thin <use> reference, which is why 48 icons cost one string.
 */

import { SIGNAL_SPRITE, type SignalIconName } from './signal-icons';

export type { SignalIconName };

/** The sprite itself. Rendered once, hidden, never interactive. */
export function SignalSprite() {
  return (
    <svg
      className="sd-sprite"
      aria-hidden="true"
      focusable="false"
      // Static, in-repo markup: no user input reaches this string.
      dangerouslySetInnerHTML={{ __html: SIGNAL_SPRITE }}
    />
  );
}

interface SignalIconProps {
  name: SignalIconName;
  /** `icon` is 16px, `icon-sm` is 13px, `icon-lg` is 20px — the mockup's three. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  title?: string;
}

export function SignalIcon({ name, size = 'sm', className, title }: SignalIconProps) {
  const cls = [size === 'sm' ? 'icon-sm' : size === 'md' ? 'icon' : 'icon-lg', className]
    .filter(Boolean)
    .join(' ');
  return (
    <svg className={cls} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <use href={`#i-${name}`} />
    </svg>
  );
}
