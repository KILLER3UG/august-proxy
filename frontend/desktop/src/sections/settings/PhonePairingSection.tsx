/* ── Phone pairing — hand this install's token to a phone ───────────────
 *
 * The desktop shell generates a per-install token
 * (src-tauri/src/backend.rs → `local_api_token`) and the backend's
 * sensitive local routes require it
 * (backend-py/app/lib/local_api_auth.py → `X-August-Local-Token`).
 * A phone's WebView is not Tauri, so it has no IPC to ask and sends no
 * header — which is why `POST /api/subagents/spawn` and its four
 * siblings answer 401 for a phone today.
 *
 * The token therefore travels with the URL the phone opens:
 *
 *     http://<host>:<port>/#august-token=<token>
 *
 * The FRAGMENT is the form, not the query string: a fragment is never
 * sent to the server and never appears in a `Referer` header, so the
 * token cannot reach an access log. The web client reads it on boot and
 * takes it back out of the URL (src/api/client.ts →
 * `captureTokenFromUrl`), so it does not sit in the address bar, in the
 * history, or in a screenshot either.
 *
 * WHERE THE PHONE POINTS is a network question, not a token question, and
 * the panel answers it from what the BACKEND reports rather than from a
 * guess:
 *
 *  • LAN access ON  → the phone opens http://<lan-address>:<port>.
 *  • LAN access OFF → the backend listens on 127.0.0.1, so a phone on
 *    another device cannot open it at all, and the panel says so instead
 *    of printing a URL that would be refused at the socket.
 *
 * The backend is the authority on its own reachability: `/api/health`
 * carries `lan` — `{ enabled, origins, port }` — from
 * `app/lib/lan_access.py::lan_status()`. The panel reads that and nothing
 * else; it never guesses a LAN address, because an invented address
 * produces a URL that answers nothing.
 */

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  Link2,
  Shield,
  Smartphone,
} from 'lucide-react';
import { api, buildPairingUrl, getLocalToken } from '@/api/client';
import { isTauri } from '@/lib/tauri-detect';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** The network facts the panel reads off the health payload.
 *
 *  The backend owns the truth about its own reachability: `/api/health`
 *  carries `lan` — `{ enabled, origins, port }` — from
 *  `app/lib/lan_access.py::lan_status()`. `origins` is the list of
 *  `http://<ip>:<port>` a phone on this network would use, and it is EMPTY
 *  when the backend could not find a usable address (an invented address
 *  would be worse than none, because the panel would print a URL that
 *  answers nothing).
 *
 *  Every field is optional and the panel ERRS TOWARDS "not reachable": a
 *  payload it does not understand leaves LAN access looking off, which is
 *  the safe direction — a panel that claims reachability it cannot prove
 *  teaches the user to believe something false. */
interface NetworkInfo {
  /** Whether the backend is reachable from the network at all. */
  enabled: boolean;
  /** The `http://<ip>:<port>` origins a phone on this network would use. */
  origins: string[];
  /** The port the backend is actually on. */
  port: number | null;
}

interface HealthPayload {
  status?: string;
  port?: number;
  lan?: {
    enabled?: boolean;
    origins?: string[];
    port?: number;
  };
}

function readNetwork(payload: HealthPayload | undefined): NetworkInfo {
  const lan = payload?.lan ?? {};
  const origins = Array.isArray(lan.origins) ? lan.origins.filter((o) => typeof o === 'string' && o) : [];
  return {
    enabled: lan.enabled === true,
    origins,
    port: lan.port ?? payload?.port ?? null,
  };
}

/** Addresses that resolve to THIS machine and no other. The Android
 *  emulator reaches the host's loopback through 10.0.2.2, so it belongs
 *  here even though it is not a loopback literal. */
const LOCAL_ONLY_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '10.0.2.2']);

/** The hosts app/main.py `_cors_allow_origins()` trusts without any
 *  configuration: the two loopback names, at the running port. */
const DEFAULT_TRUSTED_HOSTS = new Set(['127.0.0.1', 'localhost']);

const HOST_PRESETS: ReadonlyArray<{ host: string; label: string; hint: string }> = [
  { host: '127.0.0.1', label: 'Loopback', hint: 'iOS Simulator on this machine' },
  { host: '10.0.2.2', label: 'Emulator alias', hint: 'Android emulator on this machine' },
];

function normalizeHost(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={copy}
      disabled={!value}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? 'copied' : 'copy'}
    </Button>
  );
}

export function PhonePairingSection() {
  const [token, setToken] = useState<string | null>(null);
  const [proxyPort, setProxyPort] = useState<number | null>(null);
  const [host, setHost] = useState('');
  const [hostTouched, setHostTouched] = useState(false);
  const [revealed, setRevealed] = useState(false);

  // The token is a SECRET, so it is deliberately not in a react-query
  // cache: a query cache is shared, inspectable state, and this value
  // only ever needs to live in this component.
  useEffect(() => {
    let cancelled = false;
    void getLocalToken().then((value) => {
      if (!cancelled) setToken(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The port is whatever the supervisor actually bound — the default 8085
  // is only a guess, and a guessed port silently targets nothing.
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    const read = async () => {
      try {
        const status = await invoke<string>('proxy_status');
        if (cancelled) return;
        if (status.startsWith('ok:')) setProxyPort(Number(status.split(':')[1]) || null);
      } catch {
        /* the shell may not be there yet */
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // The backend owns the truth about its own network mode. `/api/health`
  // is where it reports it — and it is a route the backend keeps OPEN in
  // LAN mode (`LAN_OPEN_PATHS` in app/lib/local_api_auth.py), so this
  // query answers whether the token is configured or not.
  const health = useQuery({
    queryKey: ['health', 'basic'],
    queryFn: () => api.get<HealthPayload>('/api/health'),
    refetchInterval: 5000,
  });

  const net = useMemo(() => readNetwork(health.data), [health.data]);
  const port = net.port ?? proxyPort ?? health.data?.port ?? 8085;
  const backendUp = health.isSuccess || proxyPort !== null;

  // The address the phone uses. When the backend reports a LAN origin, it
  // fills the field — until the user types their own.
  const lanOrigin = net.origins[0] ?? null;
  useEffect(() => {
    if (hostTouched) return;
    if (lanOrigin) setHost(normalizeHost(lanOrigin));
    else if (!host) setHost('127.0.0.1');
  }, [host, hostTouched, lanOrigin]);

  const effectiveHost = normalizeHost(host) || '127.0.0.1';
  const origin = `http://${effectiveHost}:${port}`;
  const lanOn = net.enabled && net.origins.length > 0;
  const lanOnNoAddress = net.enabled && net.origins.length === 0;
  const localOnly = LOCAL_ONLY_HOSTS.has(effectiveHost.toLowerCase());
  const originTrustedByDefault = DEFAULT_TRUSTED_HOSTS.has(effectiveHost.toLowerCase());

  const pairingUrl = token ? buildPairingUrl(origin, token) : '';

  const verdict = useMemo(() => {
    if (lanOn) {
      return {
        tone: 'success' as const,
        badge: 'reachable',
        headline: `Your phone can reach August at ${origin}`,
        detail:
          `LAN access is on, so the backend is listening on the network and the pairing URL below opens on ` +
          `a phone on the same network. The backend trusts that origin (app/main.py adds the LAN origins ` +
          `to its allowlist), and every management route requires this install's per-install token in ` +
          `LAN mode — which is what the URL carries.`,
      };
    }
    if (lanOnNoAddress) {
      return {
        tone: 'warning' as const,
        badge: 'no LAN address',
        headline: 'LAN access is on, but no LAN address was found',
        detail:
          `The backend is listening on the network but it could not work out this machine's address, so it ` +
          `reports no origin a phone could use. Check the machine's network, or type the address below — ` +
          `the backend trusts its own LAN origins, so an address it did not find may still be refused.`,
      };
    }
    if (!localOnly) {
      return {
        tone: 'destructive' as const,
        badge: 'not reachable',
        headline: 'August is only reachable on this machine',
        detail:
          `LAN access is off, so the backend listens on 127.0.0.1 and ${origin} is refused at the socket: ` +
          `no phone on another device can open it. Turn on LAN access in Settings → Phone pairing, or ` +
          `point the phone at a loopback address below for an emulator or simulator on this machine.`,
      };
    }
    if (!originTrustedByDefault) {
      return {
        tone: 'warning' as const,
        badge: 'reachable here',
        headline: `Reachable on this machine, and the backend would refuse this origin`,
        detail:
          `${origin} is the loopback of the computer August runs on, so an emulator or simulator here can ` +
          `open it. app/lib/local_api_guard.py rejects every /api/* call whose Origin is not on the ` +
          `allowlist in app/main.py, and ${origin} is not on it by default — the routes behind the token ` +
          `would answer 403 untrusted_origin rather than 401, and a correct token does not change that.`,
      };
    }
    return {
      tone: 'warning' as const,
      badge: 'this machine only',
      headline: 'August is only reachable on this machine',
      detail:
        `${origin} is the loopback of the computer August runs on, and it is on the backend's default ` +
        `trusted-origin list. An emulator or a simulator running HERE can open it; a phone on the network ` +
        `cannot. Turn on LAN access in Settings → Phone pairing to connect a real phone.`,
    };
  }, [lanOn, lanOnNoAddress, localOnly, origin, originTrustedByDefault]);

  return (
    <div className="px-8 py-6 space-y-4 h-full flex flex-col overflow-auto">
      <header className="shrink-0">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Phone pairing</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-3xl">
          The phone opens a URL that carries this install's per-install token. That token is what lets a phone use
          the routes that start subagent workers and approve harness proposals — without it those routes answer 401.
        </p>
      </header>

      {/* ── Reachability — the honest verdict, above the URL ─────────── */}
      <section className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Smartphone className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Can a phone open this?</span>
          </div>
          <Badge variant={verdict.tone === 'success' ? 'success' : verdict.tone === 'warning' ? 'warning' : 'destructive'}>
            {verdict.badge}
          </Badge>
        </div>
        <p className="text-sm font-medium text-foreground">{verdict.headline}</p>
        <p className="text-xs text-muted-foreground">{verdict.detail}</p>
        {!backendUp ? (
          <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-fg">
            <AlertTriangle className="mt-0.5 shrink-0" />
            <span>
              The backend is not answering on port {port} right now — the URL below is built from the last known port.
            </span>
          </p>
        ) : null}
      </section>

      {/* ── The token ─────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Shield className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Per-install token</span>
          </div>
          <Badge variant={token ? 'success' : 'secondary'}>{token ? 'present' : 'none'}</Badge>
        </div>
        {token ? (
          <>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-white/[0.06] bg-black/30 px-3 py-2 text-2xs font-mono text-foreground">
                {revealed ? token : '•'.repeat(32)}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setRevealed((v) => !v)}
                aria-label={revealed ? 'Hide token' : 'Reveal token'}
                title={revealed ? 'Hide token' : 'Reveal token'}
              >
                {revealed ? <EyeOff /> : <Eye />}
              </Button>
              <CopyButton value={token} label="token" />
            </div>
            <p className="text-xs text-muted-foreground">
              The token is generated by the desktop shell and held in memory — it is never written to the data
              directory, where a model with <code className="font-mono">run_command</code> could read it. It is not
              the same thing as the gateway API key in <span className="font-mono">API Access</span>.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No token here. The desktop shell generates one per install and hands it to the webview over the Tauri
            IPC; a browser build has no shell, no token, and therefore no gate — the routes behind it behave exactly
            as they always have.
          </p>
        )}
      </section>

      {/* ── Where the phone points ────────────────────────────────────── */}
      <section className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Link2 className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Pairing address</span>
          </div>
          <span className="text-2xs font-mono text-muted-foreground">port {port}</span>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={host}
            onChange={(e) => {
              setHost(e.target.value);
              setHostTouched(true);
            }}
            aria-label="Host address the phone uses"
            placeholder="192.168.1.10"
            className="font-mono"
          />
          <span className="shrink-0 text-2xs font-mono text-muted-foreground">:{port}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {HOST_PRESETS.map((preset) => (
            <Button
              key={preset.host}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setHost(preset.host);
                setHostTouched(true);
              }}
              title={preset.hint}
            >
              {preset.label} · {preset.host}
            </Button>
          ))}
          <span className="text-2xs text-muted-foreground">
            {net.origins.length > 0
              ? `The backend reports this machine's LAN address as ${normalizeHost(net.origins[0])}.`
              : net.enabled
                ? 'LAN access is on, but the backend found no LAN address — the address is typed in.'
                : 'LAN access is off, so the backend reports no LAN address — the address is typed in.'}
          </span>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">Pairing URL</span>
            <CopyButton value={pairingUrl} label="pairing URL" />
          </div>
          <code className="block break-all rounded-md border border-white/[0.06] bg-black/30 px-3 py-2 text-2xs font-mono text-foreground">
            {pairingUrl || 'no token — nothing to pair yet'}
          </code>
        </div>

        <p className="text-xs text-muted-foreground">
          The token rides in the <span className="font-mono">#</span> fragment, so the server never sees it and it
          never appears in a <span className="font-mono">Referer</span> header. The web client takes it back out of
          the address bar the moment the page boots. There is no QR code: the desktop package has no QR library and
          none may be added without the owner — a QR of the URL above would need one.
        </p>
      </section>

      {/* ── What the phone does with it ───────────────────────────────── */}
      <section className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Smartphone className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">On the phone</span>
        </div>
        <ol className="list-decimal space-y-1.5 pl-5 text-xs text-muted-foreground">
          <li>
            The August mobile app takes the pairing URL in its <span className="font-mono">Pair</span> panel, reads
            the token out of the fragment, and keeps the address and the token in memory.
          </li>
          <li>
            It hands the token to the page as a global before the page loads, so the token is never in the WebView's
            URL at all — not in the address bar, not in the history, not in a screenshot.
          </li>
          <li>
            The web client sends it as <code className="font-mono">X-August-Local-Token</code> on every request, and
            the gated routes answer normally instead of 401.
          </li>
          <li>
            The mobile package has no secure store, so the token is held in memory only: it is gone when the app is
            killed, and pairing happens again. A backend started outside the desktop shell has no token configured
            and needs none — that path is unchanged.
          </li>
        </ol>
      </section>
    </div>
  );
}

export default PhonePairingSection;
