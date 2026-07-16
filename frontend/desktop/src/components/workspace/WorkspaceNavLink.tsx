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

export function WorkspaceNavLink({ icon: Icon, label, active, onSelect }: Props) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      initial="rest"
      whileHover="hover"
      whileTap="tap"
      variants={rowMotion}
      className={cn(
        'w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors text-left',
        active
          ? 'bg-white/[0.06] text-foreground font-medium'
          : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground',
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
      <span className="truncate">{label}</span>
    </motion.button>
  );
}
