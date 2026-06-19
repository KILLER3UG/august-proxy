/* ── Settings registry — single source of truth for the Settings IA ── */
/* The overlay sidebar, global search, and legacy-route redirects all read
 * from here. Replacing 18 tabs with 10 grouped sections (see
 * docs/settings-audit.md) is fully driven by this file. */

import type { LucideIcon } from 'lucide-react';
import {
  Heart,
  SlidersHorizontal,
  Boxes,
  Brain,
  Plug,
  Activity,
  Search,
  Bot,
  TerminalSquare,
  ShieldCheck,
} from 'lucide-react';

/**
 * A single settings screen. `id` doubles as the URL param (`?tab=<id>`),
 * `keywords` power global search, and `legacyAliases` keep old deep links
 * (`/settings/traffic`, `/settings/logs`, …) resolving to the right place.
 */
export interface SettingsSection {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  category: string;
  keywords: string[];
  /** Old 18-section tab keys that should now open this section. */
  legacyAliases?: string[];
}

export interface SettingsCategory {
  id: string;
  label: string;
  description: string;
}

/**
 * Top-level categories shown as group headers in the sidebar. Order here is
 * the order they render. Sections reference categories by `category` id.
 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: 'general',     label: 'General',      description: 'Core app behavior and beginner-friendly preferences.' },
  { id: 'chat',        label: 'Chat & Models', description: 'Providers, model catalog, and conversation history.' },
  { id: 'memory',      label: 'Memory',       description: 'Knowledge graph, facts, vectors, and prompts.' },
  { id: 'tools',       label: 'Tools',        description: 'MCP servers, skills, and connected accounts.' },
  { id: 'monitoring',  label: 'Monitoring',   description: 'Live traffic, request details, and logs.' },
  { id: 'debug',       label: 'Debugging',    description: 'Inspect raw requests and assistant thinking.' },
  { id: 'advanced',    label: 'Advanced',     description: 'Agents, automations, and developer surfaces.' },
] as const;

/**
 * The reduced 10-section information architecture. Each entry carries every
 * old tab key it absorbs so deep links from before this refactor keep working.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  /* ── General ─────────────────────────────────────────────────────── */
  {
    id: 'system-health',
    label: 'System & Health',
    description: 'Gateway, provider status, uptime, and connection details.',
    icon: Heart,
    category: 'general',
    keywords: ['health', 'gateway', 'provider', 'status', 'uptime', 'endpoints', 'memory', 'connect'],
    legacyAliases: ['health', 'connections'],
  },
  {
    id: 'profile-preferences',
    label: 'Profile & Preferences',
    description: 'Theme, appearance, shortcuts, presets, and onboarding.',
    icon: SlidersHorizontal,
    category: 'general',
    keywords: ['profile', 'theme', 'appearance', 'shortcuts', 'hotkeys', 'presets', 'onboarding', 'tour', 'language'],
    legacyAliases: ['appearance', 'theme', 'shortcuts', 'hotkeys'],
  },

  /* ── Chat & Models ───────────────────────────────────────────────── */
  {
    id: 'model-providers',
    label: 'Model Providers',
    description: 'Provider cards, model catalog, aliases, quotas, and usage.',
    icon: Boxes,
    category: 'chat',
    keywords: ['model', 'provider', 'api key', 'quota', 'usage', 'catalog', 'alias', 'context window', 'reasoning', 'effort', 'temperature'],
    legacyAliases: ['models', 'providers'],
  },
  {
    id: 'conversations-history',
    label: 'Conversations & History',
    description: 'Chat sessions, archived history, and export/import.',
    icon: Brain,
    category: 'chat',
    keywords: ['conversation', 'history', 'archive', 'session', 'chat', 'export', 'import', 'restore'],
    legacyAliases: ['archive', 'conversations', 'chat-history', 'session-history'],
  },

  /* ── Memory ──────────────────────────────────────────────────────── */
  {
    id: 'memory-knowledge',
    label: 'Memory & Knowledge',
    description: 'Memory store, facts, vectors, graph, and system prompt.',
    icon: Brain,
    category: 'memory',
    keywords: ['memory', 'semantic', 'facts', 'vector', 'db', 'graph', 'knowledge', 'prompt', 'learning', 'guidelines'],
    legacyAliases: ['memory', 'semantic-facts', 'vector-db'],
  },

  /* ── Tools ───────────────────────────────────────────────────────── */
  {
    id: 'tools-connections',
    label: 'Tools & Connections',
    description: 'MCP servers, skills, commands, and connected accounts.',
    icon: Plug,
    category: 'tools',
    keywords: ['mcp', 'skill', 'command', 'connection', 'service', 'oauth', 'account', 'google', 'github', 'slack'],
    legacyAliases: ['mcp', 'skills', 'commands', 'connections', 'services'],
  },

  /* ── Monitoring ──────────────────────────────────────────────────── */
  {
    id: 'traffic-activity',
    label: 'Traffic & Activity',
    description: 'Summary dashboard, requests, details, thinking, and logs.',
    icon: Activity,
    category: 'monitoring',
    keywords: ['traffic', 'activity', 'log', 'overview', 'artifacts', 'usage', 'request', 'token', 'cost', 'error'],
    legacyAliases: ['overview', 'artifacts', 'traffic', 'logs', 'activity', 'usage'],
  },

  /* ── Debugging ───────────────────────────────────────────────────── */
  {
    id: 'conversation-inspector',
    label: 'Conversation Inspector',
    description: 'Readable transcript and raw request/response bodies.',
    icon: Search,
    category: 'debug',
    keywords: ['inspector', 'conversation', 'request', 'response', 'body', 'thinking', 'trace', 'finish reason', 'error'],
    legacyAliases: ['inspector', 'conversation', 'thinking'],
  },

  /* ── Advanced ────────────────────────────────────────────────────── */
  {
    id: 'agents-automation',
    label: 'Agents & Automation',
    description: 'Agent registry, permissions, automations, and approvals.',
    icon: Bot,
    category: 'advanced',
    keywords: ['agent', 'automation', 'permission', 'scope', 'approval', 'terminal', 'schedule', 'job'],
    legacyAliases: ['agents', 'agent-permissions', 'automations', 'terminal'],
  },
  {
    id: 'developer-console',
    label: 'Developer Console',
    description: 'August console and advanced debug/reset options (experimental).',
    icon: TerminalSquare,
    category: 'advanced',
    keywords: ['developer', 'console', 'august', 'debug', 'reset', 'experimental', 'advanced'],
    legacyAliases: ['advanced'],
  },

  /* ── Task 8: Computer Access ─────────────────────────────────────── */
  {
    id: 'computer-access',
    label: 'Computer Access',
    description: 'Filesystem scope, allowed roots, and computer-use app allowlist.',
    icon: ShieldCheck,
    category: 'advanced',
    keywords: ['filesystem', 'security', 'allowlist', 'host', 'computer-use', 'permission'],
  },
] as const;

/* ── Lookup helpers (used by routes.ts + SettingsOverlay) ──────────── */

/** Map of old tab key → new section id, built once from legacyAliases. */
export const LEGACY_TAB_MAP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const s of SETTINGS_SECTIONS) {
    m.set(s.id, s.id); // an explicit id always resolves to itself
    for (const alias of s.legacyAliases ?? []) m.set(alias, s.id);
  }
  return m;
})();

/** Old "services" tab historically mapped to "mcp"; keep that behaviour. */
export function resolveLegacyTab(raw: string | null): string {
  if (!raw) return SETTINGS_SECTIONS[0].id;
  if (raw === 'services') return 'tools-connections';
  return LEGACY_TAB_MAP.get(raw) ?? SETTINGS_SECTIONS[0].id;
}

export function getSection(id: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((s) => s.id === id);
}

export function sectionsForCategory(categoryId: string): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => s.category === categoryId);
}
