import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('useProviderAvailability hook', () => {
  it('exports a hook keyed on ["provider-availability"]', () => {
    const path = resolve(__dirname, '../hooks/useProviderAvailability.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/queryKey:\s*\[\s*['"]provider-availability['"]\s*\]/);
    expect(src).toMatch(/export\s+function\s+useProviderAvailability/);
  });

  it('fetches from /api/config/activeProvider', () => {
    const path = resolve(__dirname, '../hooks/useProviderAvailability.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/\/api\/config\/activeProvider/);
  });
});
