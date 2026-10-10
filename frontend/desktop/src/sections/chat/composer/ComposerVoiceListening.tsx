/* ── Voice listening chrome ────────────────────────────────────────────── */
/* Replaces the textarea while the mic is active.                          */

import { Square } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ComposerVoiceListening({ onStop }: { onStop?: () => void }) {
  return (
    <div className="h-[128px] w-full flex flex-col items-center justify-center gap-3 bg-background/90 backdrop-blur-sm text-foreground">
      <div className="flex items-center gap-1">
        <span className="w-1 h-4 bg-primary rounded animate-pulse" />
        <span
          className="w-1 h-6 bg-primary rounded animate-pulse"
          style={{ animationDelay: '150ms' }}
        />
        <span
          className="w-1 h-8 bg-primary rounded animate-pulse"
          style={{ animationDelay: '300ms' }}
        />
        <span
          className="w-1 h-5 bg-primary rounded animate-pulse"
          style={{ animationDelay: '450ms' }}
        />
        <span
          className="w-1 h-3 bg-primary rounded animate-pulse"
          style={{ animationDelay: '600ms' }}
        />
      </div>
      <span className="text-xs font-semibold tracking-wide text-primary animate-pulse">
        Listening…
      </span>
      {/* A visible listening state MUST have a way out. Without a stop control
          the only escape is waiting for the one-shot session to self-end, which
          is exactly why a prominent mic was unsafe before stopVoiceInput
          existed. */}
      {onStop && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onStop}
          aria-label="Stop listening"
          title="Stop listening"
          data-testid="voice-stop"
          className="h-6 gap-1.5 rounded-full px-3 text-2xs"
        >
          <Square className="size-2.5 fill-current" />
          Stop
        </Button>
      )}
    </div>
  );
}
