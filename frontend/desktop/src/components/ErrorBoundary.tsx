import { Component, type ReactNode } from 'react';
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
  const stack = error?.stack ?? '';
  const copy = () => {
    void navigator.clipboard
      ?.writeText(`${error?.message ?? 'Unknown error'}\n\n${stack}`)
      .catch(() => undefined);
  };
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="w-full max-w-lg text-center">
        <h1 className="text-lg font-semibold">Something went wrong.</h1>
        <p className="mt-2 break-words text-sm text-muted-foreground">
          {error?.message ?? 'Unknown error'}
        </p>
        {stack && (
          <details className="mt-3 text-left">
            <summary className="cursor-pointer text-xs text-muted-foreground/70 hover:text-foreground">
              Details
            </summary>
            <pre className="mt-1 max-h-56 overflow-auto rounded-lg border border-white/[0.06] bg-black/30 p-3 font-mono text-[10.5px] leading-relaxed text-foreground/70">
              {stack}
            </pre>
          </details>
        )}
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button onClick={() => location.reload()}>Reload</Button>
          <Button variant="outline" onClick={copy}>
            Copy error
          </Button>
        </div>
      </div>
    </div>
  );
}
