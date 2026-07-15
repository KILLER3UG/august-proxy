/**
 * Client-side AbortControllers for the active generation turn of each
 * session. Distinct from the durable SSE subscriber (session-subscriber):
 * aborting a turn stops that turn's POST/reconnect fetches and chatRuntime
 * turn, but does not by itself detach the long-lived stream subscriber.
 */

/** Keep track of active fetch AbortControllers on the client */
export const activeStreamControllers = new Map<string, AbortController>();

/** True when this session has a registered per-turn AbortController. */
export function isSessionStreaming(sessionId: string | null): boolean {
  if (!sessionId) return false;
  return activeStreamControllers.has(sessionId);
}
