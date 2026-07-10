import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { StatusPill } from '@/components/StatusPill';
import { SectionHeader } from '@/components/SectionHeader';
import { useStore } from '@nanostores/react';
import { $gateway } from '@/store/gateway';
import { PageLoader } from '@/components/PageLoader';
import { Copy, Check, Link2, Terminal, Brain } from 'lucide-react';

interface HealthData {
  claude?: { status: string };
  codex?: { status: string };
  uptime?: number;
  memory?: { used: number; total: number };
  origin?: string;
  port?: number;
  endpoints?: {
    anthropic: { url: string; label: string; client: string };
    openai: { url: string; label: string; client: string };
    models: { url: string; label: string; client: string };
  };
  activeUpstream?: { provider: string; baseUrl: string } | null;
}

export function Health() {
  const g = useStore($gateway);
  const { data, isLoading, error } = useQuery({
    queryKey: ['health', 'detailed'],
    queryFn: () => api.get<HealthData>('/api/health/detailed'),
    refetchInterval: 5_000,
  });

  if (isLoading) return <PageLoader label="Checking health…" />;
  if (error) {
    return (
      <div className="p-6">
        <SectionHeader title="Health" />
        <p className="text-sm text-destructive">Failed: {String(error)}</p>
      </div>
    );
  }
  if (!data) return null;

  const port = data.port || (g.status === 'open' ? g.port : 0) || 8085;
  const endpoints = data.endpoints;

  return (
    <div className="p-6 space-y-6">
      <SectionHeader title="Health" subtitle="Live runtime status, provider health, and connection URLs." />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Gateway</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2">
            <StatusPill
              tone={g.status === 'open' ? 'good' : 'bad'}
              label={g.status === 'open' ? 'Open' : g.status}
            />
            <span className="text-xs text-muted-foreground">port {port}</span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Claude</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusPill
              tone={data.claude?.status === 'ok' ? 'good' : 'muted'}
              label={data.claude?.status ?? 'unknown'}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Codex</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusPill
              tone={data.codex?.status === 'ok' ? 'good' : 'muted'}
              label={data.codex?.status ?? 'unknown'}
            />
          </CardContent>
        </Card>
      </div>

      {/* Connect an app — copy these base URLs into Claude Code, Cursor, etc. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 className="size-4" /> Connect an app
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Point any OpenAI- or Anthropic-compatible app at this proxy. Models from every configured provider are available on all paths — the proxy translates formats and routes per model.
          </p>

          {endpoints ? (
            <div className="space-y-3">
              <EndpointRow
                endpoint={endpoints.anthropic}
                hint="ANTHROPIC_BASE_URL — Claude Code, Anthropic SDKs. Sends /v1/messages."
                icon={<Brain className="size-3.5" />}
              />
              <EndpointRow
                endpoint={endpoints.openai}
                hint="OPENAI_API_BASE — OpenAI SDKs, Cursor, codex CLI. Sends /v1/chat/completions."
                icon={<Terminal className="size-3.5" />}
              />
              <EndpointRow
                endpoint={endpoints.models}
                hint="Fetch the model list. Any OpenAI-compatible client."
                icon={<Link2 className="size-3.5" />}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <CopyableUrl url={`http://localhost:${port}/v1/messages`} label="Anthropic (Claude Code)" />
              <CopyableUrl url={`http://localhost:${port}/v1/chat/completions`} label="OpenAI Chat Completions" />
              <CopyableUrl url={`http://localhost:${port}/v1/models`} label="Model list" />
            </div>
          )}

          {data.activeUpstream?.baseUrl && (
            <div className="pt-2 border-t border-border/40 text-[11px] text-muted-foreground font-mono">
              active upstream: {data.activeUpstream.provider} → {data.activeUpstream.baseUrl}
            </div>
          )}
          <p className="text-[9px] text-muted-foreground font-mono">
            🔒 The base URL works over the network this app is served from. Use a real API key from Settings for the upstream provider.
          </p>
        </CardContent>
      </Card>

      {data.memory && (
        <Card>
          <CardHeader>
            <CardTitle>Memory</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-mono">
              {data.memory.used} MB / {data.memory.total} MB
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function EndpointRow({
  endpoint,
  hint,
  icon,
}: {
  endpoint: { url: string; label: string; client: string };
  hint: string;
  icon: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard?.writeText(endpoint.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <div className="rounded-md border border-border bg-card/60 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground shrink-0">{icon}</span>
          <span className="text-sm font-medium">{endpoint.label}</span>
        </div>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-mono hover:bg-accent transition shrink-0"
          title="Copy URL"
        >
          {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <code className="block mt-1.5 text-[11px] font-mono text-foreground break-all">{endpoint.url}</code>
      <p className="text-[10px] text-muted-foreground mt-1">{hint}</p>
    </div>
  );
}

function CopyableUrl({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-44 shrink-0">{label}</span>
      <code className="flex-1 text-[11px] font-mono text-foreground truncate">{url}</code>
      <button
        onClick={copy}
        className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition shrink-0"
        title="Copy URL"
      >
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}
