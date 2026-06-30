import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ChatThread refresh handler', () => {
  it('refetch handler calls getAggregatedModels with refresh:true', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/getAggregatedModels\s*\(\s*\{\s*refresh:\s*true\s*\}\s*\)/);
  });

  it('invalidates both aggregated-models and provider-availability queries', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/invalidateQueries[\s\S]{0,120}aggregated-models/);
    expect(src).toMatch(/invalidateQueries[\s\S]{0,300}provider-availability/);
  });

  it('imports and uses useProviderAvailability instead of one-shot useEffect', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*useProviderAvailability[^}]*\}\s*from\s*['"]@\/hooks\/useProviderAvailability['"]/);
  });
});
