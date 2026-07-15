/* ── Create custom MCP integration ─────────────────────────────────── */

import { useState } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { cn } from '@/lib/utils';

const FIELD =
  'w-full rounded-lg border border-white/[0.08] bg-white/[0.06] px-3 py-2 text-sm ' +
  'text-foreground placeholder:text-muted-foreground focus:border-primary/40 ' +
  'focus:outline-none focus:ring-1 focus:ring-primary/30 shadow-none';

export interface CustomMcpPayload {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  start: boolean;
}

interface Props {
  onSubmit: (payload: CustomMcpPayload) => Promise<void>;
  busy?: boolean;
  className?: string;
}

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'stdio (local command)' },
  { value: 'sse', label: 'SSE (remote URL)' },
  { value: 'http', label: 'HTTP (remote URL)' },
] as const;

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

function parseArgs(text: string): string[] {
  return text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function CustomIntegrationForm({ onSubmit, busy, className }: Props) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'sse' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [url, setUrl] = useState('');
  const [envText, setEnvText] = useState('');
  const [start, setStart] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isRemote = transport === 'sse' || transport === 'http';
  const canSubmit =
    name.trim().length > 0 &&
    (isRemote ? url.trim().length > 0 : command.trim().length > 0) &&
    !busy;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!canSubmit) return;
    try {
      await onSubmit({
        name: name.trim(),
        transport,
        command: isRemote ? undefined : command.trim(),
        args: isRemote ? undefined : parseArgs(argsText),
        url: isRemote ? url.trim() : undefined,
        env: parseEnv(envText),
        start,
      });
      setName('');
      setCommand('');
      setArgsText('');
      setUrl('');
      setEnvText('');
      setTransport('stdio');
      setStart(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create integration');
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className={cn('space-y-4 max-w-xl', className)}
      data-testid="custom-integration-form"
    >
      <div>
        <h3 className="text-sm font-semibold text-foreground">Create custom MCP</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Register a local command or remote MCP server that is not in the directory.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground" htmlFor="custom-mcp-name">
          Name
        </label>
        <input
          id="custom-mcp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-mcp-server"
          className={FIELD}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground">Transport</label>
        <SettingsSelect
          aria-label="MCP transport"
          value={transport}
          onChange={(v) => setTransport(v as 'stdio' | 'sse' | 'http')}
          options={[...TRANSPORT_OPTIONS]}
        />
      </div>

      {isRemote ? (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground" htmlFor="custom-mcp-url">
            Server URL
          </label>
          <input
            id="custom-mcp-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            className={FIELD}
          />
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground" htmlFor="custom-mcp-cmd">
              Command
            </label>
            <input
              id="custom-mcp-cmd"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx / uvx / node path"
              className={FIELD}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground" htmlFor="custom-mcp-args">
              Args (space-separated)
            </label>
            <input
              id="custom-mcp-args"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem ."
              className={FIELD}
            />
          </div>
        </>
      )}

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground" htmlFor="custom-mcp-env">
          Env (KEY=value per line, optional)
        </label>
        <textarea
          id="custom-mcp-env"
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          rows={3}
          placeholder="API_KEY=…"
          className={cn(FIELD, 'font-mono text-xs resize-y')}
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={start}
          onChange={(e) => setStart(e.target.checked)}
          className="rounded border-white/20"
        />
        Start server after save
      </label>

      <Button type="submit" size="sm" disabled={!canSubmit} data-testid="custom-integration-submit">
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Plus className="size-3.5" />
        )}
        {busy ? 'Creating…' : 'Create integration'}
      </Button>
    </form>
  );
}
