/* ── Voice listening chrome ────────────────────────────────────────────── */
/* Replaces the textarea while the mic is active.                          */

export function ComposerVoiceListening() {
  return (
    <div className="h-[128px] w-full flex flex-col items-center justify-center bg-background/90 backdrop-blur-sm space-y-2 text-foreground">
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
        August is listening…
      </span>
    </div>
  );
}
