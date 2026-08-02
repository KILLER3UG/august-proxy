/**
 * IntegrationSetupWidget — inline setup UI shown in chat when the model calls
 * a connect_github / connect_slack / connect_google / install_mcp_server tool.
 * Secrets never enter the model's text:
 * the widget POSTs tokens straight to the backend and shows only masked status.
 *
 * Handles:
 *  - github / slack: inline hidden token field + Apply → POST /api/service-connections/{provider}
 *  - google: "Sign in with Google" → opens authUrl (from the tool result) in the
 *    external browser (existing PKCE OAuth flow); app polls connection status.
 *  - mcp: read-only status card (installed tools / server id).
 */
import { useState } from 'react';
import { CheckCircle2, Loader2, Key, Shield, ExternalLink, Inbox, Eye } from 'lucide-react';
import { api } from '@/api/client';
import { openExternal } from '@/lib/tauri-shell';
import { Button } from '@/components/ui/button';
import type { IntegrationSetupResult } from '@/types/chat';

function StatusBadge({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
        ok ? 'bg-success/15 text-success' : 'bg-muted/50 text-muted-foreground'
      }`}
    >
      <CheckCircle2 className="size-3" />
      {text}
    </span>
  );
}

function TokenPasteForm({
  provider,
  label,
  onDone,
}: {
  provider: 'github' | 'slack';
  label: string;
  onDone: (msg: string) => void;
}) {
  const [token, setToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const canApply = token.trim().length > 0 && !busy;

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    setError('');
    try {
      if (provider === 'github') {
        await api.post('/api/service-connections/github', { token: token.trim() });
      } else {
        await api.post('/api/service-connections/slack', {
          botToken: token.trim(),
          teamId: teamId.trim(),
        });
      }
      setToken('');
      setTeamId('');
      onDone(`${label} connected.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to connect ${label}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void apply();
          }}
          placeholder={provider === 'github' ? 'ghp_… or gho_…' : 'xoxb-…'}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-md border border-border bg-background px-3 py-2 pr-10 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition font-mono"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={show ? 'Hide token' : 'Show token'}
        >
          {show ? <Shield className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      </div>

      {provider === 'slack' && (
        <input
          type="text"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          placeholder="Team / workspace id (optional)"
          spellCheck={false}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
        />
      )}

      {error && <p className="text-[10px] text-destructive">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" onClick={() => void apply()} disabled={!canApply}>
          {busy ? <Loader2 className="size-3 mr-1 animate-spin" /> : <Key className="size-3 mr-1" />}
          {busy ? 'Connecting…' : `Apply ${label} token`}
        </Button>
      </div>
    </div>
  );
}

export function IntegrationSetupWidget({ setup }: { setup: IntegrationSetupResult }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const kind = (setup.kind ?? setup.provider ?? '').toLowerCase();

  const provider = kind === 'github' || kind === 'slack' ? kind : null;
  const isGoogle = kind === 'google' || setup.authUrl != null;
  const isMcp = kind === 'mcp' || !!setup.serverId;

  const signInGoogle = async () => {
    setBusy(true);
    setErr('');
    try {
      let authUrl = setup.authUrl || '';
      if (!authUrl) {
        const res = await api.post<{ authUrl?: string }>('/api/service-connections/google/auth', {
          email: '',
          facet: setup.facet ?? 'gmail',
        });
        authUrl = res.authUrl || '';
      }
      if (!authUrl) {
        setErr(
          setup.needsClientId
            ? 'Google OAuth needs a Client ID. Add GOOGLE_OAUTH_CLIENT_ID in Settings → Integrations, then try again.'
            : 'Google sign-in URL could not be built. Check Settings → Integrations → Google.',
        );
        return;
      }
      const opened = await openExternal(authUrl);
      if (!opened) window.open(authUrl, 'august-google-oauth', 'width=520,height=720');
      setNote('Google sign-in opened in your browser. Complete it there, then the account will be linked.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start Google sign-in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-md border border-primary/25 bg-card/70 p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-primary/80 font-semibold">
        <Shield className="size-3" />
        {isMcp ? 'MCP server installed' : isGoogle ? 'Connect Google account' : `${setup.label ?? 'Integration'} setup`}
      </div>

      {/* Token-based providers */}
      {provider && setup.needsToken ? (
        <TokenPasteForm provider={provider} label={setup.label ?? provider} onDone={setNote} />
      ) : provider ? (
        <div className="flex items-center gap-2 text-xs text-foreground/90">
          <StatusBadge ok={!!setup.connected} text={setup.connected ? 'Connected' : 'Disconnected'} />
          {setup.maskedToken && <span className="font-mono text-muted-foreground">{setup.maskedToken}</span>}
          {setup.account && <span className="text-muted-foreground">@{setup.account}</span>}
        </div>
      ) : isGoogle ? (
        <div className="space-y-2">
          {setup.connected ? (
            <StatusBadge ok text={`${setup.facet ?? 'Google'} connected`} />
          ) : (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => void signInGoogle()} disabled={busy}>
                {busy ? (
                  <Loader2 className="size-3 mr-1 animate-spin" />
                ) : (
                  <ExternalLink className="size-3 mr-1" />
                )}
                Sign in with Google {setup.facet ? `(${setup.facet})` : ''}
              </Button>
              {setup.needsClientId && (
                <p className="text-[10px] text-muted-foreground">
                  Needs GOOGLE_OAUTH_CLIENT_ID configured in Settings → Integrations.
                </p>
              )}
            </>
          )}
        </div>
      ) : isMcp ? (
        <div className="space-y-1 text-xs text-foreground/90">
          <div className="flex items-center gap-2">
            <Inbox className="size-3.5 text-muted-foreground" />
            <span className="font-medium">{setup.name}</span>
            {setup.serverId && <span className="font-mono text-muted-foreground">#{setup.serverId}</span>}
            <StatusBadge ok={!!setup.started} text={setup.started ? 'Active' : 'Registered'} />
          </div>
          {typeof setup.toolCount === 'number' && (
            <p className="text-muted-foreground">{setup.toolCount} tool{setup.toolCount === 1 ? '' : 's'} available</p>
          )}
          {Array.isArray(setup.tools) && setup.tools.length > 0 && (
            <p className="font-mono text-[11px] text-muted-foreground">{setup.tools.slice(0, 8).join(', ')}</p>
          )}
          {setup.error && <p className="text-[10px] text-destructive">{setup.error}</p>}
        </div>
      ) : null}

      {note && <p className="flex items-center gap-1.5 text-[11px] text-success"><CheckCircle2 className="size-3.5" />{note}</p>}
      {err && <p className="text-[10px] text-destructive">{err}</p>}
    </div>
  );
}