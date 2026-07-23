import { Check, RefreshCw, Play, Pause, Bug, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Speak / copy / regenerate / fork / raw-debug controls under an assistant message. */
export function AssistantMessageActions({
  showActions,
  copied,
  speaking,
  isLast,
  streaming,
  isRegenerating,
  showRaw,
  setShowRaw,
  onSpeak,
  onCopy,
  onRegen,
  onFork,
}: {
  showActions: boolean;
  copied: boolean;
  speaking: boolean;
  isLast?: boolean;
  streaming?: boolean;
  isRegenerating: boolean;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
  onSpeak: () => void;
  onCopy: () => void;
  onRegen: () => void;
  onFork?: () => void;
}) {
  return (
    <div className={cn(
      "flex items-center gap-0.5 mt-1 transition-opacity duration-150 self-start",
      showActions ? "opacity-100" : "opacity-0"
    )}>
      <button
        onClick={onSpeak}
        className={cn(
          "p-1 rounded transition",
          speaking
            ? "bg-primary/10 text-primary hover:bg-primary/20"
            : "hover:bg-muted text-muted-foreground hover:text-foreground"
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
        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition relative"
        title="Copy"
      >
        <div className={cn("transition-transform duration-200", copied ? "scale-110 text-success" : "scale-100")}>
          {copied ? (
            <Check className="size-3" />
          ) : (
            <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          )}
        </div>
      </button>
      {isLast && (
        <button
          onClick={onRegen}
          disabled={streaming || isRegenerating}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-50"
          title="Retry / Regenerate"
        >
          <RefreshCw
            className={cn("size-3", isRegenerating && "animate-spin")}
          />
        </button>
      )}
      {onFork && (
        <button
          onClick={onFork}
          disabled={streaming}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-50"
          title="Fork conversation from here"
        >
          <GitBranch className="size-3" />
        </button>
      )}
      <button
        onClick={() => setShowRaw(!showRaw)}
        className={cn("p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition", showRaw && "text-primary")}
        title="Toggle raw data"
      >
        <Bug className="size-3" />
      </button>
    </div>
  );
}
