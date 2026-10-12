import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ChatThread refresh handler', () => {
  it('refetch handler refreshes the provider catalog', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    // Presence of each name proved nothing: the import alone satisfied both, so
    // the handler could stop calling the catalog and the model picker could stop
    // calling the handler and this stayed green. Assert the two links that carry
    // the behaviour — the handler awaiting the catalog refresh, and the picker's
    // refresh action wired to the handler.
    expect(src).toMatch(/const\s+handleRefreshModels\s*=\s*useCallback[\s\S]{0,160}await\s+refreshProviderCatalog\(/);
    expect(src).toMatch(/onRefreshModels=\{\(\)\s*=>\s*\{[\s\S]{0,60}handleRefreshModels\(\)/);
  });

  it('invalidates provider-availability queries on refresh', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/invalidateQueries[\s\S]{0,120}provider-availability/);
  });

  it('imports and uses useProviderAvailability instead of one-shot useEffect', () => {
    const path = resolve(__dirname, '../sections/chat/hooks/useChatModels.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(
      /import\s*\{[^}]*useProviderAvailability[^}]*\}\s*from\s*['"]@\/hooks\/useProviderAvailability['"]/,
    );
  });
});
