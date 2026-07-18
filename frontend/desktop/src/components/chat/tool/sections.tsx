import { useState } from 'react';
import { AlertCircle, CheckCircle2, Code2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import {
  formatToolResult,
  formatToolError,
  type FormattedContext,
} from '@/lib/tool-context-format';

/** Shared scroll shell for long tool result panes (search hits, list_skills, etc.). */
export const RESULT_SCROLL =
  'tool-result-scroll min-h-0 max-h-52 overflow-y-auto overflow-x-hidden overscroll-contain';

function ScrollBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('min-w-0', RESULT_SCROLL, className)}
      // Keep wheel/trackpad gestures inside this pane so the chat transcript
      // does not steal scroll while the user is reading a clipped tool result.
      onWheel={(e) => {
        const el = e.currentTarget;
        if (el.scrollHeight > el.clientHeight) e.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}

export function Section({
  label,
  children,
  tone,
}: {
  label: string;
  children: React.ReactNode;
  tone?: 'error';
}) {
  return (
    <div className="mt-1.5 max-w-full">
      <div
        className={cn(
          'rounded-md border px-2.5 py-1.5',
          tone === 'error'
            ? 'border-destructive/30 bg-destructive/10'
            : 'border-white/[0.05] bg-white/[0.02]',
        )}
      >
        <div
          className={cn(
            'mb-0.5 text-[10px] uppercase tracking-widest font-semibold',
            tone === 'error' ? 'text-destructive' : 'text-muted-foreground/60',
          )}
        >
          {label}
        </div>
        <ScrollBody className="text-muted-foreground">{children}</ScrollBody>
      </div>
    </div>
  );
}

/**
 * Render a section as a friendly summary line inside its own bordered container.
 * `format` is one of `formatToolContext` / `formatToolResult`; if it returns
 * null we fall back to rendering the raw text verbatim. Summary text is
 * rendered through the chat Markdown renderer so bold/lists/code match the
 * chat area.
 *
 * The optional `kind` on the formatted result drives a small status icon
 * (`✅` for success, default for neutral) so success/error states are
 * visually obvious at a glance.
 */
export function FormattedSection({
  toolName,
  label,
  raw,
  format,
  tone,
}: {
  toolName: string;
  label: string;
  raw: string;
  format: (toolName: string, raw: string) => FormattedContext | null;
  tone?: 'error';
}) {
  const formatted = format(toolName, raw);
  const summary = formatted?.summary ?? raw;

  const isSuccess = formatted?.kind === 'success';

  return (
    <div className="mt-1.5 max-w-full">
      <div
        className={cn(
          'rounded-md border px-2.5 py-1.5',
          isSuccess ? 'border-success/25 bg-success/5' : 'border-white/[0.05] bg-white/[0.02]',
        )}
      >
        <div
          className={cn(
            'mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-widest font-semibold',
            tone === 'error'
              ? 'text-destructive'
              : isSuccess
                ? 'text-success'
                : 'text-muted-foreground/60',
          )}
        >
          {isSuccess && <CheckCircle2 className="size-3 shrink-0" />}
          {label}
        </div>
        <ScrollBody className="text-sm text-foreground/90 chat-message-text">
          <Markdown content={summary} variant="assistant" />
        </ScrollBody>
      </div>
    </div>
  );
}

/**
 * Specialisation of FormattedSection for the `result` line — only reformats
 * when the result is a JSON object in a known shape, otherwise falls back to
 * the existing plain-text rendering.
 */
export function FormattedResultSection({ toolName, raw }: { toolName: string; raw: string }) {
  const formatted = formatToolResult(toolName, raw);
  // If the formatter doesn't recognise the shape, render the raw text the
  // way the original code did — preserving whitespace and styling.
  if (!formatted) {
    return (
      <Section label="result">
        <div className="text-sm text-foreground/90">
          <Markdown content={raw} variant="assistant" />
        </div>
      </Section>
    );
  }
  return <FormattedSection toolName={toolName} label="result" raw={raw} format={formatToolResult} />;
}

/**
 * Prominent error block — rendered when `tool.error` is present. Uses
 * `formatToolError` to parse structured error payloads (JSON with a
 * `message` field, etc.) into a single clean message + optional detail
 * line, then surfaces the raw text behind a "Show raw" toggle.
 */
export function FormattedErrorSection({ toolName, raw }: { toolName: string; raw: string }) {
  const formatted = formatToolError(toolName, raw);
  const message = formatted?.message ?? raw.trim();
  const detail = formatted?.detail;
  const showRawToggle = !!formatted && formatted.raw !== message;
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="mt-1.5 flex gap-3">
      <span className="text-[10px] shrink-0 w-16 pt-0.5 text-destructive">error</span>
      <div className="flex-1 min-w-0">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] leading-relaxed">
          <div className="flex items-start gap-1.5">
            <AlertCircle className="size-3 shrink-0 mt-0.5 text-destructive" />
            <div className="min-w-0 flex-1">
              <div className="text-destructive whitespace-pre-wrap break-words font-medium">
                {message}
              </div>
              {detail && (
                <div className="mt-0.5 text-destructive/80 text-[11px] font-mono whitespace-pre-wrap break-words">
                  {detail}
                </div>
              )}
            </div>
          </div>
          {showRawToggle && (
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowRaw(v => !v)}
                className="inline-flex items-center gap-0.5 text-[10px] text-destructive/70 hover:text-destructive transition-colors"
                title={showRaw ? 'Hide raw error' : 'Show raw error'}
              >
                <Code2 className="size-2.5" />
                {showRaw ? 'Hide raw' : 'Show raw'}
              </button>
              {showRaw && (
                <pre className="flex-1 max-h-40 overflow-auto rounded border border-destructive/20 bg-black/30 px-2 py-1 text-[10.5px] leading-relaxed font-mono whitespace-pre-wrap wrap-break-word text-muted-foreground/85">
                  {tryPrettyJson(raw)}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function tryPrettyJson(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}
