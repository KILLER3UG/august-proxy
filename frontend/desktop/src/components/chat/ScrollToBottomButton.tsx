/* ── ScrollToBottomButton ──────────────────────────────────────────────────
 * The jump-to-bottom affordance. Lives inside the composer card so it can
 * straddle the card's top border (centered), instead of floating in the
 * message pane's bottom-right corner where it covered the transcript. The
 * parent controls the anchor via the wrapper's `absolute` class.
 */

import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

export function ScrollToBottomButton({
  visible,
  onClick,
  showNewContentPill,
}: {
  visible: boolean;
  onClick: () => void;
  showNewContentPill: boolean;
}) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          type="button"
          initial={{ opacity: 0, y: 6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.96 }}
          transition={{ duration: 0.18 }}
          onClick={onClick}
          className={
            showNewContentPill
              ? 'pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-background/90 backdrop-blur-sm border border-border shadow-sm px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background transition-colors cursor-pointer'
              : 'pointer-events-auto w-9 h-9 flex items-center justify-center rounded-full bg-background/80 backdrop-blur-sm border border-border shadow-sm text-muted-foreground hover:text-foreground hover:bg-background/95 transition-colors cursor-pointer'
          }
          aria-label={showNewContentPill ? 'Jump to new content' : 'Scroll to bottom'}
        >
          <ChevronDown className={showNewContentPill ? 'size-3.5 shrink-0' : 'size-4'} />
          {showNewContentPill ? 'New content' : null}
        </motion.button>
      )}
    </AnimatePresence>
  );
}
