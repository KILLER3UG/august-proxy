/* ── API Access settings page ───────────────────────────────────────── */
/* Lets the user open (or close) the proxy gateway for external clients
 * (Claude Code, OpenAI SDKs, Cursor, codex CLI, custom scripts, etc.)
 *
 * Behaviour:
 * - Toggle ON + key configured → /v1/* requires Authorization: Bearer <key>
 * - Toggle OFF                → /v1/* returns 403 (closed)
 * - Toggle ON but no key      → 400 from the server, banner shown below
 *
 * Gateway keys can be generated in-app (saved to config + .env). The full
 * key is shown once after generation; later only a masked preview is shown.
 */
import { useState } from 'react';
import {
  Link2,
  KeyRound,
  Radio,
  Plug,
  Copy,
  Check,
  AlertTriangle,
  Code2,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getExternalAccessConfig,
  updateExternalAccessConfig,
  generateGatewayApiKey,
  getInjectAugOnProxy,
  updateInjectAugOnProxy,
  type ExternalAccessConfig,
} from '@/api/api-client';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/PageLoader';
import { toast } from 'sonner';

/* ── Small reusable bits ─────────────────────────────────────────────── */

function useExtAccessQuery() {
  return useQuery({
    queryKey: ['external-access'],
    queryFn: getExternalAccessConfig,
    refetchInterval: 5000,
  });
}

function CopyButton({ value, label = 'copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <button
      onClick={copy}
      className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-background px-2 py-1 text-[10px] font-mono hover:bg-accent transition shrink-0"
      title="Copy"
    >
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      {copied ? 'copied' : label}
    </button>
  );
}

function CodeBlock({ code, language = 'bash' }: { code: string; language?: string }) {
  return (
    <div className="rounded-md border border-white/[0.06] bg-black/40 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-white/[0.06] bg-white/[0.02]">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
          {language}
        </span>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto p-3 text-[11px] font-mono text-foreground/90 leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function StatusDot({ tone }: { tone: 'success' | 'warning' | 'muted' }) {
  const bg =
    tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-muted-foreground/40';
  return <span className={`inline-block size-2 rounded-full ${bg}`} aria-hidden="true" />;
}

/* ── Main export ─────────────────────────────────────────────────────── */

export function ExternalAccessSection() {
  const qc = useQueryClient();
  const query = useExtAccessQuery();
  const augQuery = useQuery({
    queryKey: ['inject-aug-on-proxy'],
    queryFn: getInjectAugOnProxy,
  });
  const mutation = useMutation({
    mutationFn: (next: boolean) => updateExternalAccessConfig({ enabled: next }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['external-access'] });
      void qc.invalidateQueries({ queryKey: ['health', 'detailed'] });
    },
  });
  const augMutation = useMutation({
    mutationFn: (next: boolean) => updateInjectAugOnProxy({ enabled: next }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inject-aug-on-proxy'] });
    },
  });
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const generateMutation = useMutation({
    mutationFn: () => generateGatewayApiKey(),
    onSuccess: (res) => {
      setRevealedKey(res.apiKey);
      void qc.invalidateQueries({ queryKey: ['external-access'] });
      void qc.invalidateQueries({ queryKey: ['health', 'detailed'] });
      toast.success(res.message || 'Gateway API key generated');
    },
    onError: (e: Error) => toast.error(e.message || 'Could not generate key'),
  });

  if (query.isLoading || !query.data) {
    return <PageLoader label="Loading API access…" />;
  }
  const cfg: ExternalAccessConfig = query.data;

  const enabled = cfg.enabled;
  const hasKey = cfg.hasKey || !!revealedKey;
  const healthy = enabled && hasKey;

  const baseUrl = cfg.endpoints.openai.replace(/\/v1\/.*$/, '');
  const keyForDisplay = revealedKey ?? cfg.keyPreview ?? 'AUG••••••••••••';
  const bearerLine = `Authorization: Bearer ${keyForDisplay}`;

  const curlExample =
    `curl -X POST ${cfg.endpoints.openai} \\
  -H "${bearerLine}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'`;

  const pythonExample =
    `from openai import OpenAI\n\n` +
    `client = OpenAI(\n` +
    `    base_url="${baseUrl}/v1",\n` +
    `    api_key="${keyForDisplay}",\n` +
    `)\n\n` +
    `resp = client.chat.completions.create(\n` +
    `    model="gpt-4o",\n` +
    `    messages=[{"role": "user", "content": "Hello"}],\n` +
    `)`;

  const jsExample =
    `import OpenAI from 'openai';\n\n` +
    `const client = new OpenAI({\n` +
    `    baseURL: "${baseUrl}/v1",\n` +
    `    apiKey: "${keyForDisplay}",\n` +
    `});\n\n` +
    `const resp = await client.chat.completions.create({\n` +
    `    model: "gpt-4o",\n` +
    `    messages: [{ role: "user", content: "Hello" }],\n` +
    `});`;

  const anthropicExample =
    `curl -X POST ${cfg.endpoints.anthropic} \\
  -H "${bearerLine}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'`;

  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-12 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">API Access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Open or close the proxy gateway for external clients. When open, apps
          like Claude Code, Cursor, OpenAI SDKs, and the{' '}
          <code className="font-mono">codex</code> CLI can route requests
          through August. When closed,{' '}
          <code className="font-mono">/v1/*</code> returns 403.
        </p>
      </header>

      {/* ── Toggle ────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Plug className="size-4 text-foreground/70" />
          <h2 className="text-base font-medium">External API Access</h2>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 space-y-3">
          <SettingsToggle
            checked={enabled}
            onCheckedChange={(next) => mutation.mutate(next)}
            label={enabled ? 'Enabled' : 'Disabled'}
            description={
              enabled
                ? 'External clients can hit /v1/* when they send the correct Bearer key.'
                : 'External clients are rejected with 403 on /v1/*.'
            }
            disabled={mutation.isPending}
          />
          <div className="border-t border-white/[0.06] pt-3">
            <SettingsToggle
              checked={Boolean(augQuery.data?.enabled)}
              onCheckedChange={(next) => augMutation.mutate(next)}
              label="Inject AUG.md on proxy path"
              description={
                augQuery.data?.enabled
                  ? 'When a client hits /v1/messages or /v1/chat/completions, project AUG.md is appended to the system prompt.'
                  : 'Off by default. Enable to inject workspace AUG.md into external proxy requests.'
              }
              disabled={augMutation.isPending || augQuery.isLoading}
              data-testid="inject-aug-on-proxy-toggle"
            />
          </div>
          {mutation.isError && (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
              <span>
                Could not update: {(mutation.error)?.message ?? 'unknown error'}
              </span>
            </p>
          )}
        </div>
      </section>

      {/* ── API Key ───────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-foreground/70" />
          <h2 className="text-base font-medium">Gateway API Key</h2>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 space-y-3">
          {hasKey ? (
            <>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
                <code className="text-sm font-mono break-all">
                  {revealedKey ?? cfg.keyPreview}
                </code>
                <CopyButton value={revealedKey ?? cfg.keyPreview ?? ''} label="copy" />
              </div>
              {revealedKey && (
                <p className="text-xs text-warning flex items-start gap-1.5">
                  <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                  Copy this key now — after you leave this page only a masked preview is shown.
                </p>
              )}
            </>
          ) : (
            <div className="flex items-start gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-3 text-xs text-muted-foreground">
              <KeyRound className="size-3.5 mt-0.5 shrink-0 text-primary" />
              <div>
                No gateway key yet. Generate one to open external API access for Claude Code,
                Cursor, SDKs, and other clients.
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              data-testid="generate-gateway-key"
            >
              <RefreshCw className={`size-3.5 mr-1.5 ${generateMutation.isPending ? 'animate-spin' : ''}`} />
              {hasKey ? 'Regenerate key' : 'Generate key'}
            </Button>
            {cfg.source && (
              <span className="text-[10px] font-mono text-muted-foreground">
                source: {cfg.source}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Keys are saved to your project config and <code className="font-mono">.env</code>{' '}
            automatically. Clients send{' '}
            <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.
          </p>
        </div>
      </section>

      {/* ── Connection status ─────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Radio className="size-4 text-foreground/70" />
          <h2 className="text-base font-medium">Connection Status</h2>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Proxy gateway</span>
            <Badge variant="success">OPEN</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">External access</span>
            {enabled ? (
              <Badge variant={hasKey ? 'success' : 'warning'}>
                <StatusDot tone={hasKey ? 'success' : 'warning'} />
                {hasKey ? 'OPEN' : 'ENABLED (no key)'}
              </Badge>
            ) : (
              <Badge variant="secondary">
                <StatusDot tone="muted" />
                CLOSED
              </Badge>
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">API key configured</span>
            {hasKey ? (
              <Badge variant="success">YES</Badge>
            ) : (
              <Badge variant="warning">NO</Badge>
            )}
          </div>
          {!healthy && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Requests on <code className="font-mono">/v1/*</code> will be
              rejected{!hasKey && enabled ? ' with 503 (no key configured)' : enabled ? ' with 401' : ' with 403'}.
            </p>
          )}
        </div>
      </section>

      {/* ── Endpoints ─────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Link2 className="size-4 text-foreground/70" />
          <h2 className="text-base font-medium">Proxy Endpoints</h2>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 space-y-3">
          <EndpointRow
            url={cfg.endpoints.anthropic}
            label="Anthropic Messages"
            hint="ANTHROPIC_BASE_URL — Claude Code, Anthropic SDKs."
          />
          <EndpointRow
            url={cfg.endpoints.openai}
            label="OpenAI Chat Completions"
            hint="OPENAI_API_BASE — OpenAI SDKs, Cursor, codex CLI."
          />
          <EndpointRow
            url={cfg.endpoints.models}
            label="Model List"
            hint="GET /v1/models — list models across providers."
          />
        </div>
      </section>

      {/* ── Usage examples ────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Code2 className="size-4 text-foreground/70" />
          <h2 className="text-base font-medium">Usage Examples</h2>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Sparkles className="size-3 text-muted-foreground" />
              <span className="text-xs font-medium">OpenAI (Chat Completions)</span>
            </div>
            <CodeBlock code={curlExample} language="bash" />
            <CodeBlock code={pythonExample} language="python" />
            <CodeBlock code={jsExample} language="javascript" />
          </div>
          <div className="space-y-1.5 pt-2 border-t border-white/[0.06]">
            <div className="flex items-center gap-1.5">
              <Sparkles className="size-3 text-muted-foreground" />
              <span className="text-xs font-medium">Anthropic (Messages)</span>
            </div>
            <CodeBlock code={anthropicExample} language="bash" />
          </div>
        </div>
      </section>

      <p className="text-[10px] text-muted-foreground/80 font-mono">
        🔒 The proxy server binds to your local network. Anyone able to reach
        the port can attempt authentication — keep{' '}
        <code>GATEWAY_API_KEY</code> private.
      </p>
    </div>
  );
}

/* ── A re-usable "endpoint URL row" ──────────────────────────────────── */

function EndpointRow({ url, label, hint }: { url: string; label: string; hint: string }) {
  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <CopyButton value={url} />
      </div>
      <code className="block mt-1.5 text-[11px] font-mono text-foreground break-all">{url}</code>
      <p className="text-[10px] text-muted-foreground mt-1">{hint}</p>
    </div>
  );
}

export default ExternalAccessSection;
