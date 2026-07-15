/* Shared skill catalog types and form defaults for the Skills settings surface. */

export const SKILL_CATEGORIES = [
  { value: 'uncategorized', label: 'Uncategorized' },
  { value: 'development', label: 'Development' },
  { value: 'testing', label: 'Testing' },
  { value: 'devops', label: 'DevOps' },
  { value: 'writing', label: 'Writing' },
  { value: 'research', label: 'Research' },
  { value: 'learned', label: 'Learned' },
] as const;

export interface SkillSummary {
  name: string;
  description: string;
  trigger: string;
  category: string;
  enabled: boolean;
  createdBy: string;
}

export interface SkillDetail extends SkillSummary {
  instructions: string;
}

export interface SkillUsage {
  name: string;
  useCount: number;
  viewCount: number;
  patchCount: number;
  lastUsedAt: number | null;
  state: string;
  pinned: boolean;
  archivedAt: number | null;
}

export interface CuratorReport {
  active: number;
  staled: string[];
  archived: string[];
  errors: string[];
}

/** One card in the catalog grid. */
export interface SkillRow {
  name: string;
  description: string;
  category: string;
  source: string;
  enabled: boolean;
  state: string;
  pinned: boolean;
  useCount: number;
  viewCount: number;
  patchCount: number;
  lastUsedAt: number | null;
}

export type SkillsMode = 'list' | 'create' | 'edit' | 'detail';

export const EMPTY_SKILL_FORM = {
  name: '',
  description: '',
  body: '',
  trigger: '',
  category: 'uncategorized',
};

export type SkillFormState = typeof EMPTY_SKILL_FORM;

/** Merge skill summaries with curator usage into sorted catalog rows. */
export function mergeSkillRows(skills: SkillSummary[], usage: SkillUsage[]): SkillRow[] {
  const byName = new Map<string, SkillRow>();
  for (const s of skills) {
    byName.set(s.name, {
      name: s.name,
      description: s.description,
      category: s.category,
      source: s.createdBy || 'builtin',
      enabled: s.enabled,
      state: 'active',
      pinned: false,
      useCount: 0,
      viewCount: 0,
      patchCount: 0,
      lastUsedAt: null,
    });
  }
  for (const u of usage) {
    const existing = byName.get(u.name);
    if (existing) {
      existing.state = u.state;
      existing.pinned = u.pinned;
      existing.useCount = u.useCount;
      existing.viewCount = u.viewCount;
      existing.patchCount = u.patchCount;
      existing.lastUsedAt = u.lastUsedAt;
    } else {
      byName.set(u.name, {
        name: u.name,
        description: '',
        category: '',
        source: 'agent',
        enabled: true,
        state: u.state,
        pinned: u.pinned,
        useCount: u.useCount,
        viewCount: u.viewCount,
        patchCount: u.patchCount,
        lastUsedAt: u.lastUsedAt,
      });
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}
