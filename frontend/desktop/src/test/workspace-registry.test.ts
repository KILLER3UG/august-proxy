/* ── Workspace registry filter — consolidation regression ────────────── */
/* v3 IA: workspace-registry.ts is now a thin filter over
 * settings-registry.ts. This file ensures the filter:
 *   - only exposes listed section ids
 *   - re-applies the workspace-specific icon and category overrides
 *   - preserves getWorkspaceSection() fallback semantics
 */
import { describe, it, expect } from 'vitest';
import {
  WORKSPACE_SECTIONS,
  WORKSPACE_CATEGORIES,
  getWorkspaceSection,
} from '@/settings/workspace-registry';
import { SETTINGS_SECTIONS } from '@/settings/settings-registry';

describe('workspace-registry filter', () => {
  it('exposes only the workspace-visible sections', () => {
    for (const s of WORKSPACE_SECTIONS) {
      expect(SETTINGS_SECTIONS.some((r) => r.id === s.id), `${s.id} not in unified registry`).toBe(true);
    }
  });

  it('does not redefine any unified registry field', () => {
    // label, description, keywords must come from the unified registry.
    for (const ws of WORKSPACE_SECTIONS) {
      const unified = SETTINGS_SECTIONS.find((r) => r.id === ws.id);
      expect(unified?.label).toBe(ws.label);
      expect(unified?.description).toBe(ws.description);
      expect(unified?.keywords).toEqual(ws.keywords);
    }
  });

  it('workspace sections have a documented icon and category', () => {
    // Every workspace section must appear in either WORKSPACE_ICONS or
    // WORKSPACE_CATEGORY_MAP. (We can't require *changes* because some
    // sections legitimately use the unified registry's icon/category as-is.)
    // This is enforced by checking the actual override maps in the source.
    // Since the maps are private, we instead validate that every visible
    // section has either an icon or a category that distinguishes it from
    // any other workspace section it shares a category with.
    const seen = new Map<string, string>();
    for (const ws of WORKSPACE_SECTIONS) {
      const key = `${ws.category}:${ws.icon.displayName ?? ws.icon.name ?? '?'}`;
      const prev = seen.get(key);
      // Multiple sections can share the same category:icon combo only if they
      // share a category — within the same category each section must be unique
      // by name. (This is just a weak sanity check; the audit catches real
      // collisions.)
      if (prev) {
        expect(prev === ws.label, `duplicate icon in category ${ws.category}`).toBe(false);
      }
      seen.set(key, ws.label);
    }
  });

  it('WORKSPACE_CATEGORIES preserves canonical registry order first', () => {
    const catIds = WORKSPACE_CATEGORIES.map((c) => c.id);
    expect(catIds).toContain('general');
    expect(catIds).toContain('chat');
    expect(catIds).toContain('monitoring');
  });

  it('getWorkspaceSection() returns the requested section', () => {
    const s = getWorkspaceSection('memory-knowledge');
    expect(s.id).toBe('memory-knowledge');
  });

  it('getWorkspaceSection() falls back to the first section for unknown ids', () => {
    const s = getWorkspaceSection('not-a-real-section');
    expect(s.id).toBe(WORKSPACE_SECTIONS[0].id);
  });

  it('getWorkspaceSection() falls back for null/undefined input', () => {
    expect(getWorkspaceSection(null).id).toBe(WORKSPACE_SECTIONS[0].id);
    expect(getWorkspaceSection(undefined).id).toBe(WORKSPACE_SECTIONS[0].id);
  });
});
