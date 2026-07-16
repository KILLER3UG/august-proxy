import { useState, useEffect } from 'react';
import { ThinkingDisclosure } from '@/components/chat/ThinkingDisclosure';
import { Markdown } from '../ChatMarkdown';

/** Collapsible thinking / reasoning disclosure for assistant turns. */
export function ReasoningBlock({
  text,
  segments,
  isGenerating,
  duration,
  omitDurationLabel,
  thoughtCount,
}: {
  /** Single thinking body (used when `segments` is not provided). */
  text?: string;
  /**
   * Multiple thinking segments collapsed under one header. When expanded,
   * each segment renders the normal thought style (border-l + markdown).
   */
  segments?: string[];
  isGenerating?: boolean;
  duration?: number;
  /** Suppress "Thought for Xs" when a following ToolSummary already badges thought count. */
  omitDurationLabel?: boolean;
  /**
   * When multiple thinking segments were merged into one disclosure, show
   * e.g. "Thinking (3)" / "Thought (3)". Single thoughts use the normal label.
   */
  thoughtCount?: number;
}) {
  // Live-tick the elapsed time in the Thinking label while the model is
  // thinking. The interval stops as soon as this thinking section is done.
  const [elapsed, setElapsed] = useState<number>(0);
  useEffect(() => {
    if (!isGenerating) return;
    const startedAt = Date.now();
    const tick = () => setElapsed((Date.now() - startedAt) / 1000);
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [isGenerating]);

  const parts = (segments && segments.length > 0
    ? segments
    : text
      ? [text]
      : []
  ).map((s) => s.trim()).filter(Boolean);

  const n = thoughtCount ?? parts.length;
  // Only badge the count when we actually collapsed multiple segments.
  const multi = n > 1;
  const countLabel = multi
    ? isGenerating
      ? `Thinking (${n})`
      : `Thought (${n})`
    : undefined;

  return (
    <div className="my-1" style={{ overflowAnchor: 'none' }}>
      <ThinkingDisclosure
        pending={isGenerating}
        duration={duration}
        elapsed={isGenerating ? elapsed : undefined}
        omitDurationLabel={omitDurationLabel || multi}
        label={countLabel}
      >
        {parts.length > 0 ? (
          <div className="flex flex-col gap-2">
            {parts.map((part, i) => (
              <div
                key={i}
                className="pl-3 chat-rail py-1 thought-content chat-thought-text"
              >
                <Markdown content={part} />
              </div>
            ))}
          </div>
        ) : null}
      </ThinkingDisclosure>
    </div>
  );
}
