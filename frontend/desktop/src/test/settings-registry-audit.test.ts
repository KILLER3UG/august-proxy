/* ── v3 IA — Settings-registry integrity tests ─────────────────────── */
/* Enforces the invariants declared at the top of settings-registry.ts:
 *   - every section id is unique
 *   - every section icon is unique within the registry
 *   - every keyword is owned by exactly one section
 *   - every section.category references a declared category id
 *   - legacy alias resolution is stable
 *   - the 5/3-5/3 distribution is preserved (no singleton categories)
 *
 * If any of these regress, the IA has been broken. The build will fail
 * rather than silently ship a buggy left rail.
 */
import { describe, it, expect } from 'vitest';
import {
  SETTINGS_SECTIONS,
  SETTINGS_CATEGORIES,
  auditRegistry,
  resolveLegacyTab,
  LEGACY_TAB_MAP,
  getSection,
  sectionsForCategory,
} from '@/settings/settings-registry';

describe('settings-registry audit', () => {
  it('passes the runtime audit() with no throws', () => {
    expect(() => auditRegistry()).not.toThrow();
  });

  it('has 5 categories with no singleton columns', () => {
    expect(SETTINGS_CATEGORIES).toHaveLength(5);
    const counts = SETTINGS_CATEGORIES.map((c) => ({
      id: c.id,
      count: sectionsForCategory(c.id).length,
    }));
    for (const c of counts) {
      expect(c.count, `category ${c.id} has only ${c.count} section(s)`).toBeGreaterThanOrEqual(3);
    }
  });

  it('has 17 sections distributed across categories', () => {
    expect(SETTINGS_SECTIONS).toHaveLength(17);
  });

  it('every section id is unique', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every section icon is unique', () => {
    const seen = new Map<unknown, string>();
    for (const s of SETTINGS_SECTIONS) {
      const prev = seen.get(s.icon);
      expect(prev, `icon shared by ${prev} and ${s.id}`).toBeUndefined();
      seen.set(s.icon, s.id);
    }
  });

  it('every keyword is owned by exactly one section', () => {
    const owners = new Map<string, string>();
    for (const s of SETTINGS_SECTIONS) {
      for (const k of s.keywords) {
        const key = k.toLowerCase();
        const prev = owners.get(key);
        expect(prev, `keyword "${k}" claimed by both ${prev} and ${s.id}`).toBeUndefined();
        owners.set(key, s.id);
      }
    }
  });

  it('every section.category references a declared category', () => {
    const catIds = new Set(SETTINGS_CATEGORIES.map((c) => c.id));
    for (const s of SETTINGS_SECTIONS) {
      expect(catIds.has(s.category), `${s.id} → unknown category "${s.category}"`).toBe(true);
    }
  });

  it('every legacy alias is owned by exactly one section', () => {
    const owners = new Map<string, string>();
    for (const s of SETTINGS_SECTIONS) {
      for (const a of s.legacyAliases ?? []) {
        const prev = owners.get(a);
        expect(prev, `legacy alias "${a}" claimed by both ${prev} and ${s.id}`).toBeUndefined();
        owners.set(a, s.id);
      }
    }
  });

  it('every legacy alias resolves through LEGACY_TAB_MAP', () => {
    for (const s of SETTINGS_SECTIONS) {
      for (const a of s.legacyAliases ?? []) {
        expect(LEGACY_TAB_MAP.get(a), `${s.id}.legacyAliases → ${a} not in map`).toBe(s.id);
      }
    }
  });
});

describe('legacy alias resolution', () => {
  // Spot-check every alias known to ship in /dashboard deep-links, in
  // user notes / docs, or in the codebase's historical `'services →
  // tools-connections'` hard-coded special case.
  const SPOT_CHECKS: Array<[string, string]> = [
    // Hard-coded special case in resolveLegacyTab().
    ['services',         'tools-connections'],
    // tools-connections aliases
    ['mcp',             'tools-connections'],
    ['skills',          'tools-connections'],
    ['commands',        'tools-connections'],
    ['connections',     'tools-connections'], // first-writer wins over system-health
    // observability aliases
    ['traffic-activity','observability'],
    ['overview',        'observability'],
    ['logs',            'observability'],
    ['traffic',         'observability'],
    ['activity',        'observability'],
    ['artifacts',       'observability'],
    ['audit',           'observability'],
    ['rollback',        'observability'],
    ['observations',    'observability'],
    // profile-preferences aliases
    ['appearance',      'profile-preferences'],
    ['theme',           'profile-preferences'],
    ['shortcuts',       'profile-preferences'],
    ['hotkeys',         'profile-preferences'],
    // system-health aliases
    ['health',          'system-health'],
    // model-providers aliases
    ['models',          'model-providers'],
    ['providers',       'model-providers'],
    // brain-orchestrator aliases
    ['brain',           'brain-orchestrator'],
    // conversations-history aliases
    ['archive',         'conversations-history'],
    ['conversations',   'conversations-history'],
    ['chat-history',    'conversations-history'],
    ['session-history', 'conversations-history'],
    // memory-knowledge aliases
    ['memory',          'memory-knowledge'],
    ['semantic-facts',  'memory-knowledge'],
    ['vector-db',       'memory-knowledge'],
    // agents-automation aliases
    ['agents',          'agents-automation'],
    ['agent-permissions','agents-automation'],
    ['automations',     'agents-automation'],
    ['terminal',        'agents-automation'],
    // conversation-inspector aliases
    ['inspector',       'conversation-inspector'],
    ['conversation',    'conversation-inspector'],
    ['thinking',        'conversation-inspector'],
    // developer-console aliases
    ['advanced',        'developer-console'],
  ];

  for (const [raw, expected] of SPOT_CHECKS) {
    it(`resolves "${raw}" → ${expected}`, () => {
      expect(resolveLegacyTab(raw)).toBe(expected);
    });
  }

  it('resolves null to the first section', () => {
    expect(resolveLegacyTab(null)).toBe(SETTINGS_SECTIONS[0].id);
  });

  it('falls back to first section for unknown keys', () => {
    expect(resolveLegacyTab('definitely-not-a-key')).toBe(SETTINGS_SECTIONS[0].id);
  });
});

describe('section getters', () => {
  it('getSection(id) round-trips', () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(getSection(s.id)?.id).toBe(s.id);
    }
  });

  it('getSection returns undefined for unknown ids', () => {
    expect(getSection('nope')).toBeUndefined();
  });

  it('every section in the registry is reachable via LEGACY_TAB_MAP', () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(LEGACY_TAB_MAP.get(s.id), `${s.id} missing from LEGACY_TAB_MAP`).toBe(s.id);
    }
  });
});
