import { useEffect, useState, type RefObject } from 'react';
import { ChevronUp } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

const SHOW_AFTER_PX = 200;

/**
 * Floating scroll-to-top control. Mount next to the scroll-to-bottom chevron
 * inside the chat scroll container. Listens on the closest overflow-y-auto
 * ancestor (or the scroll parent ref if provided).
 */
export function ScrollToTopButton({
  scrollParentRef,
  visible: visibleOverride,
}: {
  /** Optional external scroll parent; falls back to closest .overflow-y-auto. */
  scrollParentRef?: RefObject<HTMLElement | null>;
  /** When provided, skip internal scroll listener (parent drives visibility). */
  visible?: boolean;
}) {
  const [internalVisible, setInternalVisible] = useState(false);
  const visible = visibleOverride ?? internalVisible;

  useEffect(() => {
    if (visibleOverride !== undefined) return;
    const el =
      scrollParentRef?.current ??
      (document.querySelector('.chat-scroll.overflow-y-auto')) ??
      (document.querySelector('.overflow-y-auto.chat-scroll'));
    if (!el) return;

    const check = () => setInternalVisible(el.scrollTop > SHOW_AFTER_PX);
    check();
    el.addEventListener('scroll', check, { passive: true });
    return () => el.removeEventListener('scroll', check);
  }, [scrollParentRef, visibleOverride]);

  const scrollToTop = () => {
    const el =
      scrollParentRef?.current ??
      (document.querySelector('.chat-scroll'));
    if (!el) return;
    const target = (el.closest('.overflow-y-auto')) ?? el;
    target.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          type="button"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.2 }}
          onClick={scrollToTop}
          className="pointer-events-auto w-9 h-9 flex items-center justify-center rounded-full bg-background/80 backdrop-blur-sm border border-border shadow-sm text-muted-foreground hover:text-foreground hover:bg-background/95 transition-colors cursor-pointer"
          aria-label="Scroll to top"
        >
          <ChevronUp className="size-4" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

export { SHOW_AFTER_PX as SCROLL_TO_TOP_THRESHOLD };
