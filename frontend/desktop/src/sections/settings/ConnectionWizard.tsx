/* ── GitHub / Slack connection wizards ────────────────────────────────── */
/* Scopes checklist + guided PAT/bot token + Test connection / test send. */

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, ExternalLink, Loader2, Plug, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useConnectAccount } from './useIntegrations';

type Provider = 'github' | 'slack';

type ScopesResponse = {
  provider: string;
  scopes: string[];
  helpUrl: string;
  guide: string[];
};

type Props = {
  provider: Provider;
  onConnected?: () => void;
};

export function ConnectionWizard({ provider, onConnected }: Props) {
  const [scopes, setScopes] = useState<string[]>([]);
  const [guide, setGuide] = useState<string[]>([]);
  const [helpUrl, setHelpUrl] = useState('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [token, setToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [channel, setChannel] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectAccount();

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/service-connections/${provider}/scopes`)
      .then((r) => r.json() as Promise<ScopesResponse>)
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data.scopes) ? data.scopes : [];
        setScopes(list);
        setGuide(Array.isArray(data.guide) ? data.guide : []);
        setHelpUrl(data.helpUrl || '');
        setChecked(Object.fromEntries(list.map((s) => [s, true])));
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const runTest = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const path =
        provider === 'github'
          ? '/api/service-connections/github/test'
          : '/api/service-connections/slack/test';
      const body =
        provider === 'github'
          ? { token: token.trim() }
          : { botToken: token.trim(), channel: channel.trim() };
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        detail?: string;
        login?: string;
        testSend?: boolean;
        testSendError?: string;
      };
      if (!data.ok) {
        setError(data.error || 'Test failed');
      } else {
        let msg = data.detail || 'Connection OK';
        if (data.testSend === false && data.testSendError) {
          msg += ` (send failed: ${data.testSendError})`;
        }
        setTestResult(msg);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (provider === 'github') {
        await connect.mutateAsync({ kind: 'github', token: token.trim() });
      } else {
        await connect.mutateAsync({
          kind: 'slack',
          botToken: token.trim(),
          teamId: teamId.trim(),
        });
      }
      setToken('');
      onConnected?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
    }
  };

  const title = provider === 'github' ? 'GitHub' : 'Slack';
  const placeholder =
    provider === 'github' ? 'ghp_… or github_pat_…' : 'xoxb-… bot user OAuth token';

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-md space-y-3 rounded-xl border border-white/[0.08] bg-black/20 p-3"
      data-testid={`${provider}-connection-wizard`}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{title} setup wizard</h4>
        {helpUrl && (
          <a
            href={helpUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            Docs <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      {guide.length > 0 && (
        <ol className="list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground">
          {guide.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}

      {scopes.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Scopes checklist
          </p>
          <ul className="max-h-36 space-y-1 overflow-auto rounded-md border border-white/[0.06] p-2">
            {scopes.map((scope) => (
              <li key={scope}>
                <label className="flex cursor-pointer items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    className="shrink-0 text-primary"
                    onClick={() =>
                      setChecked((c) => ({ ...c, [scope]: !c[scope] }))
                    }
                    aria-label={`Toggle ${scope}`}
                  >
                    {checked[scope] ? (
                      <CheckCircle2 className="size-3.5" />
                    ) : (
                      <Circle className="size-3.5 text-muted-foreground" />
                    )}
                  </button>
                  <code className="font-mono text-foreground/90">{scope}</code>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-white/[0.08] bg-white/[0.06] px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
        autoComplete="off"
      />

      {provider === 'slack' && (
        <>
          <input
            type="text"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            placeholder="Team ID (optional)"
            className="w-full rounded-md border border-white/[0.08] bg-white/[0.06] px-2.5 py-1.5 font-mono text-xs"
          />
          <input
            type="text"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            placeholder="Test send channel (e.g. #general or C0…)"
            className="w-full rounded-md border border-white/[0.08] bg-white/[0.06] px-2.5 py-1.5 font-mono text-xs"
          />
        </>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!token.trim() || testing}
          onClick={() => {
            void runTest();
          }}
        >
          {testing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : provider === 'slack' && channel.trim() ? (
            <Send className="size-3" />
          ) : (
            <Plug className="size-3" />
          )}
          {provider === 'slack' && channel.trim() ? 'Test + send' : 'Test connection'}
        </Button>
        <Button type="submit" size="sm" disabled={!token.trim() || connect.isPending}>
          {connect.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Plug className="size-3" />
          )}
          Connect
        </Button>
      </div>

      {testResult && (
        <p className={cn('text-right text-[11px] text-emerald-400')}>{testResult}</p>
      )}
      {error && <p className="text-right text-[11px] text-destructive">{error}</p>}
    </form>
  );
}

export default ConnectionWizard;
