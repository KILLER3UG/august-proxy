interface LiveCaptionsProps {
  partial: string;
  transcript: string;
}

export function LiveCaptions({ partial, transcript }: LiveCaptionsProps) {
  return (
    <div
      className="text-center max-w-2xl mx-auto px-4"
      aria-live="polite"
      data-testid="live-captions"
    >
      {transcript && (
        <p data-testid="captions-final" className="text-xl leading-relaxed text-foreground">
          {transcript}
        </p>
      )}
      {partial && (
        <p
          data-testid="captions-partial"
          className="text-lg leading-relaxed text-muted-foreground opacity-60 mt-1"
        >
          {partial}
        </p>
      )}
    </div>
  );
}
