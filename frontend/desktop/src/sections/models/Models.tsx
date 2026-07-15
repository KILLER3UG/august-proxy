import { useState } from 'react';
import { MODELS_TABS, type ModelsTab } from './modelsShared';
import { CatalogTab } from './CatalogTab';
import { CapabilitiesTab } from './CapabilitiesTab';
import { AliasesTab } from './AliasesTab';
import { UserAliasesTab } from './UserAliasesTab';
import { CostTab } from './CostTab';
import { QuotasTab } from './QuotasTab';

export function Models() {
  const [tab, setTab] = useState<ModelsTab>('catalog');

  return (
    <div className="space-y-5 flex flex-col h-full max-w-5xl mx-auto w-full">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold tracking-tight text-foreground">Models</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Catalog of models from every configured provider.
          </p>
        </div>
        <div className="w-full sm:w-52">
          <select
            value={tab}
            onChange={(e) => setTab(e.target.value as ModelsTab)}
            aria-label="Models view"
            className="h-9 w-full appearance-none rounded-lg border border-white/[0.08] bg-card px-3 text-sm text-foreground outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/30 [color-scheme:dark]"
          >
            {MODELS_TABS.map((t) => (
              <option key={t.key} value={t.key} className="bg-card text-foreground">
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'catalog' && <CatalogTab />}
        {tab === 'capabilities' && <CapabilitiesTab />}
        {tab === 'aliases' && <AliasesTab />}
        {tab === 'user-aliases' && <UserAliasesTab />}
        {tab === 'cost' && <CostTab />}
        {tab === 'quotas' && <QuotasTab />}
      </div>
    </div>
  );
}
