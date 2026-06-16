/* ── FileIcon ─ brand-aware file/language icon renderer ───────────── */
/* Thin wrapper around lib/file-icon.ts. Renders the resolved icon at    */
/* the requested size, painted in its brand color, with an accessible   */
/* aria-label / title set to the icon kind (e.g. "react", "python").    */

import { getFileIcon } from '@/lib/file-icon';

export interface FileIconProps {
  /** Filename or full path. Only the basename is iconised. */
  name: string;
  /** Pixel size. Default: 12. */
  size?: number;
  className?: string;
}

export function FileIcon({ name, size = 12, className }: FileIconProps) {
  const { Icon, color, kind } = getFileIcon(name);
  // The Si icon types have a narrow prop signature that doesn't include
  // title / aria-label, so the wrapper span carries the accessibility.
  return (
    <span
      role="img"
      aria-label={kind}
      title={kind}
      className={className}
      style={{ display: 'inline-flex', lineHeight: 0 }}
    >
      <Icon size={size} color={color} />
    </span>
  );
}
