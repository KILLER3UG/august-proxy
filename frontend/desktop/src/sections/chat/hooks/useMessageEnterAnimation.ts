/* Track which message ids should play the enter animation.
 * Decisions are sticky for the session so a follow-up re-render
 * (assistant placeholder, stream tick) cannot cancel mid-flight. */

import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@/types/chat';

export function useMessageEnterAnimation(
  messages: ChatMessage[],
  sessionId: string | null,
) {
  const seenIdsRef = useRef<Set<string>>(new Set());
  const animateIdsRef = useRef<Set<string>>(new Set());
  const sessionRef = useRef<string | null | undefined>(undefined);
  const readyRef = useRef(false);

  if (sessionRef.current !== sessionId) {
    sessionRef.current = sessionId;
    seenIdsRef.current = new Set(messages.map((m) => m.id));
    animateIdsRef.current = new Set();
    // Empty thread: wait for either a history hydrate or the first live send.
    readyRef.current = messages.length > 0;
  } else if (!readyRef.current && messages.length > 0) {
    // History hydrate arrives as a batch — don't animate those.
    // A single message on an empty thread is a live send — allow animate.
    if (messages.length > 1) {
      seenIdsRef.current = new Set(messages.map((m) => m.id));
    }
    readyRef.current = true;
  }

  useEffect(() => {
    for (const m of messages) {
      seenIdsRef.current.add(m.id);
    }
    if (messages.length > 0) readyRef.current = true;
  }, [messages]);

  return (id: string) => {
    if (animateIdsRef.current.has(id)) return true;
    if (!readyRef.current && messages.length !== 1) return false;
    if (seenIdsRef.current.has(id)) return false;
    animateIdsRef.current.add(id);
    return true;
  };
}
