import { RefreshCw } from 'lucide-react';
import { useStreamReconnecting } from '@/store/streamLink';

/**
 * Shown while the SSE link for a session is in a reconnect backoff. The turn
 * keeps running server-side — without this, a dropped stream looked like a
 * hung reply, because the retry was only ever logged to the console.
 */
export function StreamLinkBanner({ sessionId }: { sessionId?: string | null }) {
  const link = useStreamReconnecting(sessionId);
  if (!link) return null;
  return (
    <div
      role="status"
      data-testid="stream-reconnecting"
      className="mb-1.5 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning"
    >
      <RefreshCw className="size-3 shrink-0 animate-spin" />
      <span className="flex-1 min-w-0">
        Stream interrupted — reconnecting (attempt {link.attempt}). The agent keeps
        running; output resumes on its own.
      </span>
    </div>
  );
}
