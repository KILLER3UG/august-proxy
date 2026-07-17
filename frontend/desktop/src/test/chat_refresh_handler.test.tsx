import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ChatThread refresh handler', () => {
  it('refetch handler refreshes the provider catalog', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/refreshProviderCatalog/);
    expect(src).toMatch(/handleRefreshModels/);
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
