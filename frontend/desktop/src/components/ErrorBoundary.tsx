import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface Props { children: ReactNode; fallback?: ReactNode }
interface State { hasError: boolean; error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error('ErrorBoundary caught:', error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="grid h-full place-items-center p-6">
          <div className="max-w-md text-center">
            <h1 className="text-lg font-semibold">Something went wrong.</h1>
            <p className="mt-2 text-sm text-muted-foreground">{this.state.error?.message}</p>
            <Button className="mt-4" onClick={() => location.reload()}>Reload</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
