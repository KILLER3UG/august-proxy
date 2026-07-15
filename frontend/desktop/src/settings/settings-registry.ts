/* ── Settings registry — single source of truth for the Settings IA ── */
/* Drives the left rail, global search, route resolution, and the
 * parallel chat-side workspace panel.
 *
 * 5 categories, 18 sections, balanced 3–5+ items per category.
 * Sections are tagged `tier: 'basic' | 'advanced'` so the rail can show
 * a short beginner list by default and reveal advanced surfaces behind
 * a "Show advanced" toggle (persisted to localStorage by
 * `useSettingsAdvancedPreference`).
 *
 * See `docs/settings-audit.md` for the rationale + section movement
 * history.
 *
 * Hard rules (enforced by the audit at the bottom of this file):
 *   • Every section id is immutable — deep links and legacy aliases
 *     resolve to it forever. To rename a section, change only the
 *     `label` and add the old name to `legacyAliases`.
 *   • Every icon is unique within the registry. The previous brain-icon
 *     triplet broke user scanning; we no longer allow it.
 *   • Every keyword is owned by exactly one section. (Tags like
 *     `usage`, `error`, `host` are no longer claimed by the largest
 *     section just because it has room.)
 *   • Every section declares a valid `tier` (`basic` or `advanced`).
 */
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Boxes,
  BookOpen,
  Bot,
  ClipboardList,
  Code2,
  Cpu,
  FolderLock,
  GitBranch,
  Globe,
  Kanban,
  LineChart,
  MessagesSquare,
  Monitor,
  Network,
  Plug,
  Radio,
  Search as SearchIcon,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  Palette,
} from 'lucide-react';

/** Visibility tier for the rail. `basic` items are always shown; the
 *  `advanced` tier is hidden until the user toggles "Show advanced". */
export type SettingsTier = 'basic' | 'advanced';

/**
 * A single settings screen. `id` doubles as the URL param (`?tab=<id>`),
 * `keywords` power global search, and `legacyAliases` keep old deep links
 * (`/settings/traffic`, `/settings/connections`, ...) resolving to the
 * correct section.
 */
export interface SettingsSection {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  category: string;
  /** Beginner-friendliness tier. `basic` items are always shown in the
   *  rail; `advanced` items are hidden until the user enables the
   *  "Show advanced" toggle. Deep links always resolve and reveal the
   *  targeted section even when advanced is off. */
  tier: SettingsTier;
  keywords: string[];
  /** Old tab keys that should now open this section. */
  legacyAliases?: string[];
}

export interface SettingsCategory {
  id: string;
  label: string;
  description: string;
}

/**
 * Top-level categories shown as group headers in the sidebar. Order
 * here is the order they render. Sections reference categories by
 * `category` id.
 *
 * v3 IA (2026-07): replaces the prior 7-category scheme that had
 * singleton categories (memory, activity), a junk drawer ("Advanced"
 * with 5 mixed sections), and duplicate Brain icons across 3 sections.
 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    id: 'general',
    label: 'General',
    description: 'App-level basics: health, appearance, and conversation history.',
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    description: 'The cognitive core: providers, brain orchestration, and memory.',
  },
  {
    id: 'tools',
    label: 'Tools & Skills',
    description: 'Capabilities the agent can use: MCP servers, skills, computer use, agents.',
  },
  {
    id: 'activity',
    label: 'Activity',
    description: 'Telemetry and observability surfaces: traffic, logs, inspectors.',
  },
  {
    id: 'security',
    label: 'Security & Access',
    description: 'Gating surfaces: API access, filesystem permissions, developer surfaces.',
  },
] as const;

/**
 * The 18 sections of the Settings left rail.
 *
 * Every section's `id` is immutable for legacy-alias support. To rename
 * a section, change the `label` and re-export the old label as an
 * alias.
 *
 * `tier: 'basic'` items are shown by default. `tier: 'advanced'` items
 * are hidden until the user enables the "Show advanced" toggle.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  /* ── General ───────────────────────────────────────────────────── */
  {
    id: 'system-health',
    label: 'System & Health',
    description: 'Gateway status, uptime, RAM, endpoint URLs, and connect-an-app URLs.',
    icon: Activity,
    category: 'general',
    tier: 'basic',
    // Note: 'gateway' is owned by api-access (the action surface for
    // opening/closing it). 'connect' is owned by api-access.
    // 'connection' is owned by tools-connections. 'ram' is used in
    // lieu of 'memory' to avoid colliding with memory-knowledge.
    keywords: ['health', 'provider status', 'uptime', 'endpoints', 'host', 'port', 'ram'],
    legacyAliases: ['health'],
  },
  {
    id: 'profile-preferences',
    label: 'Profile & Preferences',
    description: 'Theme, appearance, text size, presets, keyboard shortcuts, and onboarding.',
    icon: SlidersHorizontal,
    category: 'general',
    tier: 'basic',
    keywords: ['profile', 'theme', 'appearance', 'shortcuts', 'hotkeys', 'presets', 'onboarding', 'tour', 'language'],
    legacyAliases: ['appearance', 'theme', 'shortcuts', 'hotkeys'],
  },
  {
    id: 'ui-designer',
    label: 'UI Designer',
    description: 'Customize colors for background, chat input, sidebar, settings, and brand — live preview + Apply.',
    icon: Palette,
    category: 'general',
    tier: 'basic',
    keywords: ['ui designer', 'customize', 'colors', 'paint', 'branding', 'sidebar color', 'chat input color', 'preview'],
    legacyAliases: ['ui-customization', 'theme-editor', 'design-ui'],
  },
  {
    id: 'conversations-history',
    label: 'Conversations',
    description: 'Archived chat sessions and per-conversation history.',
    icon: MessagesSquare,
    category: 'general',
    tier: 'basic',
    keywords: ['conversation', 'history', 'archive', 'session', 'chat'],
    legacyAliases: ['archive', 'conversations', 'chat-history', 'session-history'],
  },

  /* ── Intelligence ────────────────────────────────────────────── */
  {
    id: 'model-providers',
    label: 'Model Providers',
    description: 'Provider cards, model catalog, aliases, quotas, and per-model usage + cost.',
    icon: Boxes,
    category: 'intelligence',
    tier: 'basic',
    keywords: ['model', 'provider', 'api key', 'quota', 'usage', 'cost', 'token', 'catalog', 'alias', 'context window', 'reasoning', 'effort', 'temperature'],
    legacyAliases: ['models', 'providers'],
  },
  {
    id: 'brain-orchestrator',
    label: 'Brain Orchestrator',
    description: 'Per-turn policy: adaptive rules, agent depth, parallel tools, failure learning.',
    icon: Cpu,
    category: 'intelligence',
    tier: 'advanced',
    keywords: ['brain', 'orchestrator', 'policy', 'agent depth', 'subagent', 'tool loop', 'parallel'],
    legacyAliases: ['brain'],
  },
  {
    id: 'memory-knowledge',
    label: 'Memory & Knowledge',
    description: 'Memory store, semantic facts, vector entries, knowledge graph, and system prompt.',
    icon: Network,
    category: 'intelligence',
    tier: 'advanced',
    keywords: ['memory', 'semantic', 'facts', 'vector', 'db', 'graph', 'knowledge', 'prompt', 'learning', 'guidelines'],
    legacyAliases: ['memory', 'semantic-facts', 'vector-db'],
  },

  /* ── Tools & Skills ──────────────────────────────────────────── */
  {
    id: 'tools-connections',
    label: 'Integrations',
    description: 'Add Gmail, Calendar, Drive, GitHub, Slack, and MCP extensions for August.',
    icon: Plug,
    category: 'tools',
    tier: 'basic',
    keywords: [
      'mcp',
      'integration',
      'connection',
      'service',
      'oauth',
      'account',
      'google',
      'gmail',
      'calendar',
      'drive',
      'github',
      'slack',
      'filesystem',
      'directory',
    ],
    legacyAliases: ['mcp', 'commands', 'connections', 'services', 'tools-connections'],
  },
  {
    id: 'skills',
    label: 'Skills',
    description: 'Create, edit, and manage agent skills and their lifecycle (active / stale / archived).',
    icon: BookOpen,
    category: 'tools',
    tier: 'basic',
    // Merged keywords from the old skill-curator + skills-authoring
    // sections. Authoring actions are reached via 'author' or 'create';
    // lifecycle actions via 'curator', 'lifecycle', or 'stale'.
    // 'skill' is owned by this section. 'archive' is owned by
    // conversations-history (archived sessions), so we don't claim it
    // here — pin/unpin/curate are reached via their own keywords.
    keywords: ['skill', 'author', 'create', 'edit', 'delete', 'manage', 'curator', 'lifecycle', 'stale', 'consolidate', 'pin'],
    // Old ids preserved so /settings/skills-authoring and
    // /settings/skill-curator deep links still resolve here.
    legacyAliases: ['skills-authoring', 'skill-curator'],
  },
  {
    id: 'computer-use',
    label: 'Computer Use',
    description: 'Desktop automation with SOM overlay, cross-platform support, and safe approval workflows.',
    icon: Monitor,
    category: 'tools',
    tier: 'advanced',
    // Note: 'automation' is owned by agents-automation (cron/automations).
    // Computer Use is reached via 'desktop', 'som', or 'screenshot'.
    keywords: ['computer', 'use', 'desktop', 'som', 'overlay', 'screenshot', 'click', 'type'],
  },
  {
    id: 'agents-automation',
    label: 'Agents & Automation',
    description: 'Agent registry, permissions, automations, and approvals.',
    icon: Bot,
    category: 'tools',
    tier: 'advanced',
    keywords: ['agent', 'automation', 'permission', 'scope', 'approval', 'terminal', 'schedule', 'job'],
    legacyAliases: ['agents', 'agent-permissions', 'automations', 'terminal'],
  },
  {
    id: 'tool-grants',
    label: 'Path Permissions',
    description: 'Always-here tool grants by workspace path — list, explain, revoke.',
    icon: FolderLock,
    category: 'security',
    tier: 'basic',
    keywords: ['grant', 'always', 'path-permission', 'revoke', 'allowlist-path'],
    legacyAliases: ['always-grants', 'path-grants'],
  },
  {
    id: 'agent-board',
    label: 'Agent Board',
    description: 'Durable kanban board for multi-agent work across sessions.',
    icon: Kanban,
    category: 'tools',
    tier: 'basic',
    keywords: ['kanban', 'board', 'multi-agent', 'cards'],
    legacyAliases: ['kanban'],
  },
  {
    id: 'python-sandbox',
    label: 'Python Sandbox',
    description: 'Safe Python cell with no network, banned imports, and timeout.',
    icon: Code2,
    category: 'tools',
    tier: 'advanced',
    keywords: ['python', 'sandbox', 'cell', 'exec'],
    legacyAliases: ['sandbox'],
  },

  /* ── Activity ────────────────────────────────────────────────── */
  {
    id: 'observability',
    label: 'Observability',
    description: 'Audit log, rollback history, post-observation screenshots, traffic, and logs.',
    icon: LineChart,
    category: 'activity',
    tier: 'advanced',
    // Note: 'screenshot' is owned by computer-use. 'history' is owned
    // by conversations-history. 'security' is owned by computer-access.
    // Post-observation screenshots are reached via 'observation' here.
    keywords: ['audit', 'rollback', 'observation', 'compliance', 'undo', 'artifacts', 'traffic', 'log', 'activity'],
    legacyAliases: ['traffic-activity', 'overview', 'logs', 'traffic', 'activity', 'artifacts', 'audit', 'rollback', 'observations'],
  },
  {
    id: 'conversation-inspector',
    label: 'Conversation Inspector',
    description: 'Readable transcript, raw request/response bodies, and assistant thinking.',
    icon: SearchIcon,
    category: 'activity',
    tier: 'advanced',
    // Note: 'debug' is owned by developer-console. Conversation Inspector
    // is reached via 'inspector', 'request', 'response', 'thinking'.
    keywords: ['inspector', 'request', 'response', 'body', 'thinking', 'trace', 'finish reason', 'error'],
    legacyAliases: ['inspector', 'conversation', 'thinking'],
  },
  {
    id: 'backend-monitor',
    label: 'Backend Monitor',
    description: 'Real-time stream of proxy, memory, scheduler, and tool events.',
    icon: Radio,
    category: 'activity',
    tier: 'advanced',
    // Note: 'memory' is owned by memory-knowledge. 'console' is owned
    // by developer-console. 'monitor' is the dominant discoverer here.
    keywords: ['logs', 'live', 'stream', 'events', 'monitor', 'websocket', 'proxy', 'scheduler'],
  },
  {
    id: 'feature-flow',
    label: 'Feature Flow',
    description: 'Animated live pipeline of backend feature execution with inventory directory.',
    icon: GitBranch,
    category: 'activity',
    tier: 'advanced',
    keywords: ['feature', 'flow', 'pipeline', 'animation', 'inventory', 'sse', 'execution'],
    legacyAliases: ['feature-flow-viz', 'execution-visualizer'],
  },
  {
    id: 'plans',
    label: 'Plans & Todos',
    description: 'Workspace .aug artifacts — model-generated plans and todo lists. Manually delete survivors left behind by errors.',
    icon: ClipboardList,
    category: 'activity',
    tier: 'advanced',
    keywords: ['plans', 'todos', 'aug', 'init', 'checklist', 'tasks'],
    legacyAliases: ['aug-plans', 'aug-artifacts'],
  },

  /* ── Security & Access ──────────────────────────────────────── */
  {
    id: 'computer-access',
    label: 'Computer Access',
    description: 'Filesystem scope, allowed roots, and computer-use app allowlist.',
    icon: ShieldCheck,
    category: 'security',
    tier: 'advanced',
    // Note: 'filesystem' is owned by tools-connections (MCP/FS tools).
    keywords: ['roots', 'security', 'allowlist', 'computer-use-scope'],
  },
  {
    id: 'api-access',
    label: 'API Access',
    description: 'Open or close the proxy gateway for external clients, manage the API key.',
    icon: Globe,
    category: 'security',
    tier: 'basic',
    // Note: 'token' is owned by model-providers (token cost tracking).
    // API auth tokens are reached via 'bearer' here.
    keywords: ['api', 'access', 'gateway', 'key', 'external', 'client', 'curl', 'openai', 'anthropic', 'bearer', 'sdk', 'endpoint'],
  },
  {
    id: 'developer-console',
    label: 'Developer Console',
    description: 'August console and advanced debug/reset options (experimental).',
    icon: TerminalSquare,
    category: 'security',
    tier: 'advanced',
    keywords: ['developer', 'console', 'august', 'debug', 'reset', 'experimental'],
    legacyAliases: ['advanced'],
  },
] as const;

/* ── Lookup helpers (used by routes.ts + SettingsOverlay + WorkspaceShell) ── */

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
  return LEGACY_TAB_MAP.get(raw ?? '') ?? SETTINGS_SECTIONS[0].id;
}

export function getSection(id: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((s) => s.id === id);
}

export function sectionsForCategory(categoryId: string): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => s.category === categoryId);
}

/* ── IA integrity audit ───────────────────────────────────────────────────── */
/* Run as a dev-time invariant. Throw with a descriptive message if any
 * invariant is broken — the build will fail rather than silently ship a
 * buggy IA. */
export function auditRegistry(): void {
  const ids = new Set<string>();
  const icons = new Map<LucideIcon, string[]>();
  const keywords = new Map<string, string>();
  const legacyAliases = new Map<string, string>();
  const tiers = new Set<string>();

  for (const s of SETTINGS_SECTIONS) {
    if (ids.has(s.id)) {
      throw new Error(`settings-registry: duplicate section id "${s.id}"`);
    }
    ids.add(s.id);

    if (s.tier !== 'basic' && s.tier !== 'advanced') {
      throw new Error(
        `settings-registry: section "${s.id}" has invalid tier "${String(s.tier)}" — must be "basic" or "advanced"`,
      );
    }
    tiers.add(s.tier);

    const iconOwners = icons.get(s.icon) ?? [];
    iconOwners.push(s.id);
    icons.set(s.icon, iconOwners);

    for (const k of s.keywords) {
      const key = k.toLowerCase();
      if (keywords.has(key)) {
        throw new Error(
          `settings-registry: keyword "${k}" claimed by both ` +
          `"${keywords.get(key)}" and "${s.id}" — keywords are owned by exactly one section`,
        );
      }
      keywords.set(key, s.id);
    }

    for (const alias of s.legacyAliases ?? []) {
      if (legacyAliases.has(alias)) {
        throw new Error(
          `settings-registry: legacy alias "${alias}" claimed by both ` +
          `"${legacyAliases.get(alias)}" and "${s.id}" — legacy aliases must be unique`,
        );
      }
      legacyAliases.set(alias, s.id);
    }
  }

  for (const [icon, owners] of icons) {
    if (owners.length > 1) {
      throw new Error(
        `settings-registry: lucide icon ${icon.displayName ?? '?'} shared by ${owners.join(', ')} — ` +
        `every section icon must be unique for visual scanning`,
      );
    }
  }

  const validCategories = new Set(SETTINGS_CATEGORIES.map((c) => c.id));
  for (const s of SETTINGS_SECTIONS) {
    if (!validCategories.has(s.category)) {
      throw new Error(
        `settings-registry: section "${s.id}" references unknown category "${s.category}"`,
      );
    }
  }
}
