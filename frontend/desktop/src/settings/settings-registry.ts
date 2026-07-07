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

  Search,
  Bot,
  TerminalSquare,
  ShieldCheck,
  LineChart,
  Radio,
  Monitor,
  BookOpen,
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
  { id: 'general',        label: 'General',         description: 'Core app behavior and beginner-friendly preferences.' },
  { id: 'chat',           label: 'Chat & Models',  description: 'Providers, model catalog, and conversation history.' },
  { id: 'memory',         label: 'Memory',          description: 'Knowledge graph, facts, vectors, and prompts.' },
  { id: 'tools',          label: 'Tools',           description: 'MCP servers, skills, and connected accounts.' },
  { id: 'activity',       label: 'Activity',        description: 'Audit log, rollback history, post-observation screenshots, host-agent health, and traffic.' },
  { id: 'debug',          label: 'Debugging',       description: 'Inspect raw requests and assistant thinking.' },
  { id: 'advanced',       label: 'Advanced',        description: 'Agents, automations, developer surfaces, and computer access.' },
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
    id: 'brain-orchestrator',
    label: 'Brain Orchestrator',
    description: 'Tune the per-turn policy: adaptive rules, agent depth, parallel tools, failure learning.',
    icon: Brain,
    category: 'chat',
    keywords: ['brain', 'orchestrator', 'policy', 'agent depth', 'subagent', 'tool loop', 'parallel'],
    legacyAliases: ['brain'],
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

  /* ── Observability (Task 7) — absorbed Traffic & Activity ────────── */
  {
    id: 'observability',
    label: 'Observability',
    description: 'Audit log, rollback history, post-observation screenshots, host-agent health, and traffic — all in one place.',
    icon: LineChart,
    category: 'activity',
    keywords: ['audit', 'rollback', 'observation', 'screenshot', 'log', 'history', 'security', 'compliance', 'undo', 'health', 'host', 'traffic', 'activity', 'usage', 'request', 'token', 'cost', 'error', 'artifacts'],
    legacyAliases: ['traffic-activity', 'overview', 'logs', 'traffic', 'activity', 'usage', 'artifacts', 'audit', 'rollback', 'observations'],
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

  /* ── Backend Monitor (real-time log stream) ──────────────────────── */
  {
    id: 'backend-monitor',
    label: 'Backend Monitor',
    description: 'Real-time stream of proxy, memory, scheduler, and tool events from the August backend.',
    icon: Radio,
    category: 'debug',
    keywords: ['logs', 'live', 'console', 'stream', 'events', 'debug', 'monitor', 'websocket', 'proxy', 'memory', 'scheduler', 'tokens'],
  },

  /* ── Skill Curator ───────────────────────────────────────────────── */
  {
    id: 'skill-curator',
    label: 'Skill Curator',
    description: 'Automatic skill lifecycle management — usage tracking, auto-stale/archived transitions, and consolidation.',
    icon: BookOpen,
    category: 'tools',
    keywords: ['skill', 'curator', 'lifecycle', 'stale', 'archive', 'consolidate', 'usage'],
  },
  {
    id: 'skills-authoring',
    label: 'Skill Authoring',
    description: 'Create, edit, and manage agent-authored skills.',
    icon: BookOpen,
    category: 'tools',
    keywords: ['skill', 'create', 'edit', 'delete', 'author', 'manage'],
  },

  /* ── Computer Use ────────────────────────────────────────────────── */
  {
    id: 'computer-use',
    label: 'Computer Use',
    description: 'Desktop automation with SOM overlay, cross-platform support, and safe approval workflows.',
    icon: Monitor,
    category: 'advanced',
    keywords: ['computer', 'use', 'desktop', 'automation', 'som', 'overlay', 'screenshot', 'click', 'type'],
  },

  /* ── API Access (external gateway) ──────────────────────────────── */
  {
    id: 'api-access',
    label: 'API Access',
    description: 'Open/close the proxy gateway for external clients, manage the API key, see usage examples.',
    icon: Plug,
    category: 'advanced',
    keywords: ['api', 'access', 'gateway', 'key', 'external', 'client', 'curl', 'openai', 'anthropic', 'bearer', 'token', 'sdk'],
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
