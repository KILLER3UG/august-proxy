import { Check, Copy, RefreshCw, Play, Pause, GitBranch, ArrowLeftRight, GitCompare } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Speak / copy / re-answer / regenerate / fork controls under an assistant message. */
export function AssistantMessageActions({
  showActions,
  copied,
  speaking,
  streaming,
  isRegenerating,
  onSpeak,
  onCopy,
  onRegen,
  onFork,
  onReanswer,
  reanswerOpen,
  onCompare,
}: {
  showActions: boolean;
  copied: boolean;
  speaking: boolean;
  isLast?: boolean;
  streaming?: boolean;
  isRegenerating: boolean;
  onSpeak: () => void;
  onCopy: () => void;
  onRegen: () => void;
  onFork?: () => void;
  /** "Answer this with another model" — toggles the model list in the bubble. */
  onReanswer?: () => void;
  reanswerOpen?: boolean;
  /** "Compare" — re-run the prompt on 2–3 models side by side (Arena lanes). */
  onCompare?: () => void;
}) {
  return (
    <div className={cn(
      "flex items-center gap-1 mt-1 transition-opacity duration-150 self-start",
      showActions ? "opacity-100" : "opacity-0 group-focus-within:opacity-100"
    )}>
      <button
        onClick={onSpeak}
        aria-label={speaking ? "Pause reading" : "Read aloud"}
        className={cn(
          "p-1.5 rounded-md transition-colors",
          speaking
            ? "bg-primary/10 text-primary hover:bg-primary/20"
            : "hover:bg-accent/50 text-muted-foreground hover:text-foreground"
        )}
        title={speaking ? "Pause reading" : "Read aloud"}
      >
        {speaking ? (
          <Pause className="size-3" />
        ) : (
          <Play className="size-3" />
        )}
      </button>
      <button
        onClick={onCopy}
        className="p-1.5 rounded-md hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors relative"
        title="Copy"
        aria-label="Copy"
      >
        <div className={cn("transition-transform duration-200", copied ? "scale-110 text-success" : "scale-100")}>
          {copied ? (
            <Check className="size-3" />
          ) : (
            <Copy className="size-3" />
          )}
        </div>
      </button>
      {onReanswer && (
        <button
          onClick={onReanswer}
          disabled={streaming}
          className={cn(
            "p-1.5 rounded-md hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50",
            reanswerOpen && "text-primary",
          )}
          title="Answer this with another model"
          aria-label="Answer this with another model"
          aria-expanded={reanswerOpen}
          data-testid="reanswer-open"
        >
          <ArrowLeftRight className="size-3" />
        </button>
      )}
      {onCompare && (
        <button
          onClick={onCompare}
          disabled={streaming}
          className="p-1.5 rounded-md hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          title="Compare models — re-run this prompt on 2–3 models side by side"
          aria-label="Compare models side by side"
          data-testid="compare-open"
        >
          <GitCompare className="size-3" />
        </button>
      )}
      <button
        onClick={onRegen}
        disabled={streaming || isRegenerating}
        className="p-1.5 rounded-md hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        title="Retry / Regenerate"
        aria-label="Retry / Regenerate"
      >
        <RefreshCw
          className={cn("size-3", isRegenerating && "animate-spin")}
        />
      </button>
      {onFork && (
        <button
          onClick={onFork}
          disabled={streaming}
          className="p-1.5 rounded-md hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          title="Fork conversation from here"
          aria-label="Fork conversation from here"
        >
          <GitBranch className="size-3" />
        </button>
      )}
    </div>
  );
}
