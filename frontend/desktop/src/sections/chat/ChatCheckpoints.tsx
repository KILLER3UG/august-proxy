/* ── Chat scroll checkpoints (extracted from ChatThread) ─────────────── */

import { useState, useEffect, useCallback, useMemo, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/types/chat';

export function ChatCheckpoints({ messages, scrollRef }: {
  messages: ChatMessage[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [positions, setPositions] = useState<Record<string, { top: number; visible: boolean }>>({});
  const userMessages = useMemo(() => messages.filter(m => m.role === 'user'), [messages]);

  // Calculate pill positions based on message element offsets relative to middle 50% zone
  const updatePositions = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const newPositions: Record<string, { top: number; visible: boolean }> = {};
    const containerRect = container.getBoundingClientRect();
    const containerHeight = containerRect.height;
    
    const zoneMin = containerHeight * 0.25;
    const zoneMax = containerHeight * 0.75;
    
    for (const msg of userMessages) {
      const el = document.getElementById(`msg-${msg.id}`);
      if (el) {
        const elRect = el.getBoundingClientRect();
        const relativeCenter = (elRect.top + elRect.height / 2) - containerRect.top;
        
        // Only visible if relativeCenter is within the middle 50% zone
        const visible = relativeCenter >= zoneMin && relativeCenter <= zoneMax;
        
        // Position top relative to the 50% zone (starts at zoneMin)
        const topInZone = relativeCenter - zoneMin;
        
        newPositions[msg.id] = { top: topInZone, visible };
      }
    }
    setPositions(newPositions);
  }, [userMessages, scrollRef]);

  // Update on scroll, resize, and messages change
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || userMessages.length === 0) return;
    // The scrollable ancestor is the screen-edge scroll container in
    // ChatLayout, not the ref'd div (which is no longer scrollable).
    const scrollable = container.closest('.overflow-y-auto') ?? container;
    updatePositions();
    const onScroll = () => updatePositions();
    const onResize = () => updatePositions();
    scrollable.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      scrollable.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [updatePositions, userMessages, scrollRef]);

  // IntersectionObserver to track which user message is in view
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || userMessages.length === 0) return;

    const visible = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          visible.set(entry.target.id, entry.intersectionRatio);
        } else {
          visible.delete(entry.target.id);
        }
      }
      let best: string | null = null;
      let bestRatio = 0;
      for (const [id, ratio] of visible) {
        if (ratio > bestRatio) { bestRatio = ratio; best = id; }
      }
      setActiveId(best);
    }, { root: container, rootMargin: '-80px 0px -40% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] });

    for (const msg of userMessages) {
      const el = document.getElementById(`msg-${msg.id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [userMessages, scrollRef]);

  const scrollTo = (msgId: string) => {
    const el = document.getElementById(`msg-${msgId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-primary/30', 'rounded-lg');
    setTimeout(() => el.classList.remove('ring-2', 'ring-primary/30', 'rounded-lg'), 1200);
  };

  if (userMessages.length === 0) return null;

  return (
    <div
      className="absolute right-0 top-[25%] bottom-[25%] w-10 z-20 pointer-events-none"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="relative w-full h-full">
        {userMessages.map((msg) => {
          const isActive = activeId === `msg-${msg.id}`;
          const pos = positions[msg.id];
          if (!pos) return null;

          return (
            <button
              key={msg.id}
              onClick={() => scrollTo(msg.id)}
              aria-label={`Go to message`}
              style={{ 
                top: `${pos.top}px`,
                opacity: pos.visible ? (hovered ? 1 : 0.4) : 0,
                pointerEvents: pos.visible ? 'auto' : 'none'
              }}
              className={cn(
                'checkpoint-pill pill-appear',
                isActive ? 'active' : 'inactive'
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

