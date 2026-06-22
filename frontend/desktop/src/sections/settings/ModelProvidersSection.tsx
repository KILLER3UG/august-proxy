/* ── Model Providers — deeply consolidated section ─────────────────── */
/* Replaces the 2 old top-level sections (Models, Providers) with one
 * section that:
 *   • fetches /api/config/activeProvider + aggregated models once via
 *     useModelProviders — Providers.tsx and Models.tsx still keep their
 *     own fetches inside (we don't rewrite their internals here), but
 *     the section's overview reads the shared data
 *   • renders Overview / Models / Providers / Quotas as subtabs using
 *     the new shared SettingsCard / SettingsTabs / SettingsEmptyState
 *   • keeps the existing <Models /> and <Providers /> components as the
 *     heavy edit/list UIs, and uses the extracted <QuotasPanel /> as a
 *     first-class subtab (was buried as Models' 6th internal tab) */

import { useState } from 'react';
import {
  Boxes,
  KeyRound,
  Gauge,
  LayoutGrid,
  Brain,
  Sparkles,
  Server,
  CircleDot,
  type LucideIcon,
} from 'lucide-react';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { SettingsTooltip } from '@/components/settings/SettingsTooltip';
import { SettingsEmptyState } from '@/components/settings/SettingsEmptyState';
import { Badge } from '@/components/ui/badge';
import { Models } from '@/sections/models/Models';
import { Providers } from '@/sections/providers/Providers';
import { useModelProviders } from './useModelProviders';
import { QuotasPanel } from './QuotasPanel';

/* ── Subtab definitions ─────────────────────────────────────────────── */

const TABS: { key: 'overview' | 'models' | 'providers' | 'quotas'; label: string; icon: LucideIcon }[] = [
  { key: 'overview',  label: 'Overview',  icon: LayoutGrid },
  { key: 'models',    label: 'Models',    icon: Boxes },
  { key: 'providers', label: 'Providers', icon: KeyRound },
  { key: 'quotas',    label: 'Quotas',    icon: Gauge },
];

/* ── Top-level section ──────────────────────────────────────────────── */

export function ModelProvidersSection() {
  const [tab, setTab] = useState<string>('overview');
  const data = useModelProviders();

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 px-6 pt-5 pb-3 shrink-0">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Model Providers</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            Browse available models, manage aliases, configure provider API keys, and watch your quotas.
          </p>
        </div>
        <SettingsTabs value={tab} onChange={setTab} items={TABS} label="Model provider views" />
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        {tab === 'overview'  && <OverviewTab data={data} onJump={setTab} />}
        {tab === 'models'    && <Models />}
        {tab === 'providers' && <Providers />}
        {tab === 'quotas'    && <QuotasPanel />}
      </div>
    </div>
  );
}

/* ── Overview subtab ────────────────────────────────────────────────── */

function OverviewTab({
  data,
  onJump,
}: {
  data: ReturnType<typeof useModelProviders>;
  onJump: (tab: string) => void;
}) {
  const active = data.providers.find((p) => p.id === data.activeProvider) ?? null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SettingsCard
          icon={Sparkles}
          title="Models"
          description="Across all providers, including aliases and free ones."
          status={
            <Badge variant="outline" className="font-mono">
              {data.totalCount}
            </Badge>
          }
          actions={
            <button onClick={() => onJump('models')} className="text-[11px] font-medium text-primary hover:underline">
              Browse →
            </button>
          }
          inert
        >
          <p className="text-xs text-muted-foreground">
            {data.freeCount} free · {data.reasoningCount} reasoning-capable
          </p>
        </SettingsCard>

        <SettingsCard
          icon={Server}
          title="Active provider"
          description="The provider the proxy routes new requests to."
          status={
            active ? (
              <Badge variant="default" className="text-[9px] gap-1">
                <CircleDot className="size-2.5" /> active
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[9px]">none</Badge>
            )
          }
          actions={
            <button onClick={() => onJump('providers')} className="text-[11px] font-medium text-primary hover:underline">
              Switch →
            </button>
          }
          inert
        >
          <p className="font-mono text-sm">{active?.name ?? data.activeProvider ?? '—'}</p>
        </SettingsCard>

        <SettingsCard
          icon={KeyRound}
          title="Configured"
          description="Providers with a valid API key or auth."
          status={
            <Badge
              variant={data.availableProviderCount > 0 ? 'success' : 'destructive'}
              className="font-mono"
            >
              {data.availableProviderCount}/{data.providers.length}
            </Badge>
          }
          actions={
            <button onClick={() => onJump('providers')} className="text-[11px] font-medium text-primary hover:underline">
              Configure →
            </button>
          }
          inert
        >
          <p className="text-xs text-muted-foreground">
            {data.providers.length - data.availableProviderCount > 0
              ? `${data.providers.length - data.availableProviderCount} need auth.`
              : 'All providers configured.'}
          </p>
        </SettingsCard>

        <SettingsCard
          icon={Gauge}
          title="Quotas"
          description="Daily token usage per model (when adapters report it)."
          actions={
            <button onClick={() => onJump('quotas')} className="text-[11px] font-medium text-primary hover:underline">
              View →
            </button>
          }
          inert
        >
          <p className="text-xs text-muted-foreground">
            Track daily limits in the Quotas tab.
          </p>
        </SettingsCard>
      </div>

      {/* Provider summary list */}
      {data.providers.length === 0 ? (
        <SettingsEmptyState
          icon={Server}
          title="No providers configured"
          description="Once you sign in or add an API key, providers appear here and models become available in the catalog."
        />
      ) : (
        <SettingsCard
          title="Providers at a glance"
          description="Click any row to manage its API key, base URL, and active state on the Providers tab."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {data.providers.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
              >
                <span
                  className={`inline-block size-2 rounded-full shrink-0 ${
                    p.isAvailable
                      ? 'bg-success shadow-[0_0_10px_rgba(16,185,129,.45)]'
                      : 'bg-muted-foreground/30'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{p.name}</span>
                    {p.id === data.activeProvider && (
                      <Badge variant="default" className="text-[9px]">active</Badge>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground font-mono truncate">
                    {p.apiMode}
                    <SettingsTooltip content="The wire protocol the provider speaks (anthropic, openai, openai-responses, …)." />
                  </p>
                </div>
                {p.isAvailable ? (
                  <Badge variant="success" className="text-[9px] shrink-0">ready</Badge>
                ) : (
                  <Badge variant="secondary" className="text-[9px] shrink-0">needs key</Badge>
                )}
              </div>
            ))}
          </div>
        </SettingsCard>
      )}

      {/* Reasoning models highlight */}
      {data.reasoningCount > 0 && (
        <SettingsCard
          icon={Brain}
          title={`${data.reasoningCount} reasoning-capable models`}
          description="These models expose their thinking either as reasoning_effort or extended thinking blocks."
        >
          <p className="text-xs text-muted-foreground">
            See the full list in the Models tab.
          </p>
        </SettingsCard>
      )}
    </div>
  );
}
