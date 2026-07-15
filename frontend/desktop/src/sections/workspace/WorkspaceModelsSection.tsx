/* ── WorkspaceModelsSection — full Model settings CRUD ───────────────── */
/* Model settings views selected from the top-level View dropdown:
 *   • Providers — two-column CRUD (left rail + per-provider editor);
 *     every entry comes from /api/providers.
 *   • All models — flat catalog with Discover all across providers.
 *   • Aliases — user-defined model aliases routed to real model+provider
 *     via /api/config/model-aliases.
 *   • Fallback / Background & Reflection / Model Fleet / Live / Quotas —
 *     routing and quota policies for sub-agents, background jobs, STT/TTS,
 *     and daily token limits.
 *
 * Provider writes go through providersApi; aliases use updateUserModelAliases.
 * No hardcoded providers in the frontend — every entry comes from the backend.
 */

import { useState } from 'react';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { cn } from '@/lib/utils';
import { ModelFleetTab } from '@/sections/workspace/ModelFleetTab';
import { LiveSettingsTab } from '@/sections/workspace/LiveSettingsTab';
import { SUBTABS, type ModelSettingsSubtab } from './models/modelSettingsShared';
import { ProvidersTab } from './models/ProvidersTab';
import { AllModelsTab } from './models/AllModelsTab';
import { AliasesTab } from './models/AliasesTab';
import { FallbackTab } from './models/FallbackTab';
import { BackgroundReflectionTab } from './models/BackgroundReflectionTab';
import { QuotasTab } from './models/QuotasTab';

export function WorkspaceModelsSection() {
  const [subtab, setSubtab] = useState<ModelSettingsSubtab>('providers');
  const activeView = SUBTABS.find((t) => t.key === subtab) ?? SUBTABS[0];

  return (
    <div className="h-full flex flex-col">
      <header className="mx-auto w-full max-w-5xl px-8 pt-6 pb-3 shrink-0 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Model settings</h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-xl">
            Providers are the source of truth for every model dropdown. Add a provider here and chat picks it up without restarting.
          </p>
        </div>
        <div className="w-full sm:w-64 shrink-0">
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            View
          </label>
          <SettingsSelect
            aria-label="Model settings view"
            value={subtab}
            onChange={(k) => setSubtab(k as ModelSettingsSubtab)}
            options={SUBTABS.map((t) => ({ value: t.key, label: t.label }))}
          />
        </div>
      </header>

      {/* Providers needs overflow-hidden so its two panes scroll independently.
          Other views scroll the page body as usual. */}
      <div
        className={cn(
          'flex-1 min-h-0 px-8 pb-8',
          subtab === 'providers' ? 'overflow-hidden flex flex-col' : 'overflow-auto',
        )}
      >
        <div
          className={cn(
            'mx-auto w-full max-w-5xl',
            subtab === 'providers' && 'flex-1 min-h-0 flex flex-col',
          )}
        >
          <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground shrink-0">
            {activeView.icon && <activeView.icon className="size-3.5 text-primary" />}
            <span className="font-medium text-foreground/85">{activeView.label}</span>
          </div>
          {subtab === 'providers' && <ProvidersTab />}
          {subtab === 'all-models' && <AllModelsTab />}
          {subtab === 'aliases' && <AliasesTab />}
          {subtab === 'fallback' && <FallbackTab />}
          {subtab === 'reflection' && <BackgroundReflectionTab />}
          {subtab === 'fleet' && <ModelFleetTab />}
          {subtab === 'live' && <LiveSettingsTab />}
          {subtab === 'quotas' && <QuotasTab />}
        </div>
      </div>
    </div>
  );
}
