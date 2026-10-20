import { useState } from 'react';
import {
  Plus,
  Check,
  Loader2,
  BadgeCheck,
  Wrench,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  catalogCapabilityLabel,
  type IntegrationCatalogEntry,
} from '../integrationDirectory';
import { brandIconStyle, resolveBrandIcon } from './brandIcons';
import { FIELD } from './styles';

interface CatalogDetailProps {
  entry: IntegrationCatalogEntry;
  installed: boolean;
  busy: boolean;
  /** Backend view of this recipe: which launcher it needs, and whether it exists here. */
  launcher?: { command?: string; launcherAvailable?: boolean };
  onAdd: (env?: Record<string, string>) => void;
}

/**
 * Full catalog entry view: description, what the entry actually gives you,
 * tools list, optional env config form, install action, and post-install MCP
 * smoke test against /api/mcp/servers.
 */
export function CatalogDetail({
  entry,
  installed,
  busy,
  launcher,
  onAdd,
}: CatalogDetailProps) {
  const tools = entry.tools ?? [];
  const shown = tools.slice(0, 10);
  const more = Math.max(0, tools.length - shown.length);
  const Icon = resolveBrandIcon(entry.brand);
  const envFields = entry.requiredEnv ?? [];

  /* A recipe whose launcher is missing cannot start on this machine. The
   * Install button is disabled and says why — an install that is guaranteed
   * to fail must not look like a working one. */
  const launcherMissing = launcher?.launcherAvailable === false;
  const launcherCommand = launcher?.command || entry.mcp?.command || '';

  const [envValues, setEnvValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of envFields) {
      init[f.key] = f.defaultValue ?? '';
    }
    return init;
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [smoke, setSmoke] = useState<string | null>(null);
  const [smokeBusy, setSmokeBusy] = useState(false);

  const missingRequired = envFields.filter(
    (f) => f.required !== false && !(envValues[f.key] ?? '').trim(),
  );

  const handleInstall = () => {
    setFormError(null);
    if (launcherMissing) {
      setFormError(
        `Cannot install here — ${launcherCommand} is not on PATH on this machine, so the server ` +
          'cannot start. Install it and reopen August, or register the server yourself with ' +
          'Create custom.',
      );
      return;
    }
    if (missingRequired.length > 0) {
      setFormError(
        `Fill in: ${missingRequired.map((f) => f.label).join(', ')}`,
      );
      return;
    }
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(envValues)) {
      if (v.trim()) cleaned[k] = v.trim();
    }
    onAdd(Object.keys(cleaned).length ? cleaned : undefined);
  };

  /** Post-install smoke: list MCP servers and confirm this recipe is registered / running. */
  const runSmoke = async () => {
    setSmokeBusy(true);
    setSmoke(null);
    try {
      const data = await api.get<{
        servers?: Array<{ name?: string; id?: string; status?: string; running?: boolean }>;
      }>('/api/mcp/servers');
      const servers = data.servers ?? [];
      const needle = (entry.packageName || entry.name || '').toLowerCase();
      const hit = servers.find((s) => {
        const n = `${s.name || ''} ${s.id || ''}`.toLowerCase();
        return needle && n.includes(needle.split('/').pop() || needle);
      });
      if (!hit) {
        setSmoke(
          installed
            ? 'Installed, but not listed in MCP registry yet — try Start from Integrations detail.'
            : launcherMissing
              ? `Not installed: ${launcherCommand} is not on PATH on this machine, so this server cannot start here.`
              : 'Not installed yet. Install first, then re-run smoke test.',
        );
      } else {
        const running =
          hit.running ||
          ['running', 'connected', 'ok', 'ready'].includes(
            String(hit.status || '').toLowerCase(),
          );
        setSmoke(
          running
            ? `Works: ${hit.name || hit.id} is running`
            : `Registered: ${hit.name || hit.id} (status: ${hit.status || 'stopped'}) — Start it from Integrations`,
        );
      }
    } catch (e) {
      setSmoke(`Smoke test failed: ${(e as Error).message}`);
    } finally {
      setSmokeBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-start gap-4">
        <div className="grid size-14 shrink-0 place-items-center rounded-xl border border-border/60 bg-white/[0.06]">
          <Icon className="size-7" style={brandIconStyle(entry.brand)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xl font-semibold text-foreground">{entry.name}</h3>
            {entry.verified && <BadgeCheck className="size-4 text-muted-foreground" />}
            {entry.isNew && (
              <span className="text-2xs font-medium text-danger-fg">New</span>
            )}
            {entry.isCommunity && (
              <Badge variant="outline" className="text-2xs">
                Community
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{entry.tagline}</p>
        </div>
      </div>

      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
        {entry.description}
      </p>

      {/* What this entry actually gives the user — said in words, not only
       * in a badge. Every entry is a sign-in slot or an install recipe;
       * none of them is a capability August ships with. */}
      <div className="rounded-xl border border-border/60 bg-white/[0.03] px-4 py-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Info className="size-3" /> What you get
          <span className="font-normal text-muted-foreground">
            {catalogCapabilityLabel(entry.capability)}
          </span>
        </div>
        <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
          {entry.capabilityNote}
        </p>
      </div>

      {launcherMissing && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-2xs leading-relaxed text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>
            This machine has no{' '}
            <span className="font-mono">{launcherCommand}</span> on PATH, so this recipe cannot
            start here — installing it would give you a server that never runs. Put{' '}
            <span className="font-mono">{launcherCommand}</span> on PATH and reopen August, or
            register the server yourself with <span className="font-medium">Create custom</span>.
          </span>
        </div>
      )}

      {entry.packageName && (
        <p className="text-xs text-muted-foreground">
          Under the hood it uses{' '}
          <span className="font-mono text-foreground/80">
            {entry.packageName}
            {entry.packageVersion ? ` v${entry.packageVersion}` : ''}
          </span>
          .
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Developed by <span className="text-foreground/80">{entry.developer}</span>
      </p>

      <div className="rounded-lg border border-border/60 bg-white/[0.04] px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
        <AlertTriangle className="mb-1 inline size-3 text-warning-fg" /> Only use extensions
        from developers you trust. August does not control third-party MCP tools.
      </div>

      {tools.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Wrench className="size-3" />
            {entry.capability === 'recipe'
              ? 'Tools this server exposes once running'
              : 'Tools'}
            <span className="font-mono font-normal text-muted-foreground">{tools.length}</span>
          </div>
          {entry.capability === 'recipe' && (
            <p className="mb-2 text-2xs leading-relaxed text-muted-foreground">
              These are the third-party server&rsquo;s tools, not August&rsquo;s. They reach the
              agent only while that server is installed and running.
            </p>
          )}
          <ul className="flex flex-wrap gap-1.5">
            {shown.map((t) => (
              <li
                key={t}
                className="rounded-md border border-border/60 bg-white/[0.04] px-2 py-0.5 font-mono text-2xs text-foreground/90"
              >
                {t}
              </li>
            ))}
            {more > 0 && (
              <li className="rounded-md px-2 py-0.5 text-2xs text-muted-foreground">
                +{more} more
              </li>
            )}
          </ul>
        </div>
      )}

      {tools.length === 0 && entry.capability === 'sign-in' && (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          No tools: this entry adds a credential, not something the agent can call. August
          exposes no built-in tool for this service yet.
        </p>
      )}

      {entry.requirements && (
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground">Requirements</p>
          <p className="text-xs text-muted-foreground">{entry.requirements}</p>
        </div>
      )}

      {entry.helpUrl && (
        <a
          href={entry.helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit text-2xs text-primary hover:underline"
        >
          Setup guide →
        </a>
      )}

      {envFields.length > 0 && !installed && (
        <div className="space-y-3 rounded-xl border border-border/60 bg-white/[0.03] p-4">
          <p className="text-xs font-semibold text-foreground">Configuration</p>
          <p className="text-2xs text-muted-foreground">
            These are saved to the MCP server env and to the shared MCP env, so the server — and
            August&rsquo;s own sign-in flows — can read them.
          </p>
          {envFields.map((field) => (
            <div key={field.key} className="space-y-1">
              <label className="block text-2xs font-medium text-muted-foreground">
                {field.label}
                {field.required !== false ? (
                  <span className="text-destructive"> *</span>
                ) : null}
              </label>
              <input
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                value={envValues[field.key] ?? ''}
                onChange={(e) =>
                  setEnvValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                }
                placeholder={field.placeholder}
                className={cn('w-full px-3 py-2 font-mono text-xs', FIELD)}
              />
              {field.help && (
                <p className="text-2xs text-muted-foreground">{field.help}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {entry.categories.map((c) => (
          <Badge key={c} variant="outline" className="text-2xs">
            {c}
          </Badge>
        ))}
      </div>

      {formError && (
        <p className="text-xs text-destructive">{formError}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          onClick={handleInstall}
          disabled={installed || busy || launcherMissing}
          className="min-w-[140px]"
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : installed ? (
            <Check className="size-3" />
          ) : (
            <Plus className="size-3" />
          )}
          {installed
            ? 'Already added'
            : launcherMissing
              ? 'Cannot install here'
              : entry.kind === 'mcp-extension'
                ? 'Install'
                : 'Add'}
        </Button>
        {entry.kind === 'mcp-extension' && (
          <Button
            type="button"
            variant="outline"
            disabled={smokeBusy}
            onClick={() => {
              void runSmoke();
            }}
            title="Check that this MCP server is registered / running"
          >
            {smokeBusy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
            Smoke test
          </Button>
        )}
      </div>
      {smoke && (
        <p className="text-xs text-muted-foreground" data-testid="mcp-smoke-result">
          {smoke}
        </p>
      )}
    </div>
  );
}
