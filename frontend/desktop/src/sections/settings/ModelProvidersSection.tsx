/* ── Model Providers — merges Models/Providers ────────────────────── */
/* Provider auth/config (Providers) and the model catalog + aliases
 * (Models) share provider identity. Grouped under two tabs so users no
 * longer bounce between two top-level sections. */

import { useState } from 'react';
import { Boxes, KeyRound } from 'lucide-react';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { Models } from '@/sections/models/Models';
import { Providers } from '@/sections/providers/Providers';

const TABS = [
  { key: 'catalog',   label: 'Model Catalog', icon: Boxes },
  { key: 'providers', label: 'API Keys & Providers', icon: KeyRound },
] as const;

export function ModelProvidersSection() {
  const [tab, setTab] = useState<string>('catalog');

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 px-6 pt-5 pb-3 shrink-0">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Model Providers</h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            Browse available models, manage aliases, and configure provider API keys and base URLs.
          </p>
        </div>
        <SettingsTabs value={tab} onChange={setTab} items={TABS} label="Model provider views" />
      </header>
      <div className="flex-1 overflow-auto">
        {tab === 'catalog' && <Models />}
        {tab === 'providers' && <Providers />}
      </div>
    </div>
  );
}
