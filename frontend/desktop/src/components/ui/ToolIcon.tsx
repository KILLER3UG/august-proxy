/* ── ToolIcon ─ brand-aware tool/command/event icon renderer ──────── */
/* Thin wrapper around lib/tool-icon.ts. Renders the resolved icon at   */
/* the requested size, painted in its brand color, with an accessible   */
/* aria-label / title set to the icon kind (e.g. "npm", "git", "ran").  */
/*                                                                       */
/* When the resolved kind is `exploring` or `thinking` (or any future   */
/* kind flagged `isAnimated`), the rendered icon gets `animate-spin`    */
/* automatically so in-flight tool calls spin without extra wiring.     */

import { cn } from '@/lib/utils';
import { getToolIcon } from '@/lib/tool-icon';

export interface ToolIconProps {
  /** Tool name (e.g. `read_file`, `@web_search`) or shell command string. */
  name: string;
  /** `'tool'` (default) or `'command'`. Commands are parsed for the first real binary. */
  kind?: 'tool' | 'command';
  /** Pixel size. Default: 12. */
  size?: number;
  className?: string;
}

export function ToolIcon({ name, kind = 'tool', size = 12, className }: ToolIconProps) {
  const { Icon, color, kind: resolvedKind, isAnimated } = getToolIcon(name, kind);
  const tooltip = kind === 'command' ? `${resolvedKind}: ${name}` : resolvedKind;
  // The Si icon types have a narrow prop signature that doesn't include
  // title / aria-label, so the wrapper span carries the accessibility.
  return (
    <span
      role="img"
      aria-label={resolvedKind}
      title={tooltip}
      className={cn(isAnimated && 'animate-spin', className)}
      style={{ display: 'inline-flex', lineHeight: 0 }}
    >
      <Icon size={size} color={color} />
    </span>
  );
}
