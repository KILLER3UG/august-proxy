import { useState, useCallback, type FormEvent, type KeyboardEvent, useRef } from 'react';
import { HelpCircle, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * ClarifyTool — inline question/answer with choices + freeform text
 *
 * Inline interactive Q&A panel:
 * - Shows a question with radio-button choices
 * - "Other" option opens freeform text input
 * - After answering, collapses to standard tool block
 */
interface ClarifyToolProps {
  question: string;
  choices?: string[];
  onSubmit: (answer: string) => void;
  submitting?: boolean;
}

const OPTION_ROW_CLASS =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors';

function RadioDot({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-3.5 shrink-0 place-items-center rounded-full border transition-colors',
        selected ? 'border-primary' : 'border-muted-foreground/40'
      )}
    >
      {selected && <span className="size-1.5 rounded-full bg-primary" />}
    </span>
  );
}

export function ClarifyTool({ question, choices, onSubmit, submitting = false }: ClarifyToolProps) {
  const hasChoices = choices && choices.length > 0;
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const respond = useCallback(
    (answer: string) => {
      if (submitting || !answer.trim()) return;
      onSubmit(answer.trim());
    },
    [onSubmit, submitting]
  );

  const handleTextareaKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        const trimmed = draft.trim();
        if (trimmed) respond(trimmed);
      }
    },
    [draft, respond]
  );

  const handleSubmitFreeform = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = draft.trim();
      if (trimmed) respond(trimmed);
    },
    [draft, respond]
  );

  return (
    <div
      className="relative mb-3 mt-2 grid gap-4 rounded-xl border border-border/70 bg-card/40 px-3 py-2.5 text-sm shadow-sm"
      data-slot="clarify-inline"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-inset ring-primary/15">
          <HelpCircle className="size-3.5" />
        </span>
        <span className="flex-1 whitespace-pre-wrap text-sm font-medium leading-snug text-foreground">
          {question || <em className="font-normal text-muted-foreground/70">Loading question...</em>}
        </span>
      </div>

      {!typing && hasChoices && (
        <div className="grid gap-0.5" role="group">
          {choices.map((choice, index) => (
            <button
              className={cn(
                OPTION_ROW_CLASS,
                'text-foreground/95 hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-55',
                selectedChoice === choice && 'bg-accent/60'
              )}
              data-choice
              disabled={submitting}
              key={`${index}-${choice}`}
              onClick={() => {
                setSelectedChoice(choice);
                respond(choice);
              }}
              type="button"
            >
              <RadioDot selected={selectedChoice === choice} />
              <span className="flex-1 wrap-anywhere">{choice}</span>
              {selectedChoice === choice && <Check aria-hidden className="size-4 shrink-0 text-primary" />}
            </button>
          ))}
          <button
            className={cn(OPTION_ROW_CLASS, 'text-muted-foreground hover:bg-accent/40 hover:text-foreground')}
            disabled={submitting}
            onClick={() => {
              setTyping(true);
              window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 0);
            }}
            type="button"
          >
            <RadioDot selected={false} />
            <span className="flex-1">Other (type your answer)</span>
          </button>
        </div>
      )}

      {(typing || !hasChoices) && (
        <form className="grid gap-2" onSubmit={handleSubmitFreeform}>
          <textarea
            className="min-h-20 resize-y rounded-lg border border-border/50 bg-muted/40 p-2 text-xs focus-visible:bg-background/60 focus:outline-none focus:ring-1 focus:ring-primary/30"
            disabled={submitting}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={handleTextareaKey}
            placeholder="Type your answer..."
            ref={textareaRef as any}
            value={draft}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground/70">⌘+↵ to send</span>
            <div className="flex items-center gap-1.5">
              {hasChoices && (
                <Button
                  disabled={submitting}
                  onClick={() => {
                    setTyping(false);
                    setDraft('');
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Back
                </Button>
              )}
              <Button disabled={submitting} size="sm" type="submit">
                {submitting ? <Loader2 className="size-3.5 animate-spin" /> : 'Send'}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
