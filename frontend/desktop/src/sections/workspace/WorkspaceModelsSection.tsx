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

  return (
    <div className="h-full flex flex-col">
      <header className="mx-auto w-full max-w-5xl px-8 pt-6 pb-3 shrink-0 flex flex-col gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Model settings</h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-xl">
            Providers are the source of truth for every model dropdown. Add a provider here and chat picks it up without restarting.
          </p>
        </div>
        <nav className="flex flex-wrap items-center gap-1" aria-label="Model settings views">
          {SUBTABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setSubtab(t.key)}
              aria-pressed={subtab === t.key}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition',
                subtab === t.key
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <t.icon className="size-3.5" />
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex-1 min-h-0 px-8 pb-8 overflow-hidden flex flex-col">
        <div className="mx-auto w-full max-w-5xl flex-1 min-h-0 flex flex-col overflow-hidden">
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
