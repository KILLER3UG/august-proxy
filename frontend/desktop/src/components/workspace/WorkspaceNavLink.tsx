/* ── WorkspaceNavLink — left-rail nav item matching the screenshot ──── */
/* Hover uses the same row nudge + icon spring as New chat / Skills.     */

import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { t } from '@/lib/motion';
import { cn } from '@/lib/utils';

interface Props {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onSelect: () => void;
  /** Optional notice badge (e.g. update available). */
  badge?: string | null;
}

const rowMotion = {
  rest: { x: 0 },
  hover: { x: 3, transition: t.fast },
  tap: { scale: 0.98, transition: t.fast },
};

const iconMotion = {
  rest: { scale: 1, rotate: 0 },
  hover: { scale: 1.12, rotate: -18, transition: t.spring },
  tap: { scale: 0.92, transition: t.fast },
};

export function WorkspaceNavLink({
  icon: Icon,
  label,
  active,
  onSelect,
  badge,
}: Props) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      initial="rest"
      whileHover="hover"
      whileTap="tap"
      variants={rowMotion}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors',
        active
          ? 'bg-white/[0.07] font-medium text-foreground'
          : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
      )}
    >
      <motion.span
        className={cn(
          'inline-flex shrink-0',
          active ? 'text-primary' : 'text-muted-foreground',
        )}
        variants={iconMotion}
      >
        <Icon className="size-4" />
      </motion.span>
      <span className="truncate flex-1">{label}</span>
      {badge ? (
        <span className="shrink-0 rounded-sm bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
          {badge}
        </span>
      ) : null}
    </motion.button>
  );
}
