import { Component, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Clipboard } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props { children: ReactNode; fallback?: ReactNode }
interface State { hasError: boolean; error: Error | null }

/**
 * Render-throw catcher. The desktop webview has no devtools, so the fallback
 * must carry everything the user needs to report the bug from the screen
 * itself: the message, the stack, and a one-click copy.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error('ErrorBoundary caught:', error);
    // Persist the last crash so it survives a reload — the user can still
    // copy it after the app restarts.
    try {
      localStorage.setItem(
        'august_last_crash',
        JSON.stringify({ at: new Date().toISOString(), message: error.message, stack: error.stack ?? '' }),
      );
    } catch {
      /* storage unavailable */
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? <CrashCard error={this.state.error} />;
    }
    return this.props.children;
  }
}

export function CrashCard({ error }: { error: Error | null }) {
  const [copied, setCopied] = useState(false);
  const stack = error?.stack ?? '';
  const copy = async () => {
    const details = `${error?.message ?? 'Unknown error'}\n\n${stack}`;
    try {
      await navigator.clipboard?.writeText(details);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="grid h-full place-items-center p-6" role="alert" aria-live="assertive">
      <div className="w-full max-w-lg">
        <div className="mx-auto flex size-12 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-6" aria-hidden="true" />
        </div>
        <div className="mt-4 text-center">
          <h1 className="text-xl font-semibold">August ran into a problem</h1>
          <p className="mt-2 break-words text-sm text-muted-foreground">
            {error?.message ?? 'The interface stopped responding.'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Your work is still stored locally. Reloading may restore the last session.
          </p>
        </div>
        {stack && (
          <details className="mt-4 text-left">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
              Technical details
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto rounded-lg border border-border bg-black/30 p-3 font-mono text-xs leading-relaxed text-foreground/80">
              {stack}
            </pre>
          </details>
        )}
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button onClick={() => void location.reload()}>Reload August</Button>
          <Button variant="outline" onClick={() => void copy()} aria-live="polite">
            {copied ? <Check className="mr-1.5 size-4" /> : <Clipboard className="mr-1.5 size-4" />}
            {copied ? 'Copied' : 'Copy error'}
          </Button>
        </div>
      </div>
    </div>
  );
}
