/* ── workspace-registry — thin filter over settings-registry ───────── */
/* v3 IA (2026-07): the chat-side workspace panel used to maintain its
 * own parallel IA (`memory`, `traffic`, `inspector`, `models`,
 * `general`) that collided with `settings-registry.ts`. We now source
 * sections from the unified registry and only re-categorise those
 * sections the chat-side workspace exposes in its sidebar.
 *
 * If you need to surface a section in the workspace panel, add its id
 * to WORKSPACE_VISIBLE_IDS — define the actual section metadata
 * (icon, label, description, keywords) in settings-registry.ts.
 */
import type { LucideIcon } from 'lucide-react';
import {
  AlignJustify,
  Boxes,
  Brain,
  Search as SearchIcon,
  SlidersHorizontal,
} from 'lucide-react';
import {
  SETTINGS_SECTIONS,
  SETTINGS_CATEGORIES,
  type SettingsSection,
} from './settings-registry';

/** Section ids the chat-side workspace panel exposes in its sidebar. */
export const WORKSPACE_VISIBLE_IDS = new Set([
  // Mirrors the historical data-dense sections from the workspace panel.
  'model-providers',         // → Models & Provider catalog
  'memory-knowledge',        // → Memory (data-dense)
  'observability',           // → Observability (data-dense)
  'conversation-inspector',  // → Conversation Inspector (data-dense)
  'profile-preferences',     // → Profile Preferences (theme/shortcuts)
]);

/**
 * Per-section workspace override: which lucide icon the workspace
 * panel uses. (Settings uses different icons in different sections;
 * the workspace panel historically picked one icon per section.)
 */
const WORKSPACE_ICONS: Record<string, LucideIcon> = {
  'profile-preferences':    SlidersHorizontal,
  'model-providers':        Boxes,
  'memory-knowledge':       Brain,
  'observability':          AlignJustify,
  'conversation-inspector': SearchIcon,
};

/**
 * Workspace-side category re-mapping. The chat-side workspace panel
 * historically grouped these under 3 short categories; we keep that
 * UX while sourcing the underlying section data from the unified
 * registry.
 */
const WORKSPACE_CATEGORY_MAP: Record<string, string> = {
  'profile-preferences':    'general',
  'model-providers':        'chat',
  'memory-knowledge':       'general',
  'observability':          'monitoring',
  'conversation-inspector': 'monitoring',
};

/** Sections visible in the workspace panel, decorated with workspace
 * icons and categories. Backed by the unified settings registry. */
export const WORKSPACE_SECTIONS: readonly SettingsSection[] =
  SETTINGS_SECTIONS.filter((s) => WORKSPACE_VISIBLE_IDS.has(s.id)).map(
    (s) => ({
      ...s,
      icon: WORKSPACE_ICONS[s.id] ?? s.icon,
      category: WORKSPACE_CATEGORY_MAP[s.id] ?? s.category,
    }),
  );

/** Categories of sections visible in the workspace panel. */
export const WORKSPACE_CATEGORIES: readonly { id: string; label: string }[] = (() => {
  const seen = new Map<string, string>();
  for (const s of WORKSPACE_SECTIONS) {
    if (s.category && !seen.has(s.category)) {
      const fromUnified = SETTINGS_CATEGORIES.find((c) => c.id === s.category);
      // If the category is workspace-only, fall back to a sensible label.
      seen.set(s.category, fromUnified?.label ?? titleCase(s.category));
    }
  }
  // Preserve the canonical category order from settings registry, then append any
  // workspace-only ones.
  const ordered: { id: string; label: string }[] = [];
  for (const c of SETTINGS_CATEGORIES) {
    const lbl = seen.get(c.id);
    if (lbl) ordered.push({ id: c.id, label: lbl });
  }
  for (const [id, label] of seen) {
    if (!ordered.find((o) => o.id === id)) ordered.push({ id, label });
  }
  return ordered;
})();

export function getWorkspaceSection(id: string | null | undefined): SettingsSection {
  return (
    WORKSPACE_SECTIONS.find((s) => s.id === id) ??
    WORKSPACE_SECTIONS[0]
  );
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
