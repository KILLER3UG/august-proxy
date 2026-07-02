/* ── No-Provider Banner ───────────────────────────────────────────────── */
/* Sticky banner shown at the top of the chat thread when no providers are
   configured. Dismissable via localStorage flag. */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, X, Settings } from 'lucide-react';

const DISMISS_KEY = 'august-no-provider-banner-dismissed';

export function NoProviderBanner() {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === 'true';
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, 'true');
    } catch { /* noop */ }
  };

  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-2.5 text-sm"
      role="alert"
    >
      <AlertTriangle className="size-4 shrink-0 text-warning" />
      <p className="flex-1 text-foreground/80">
        No AI providers configured.{' '}
        <button
          type="button"
          onClick={() => navigate('/settings/providers')}
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
        >
          <Settings className="size-3" />
          Configure a provider
        </button>{' '}
        to start chatting.
      </p>
      <button
        type="button"
        onClick={handleDismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
