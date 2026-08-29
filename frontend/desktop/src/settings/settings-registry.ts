/* ── Settings registry — single source of truth for the Settings IA ── */
/* Drives the left rail, global search, route resolution, and the
 * parallel chat-side workspace panel.
 *
 * 3 header groups (Settings / Agent Capabilities / Data & Statistics),
 * 38 sections. The headers are the rail; each header expands its related
 * sections as an inline tree (see `docs/settings-audit.md`).
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
  Gauge,
  Boxes,
  BookOpen,
  Bot,
  BrainCircuit,
  FolderOpen,
  FileText,
  Code2,
  FolderLock,
  GitBranch,
  Globe,
  Kanban,
  Lightbulb,
  LineChart,
  MessagesSquare,
  Monitor,
  Network,
  Plug,
  Radio,
  Search as SearchIcon,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Palette,
  Paintbrush,
  UserRound,
  ArrowUpCircle,
  Bell,
  HeartPulse,
  Wand2,
  Database,
  Stethoscope,
  ArrowRightLeft,
  Layers,
  AudioLines,
  Coins,
  Route,
  Users,
  Flame,
  Sparkles,
  CheckCircle2,
  Zap,
} from 'lucide-react';

/** Visibility tier for the rail. `basic` items are always shown; the
 *  `advanced` tier is hidden until the user toggles "Show advanced". */
export type SettingsTier = 'basic' | 'advanced' | 'hidden';

/**
 * A single settings screen. `id` doubles as the URL segment (`/settings/<id>`),
 * with legacy `?tab=<id>` query links rewritten to the path form.
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
   *  "Show advanced" toggle. `hidden` items are not shown in the rail at
   *  all (deep links still resolve). */
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
 * Top-level header groups shown in the sidebar rail (2026-08-28
 * restructure: the previous 8 hubs were folded into three headers per
 * the UI enhancement request). Headers group related sections; the rail
 * expands each header's sections as an inline tree.
 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    id: 'basics',
    label: 'Basics',
    description: 'General preferences, appearance, model configuration, browser and desktop use.',
  },
  {
    id: 'capabilities',
    label: 'Agent capabilities',
    description: 'Memory, subagents, plugins, MCP servers, skills, commands, and hooks.',
  },
  {
    id: 'data',
    label: 'Data and statistics',
    description: 'Indexing and usage statistics.',
  },
] as const;

/**
 * The sections of the Settings left rail (see docs/settings-audit.md).
 *
 * Every section's `id` is immutable for legacy-alias support. To rename
 * a section, change the `label` and re-export the old label as an
 * alias.
 *
 * `tier: 'basic'` items are shown by default. `tier: 'advanced'` items
 * are hidden until the user enables the "Show advanced" toggle.
 *
 * Array order = rail order within each header group.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  /* ── Basics header ─────────────────────────────────────────────── */
  {
    id: 'general',
    label: 'General',
    description:
      'Profile, preferences, notifications, text size, experience presets, shortcuts, and onboarding.',
    icon: SlidersHorizontal,
    category: 'basics',
    tier: 'basic',
    keywords: [
      'general',
      'profile',
      'preferences',
      'notifications',
      'text size',
      'presets',
      'tour',
      'shortcuts',
      'hotkeys',
      'language',
      'chat font',
      'serif',
      'reduce motion',
      'call you',
      'instructions for august',
    ],
    legacyAliases: ['profile-preferences'],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, light/dark mode, and the UI color designer.',
    icon: Palette,
    category: 'basics',
    tier: 'basic',
    keywords: ['appearance', 'theme', 'dark mode', 'light mode', 'color scheme'],
    legacyAliases: ['theme'],
  },
  {
    id: 'model-providers',
    label: 'Model settings',
    description: 'Manage custom model providers. Once configured, they can be selected during chat.',
    icon: Boxes,
    category: 'basics',
    tier: 'basic',
    keywords: ['provider', 'api key', 'base url', 'api format', 'model discovery', 'model settings', 'cost', 'reasoning', 'effort', 'temperature'],
    legacyAliases: ['models', 'providers', 'model-settings'],
  },
  {
    id: 'browser-use',
    label: 'Browser Use',
    description: 'Browser automation, web search, and live web preview.',
    icon: Globe,
    category: 'basics',
    tier: 'basic',
    keywords: ['browser', 'browser use', 'web search', 'page read', 'web'],
    legacyAliases: ['browser', 'web-browser'],
  },
  {
    id: 'computer-use',
    label: 'Computer Use',
    description: 'Desktop automation with SOM overlay, cross-platform support, and safe approval workflows.',
    icon: Monitor,
    category: 'basics',
    tier: 'basic',
    keywords: ['computer', 'use', 'desktop', 'som', 'overlay', 'screenshot', 'click', 'type'],
    legacyAliases: ['desktop-automation'],
  },
  {
    id: 'system-health',
    label: 'System Status',
    description: 'Gateway status, uptime, RAM, endpoint URLs, and connect-an-app URLs.',
    icon: Activity,
    category: 'basics',
    tier: 'hidden',
    keywords: ['health', 'provider status', 'uptime', 'endpoints', 'host', 'port', 'ram'],
    legacyAliases: ['health'],
  },
  {
    id: 'account',
    label: 'Account',
    description: 'Local August profiles on this device — create, switch, and edit your account.',
    icon: UserRound,
    category: 'basics',
    tier: 'hidden',
    keywords: ['account', 'login', 'sign up', 'display name', 'avatar', 'sign out'],
    legacyAliases: ['accounts', 'user'],
  },
  {
    id: 'privacy',
    label: 'Data & Privacy',
    description: 'What August stores on this device — export, purge memories, clear logs, and delete usage.',
    icon: Database,
    category: 'basics',
    tier: 'hidden',
    keywords: ['privacy', 'data', 'export', 'retention', 'purge', 'wipe', 'cleanup', 'clear data', 'erase'],
  },
  {
    id: 'app-updates',
    label: 'Updates',
    description: 'Check for desktop app releases from GitHub and install updates.',
    icon: ArrowUpCircle,
    category: 'basics',
    tier: 'hidden',
    keywords: ['update', 'release', 'version', 'download app', 'upgrade', 'changelog'],
    legacyAliases: ['updates', 'updater', 'version', 'about'],
  },
  {
    id: 'ui-designer',
    label: 'UI Designer',
    description: 'Customize colors for background, chat input, sidebar, settings, and brand — live preview + Apply.',
    icon: Paintbrush,
    category: 'basics',
    tier: 'hidden',
    keywords: ['ui designer', 'customize', 'colors', 'paint', 'branding', 'sidebar color', 'chat input color', 'preview'],
    legacyAliases: ['ui-customization', 'theme-editor', 'design-ui'],
  },
  {
    id: 'ai-setup',
    label: 'Onboard',
    description: 'Guided first-run wizard: connect a provider, test it, pick models, and choose a safety mode.',
    icon: Wand2,
    category: 'basics',
    tier: 'basic',
    keywords: ['setup', 'wizard', 'getting started', 'first run', 'beginner', 'welcome', 'onboard'],
    legacyAliases: ['onboard'],
  },

  /* ── Agent capabilities header ─────────────────────────────────── */
  {
    id: 'memory-knowledge',
    label: 'Memory',
    description: 'Auto-captured memories and key-value notes August has learned.',
    icon: BrainCircuit,
    category: 'capabilities',
    tier: 'basic',
    keywords: ['memory', 'memories', 'stored', 'remembers', 'remembered', 'recall', 'brain', 'auto-memory'],
    legacyAliases: [
      'memory',
      'vector-db',
      'recalled-memory',
      'auto-memories',
      'project-memories',
      'memory-timeline',
      'memory-sessions',
    ],
  },
  {
    id: 'subagents',
    label: 'Subagents',
    description: 'Multi-agent coordination, subagent tools, and lifecycle.',
    icon: Users,
    category: 'capabilities',
    tier: 'basic',
    keywords: ['subagent', 'subagents', 'delegation', 'agent hierarchy', 'parallel agents', 'multi-agent'],
    legacyAliases: ['subagent', 'sub-agents'],
  },
  {
    id: 'plugins',
    label: 'Plugins',
    description: 'Extensions, plugins, and custom agent tool packs.',
    icon: Layers,
    category: 'capabilities',
    tier: 'basic',
    keywords: ['plugins', 'plugin', 'extensions', 'tool packs', 'addon'],
    legacyAliases: ['plugins-tab', 'plugin-store'],
  },
  {
    id: 'tools-connections',
    label: 'MCP Servers',
    description: 'Add Gmail, Calendar, Drive, GitHub, Slack, and MCP extensions for August.',
    icon: Plug,
    category: 'capabilities',
    tier: 'basic',
    keywords: [
      'mcp',
      'mcp servers',
      'integration',
      'connection',
      'service',
      'oauth',
      'google',
      'gmail',
      'calendar',
      'drive',
      'github',
      'slack',
      'filesystem',
      'directory',
    ],
    legacyAliases: ['mcp', 'commands', 'connections', 'services', 'tools-connections', 'mcp-servers'],
  },
  {
    id: 'skills',
    label: 'Skills',
    description: 'Create, edit, and manage agent skills and their lifecycle (active / stale / archived).',
    icon: BookOpen,
    category: 'capabilities',
    tier: 'basic',
    keywords: ['skill', 'skills', 'author', 'create', 'edit', 'manage', 'curator', 'lifecycle', 'stale', 'pin'],
    legacyAliases: ['skills-authoring', 'skill-curator'],
  },
  {
    id: 'prompt-templates',
    label: 'Commands',
    description: 'Reusable prompt templates and custom commands.',
    icon: FileText,
    category: 'capabilities',
    tier: 'basic',
    keywords: ['commands', 'prompt templates', 'templates', 'template', 'reusable', 'variable', 'shortcut'],
    legacyAliases: ['prompt-templates', 'custom-commands'],
  },
  {
    id: 'hooks',
    label: 'Hooks',
    description: 'Turn hooks, tool execution intercepts, and custom event listeners.',
    icon: ArrowRightLeft,
    category: 'capabilities',
    tier: 'basic',
    keywords: ['hooks', 'hook', 'tool intercepts', 'intercept', 'listeners'],
    legacyAliases: ['hooks-tab', 'event-hooks'],
  },
  {
    id: 'model-catalog',
    label: 'All Models',
    description: 'Every discovered model across providers — context windows, capabilities, and per-model editing.',
    icon: Network,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['all models', 'discover', 'context window', 'capability'],
    legacyAliases: ['all-models'],
  },
  {
    id: 'model-fleet',
    label: 'Model Fleet',
    description: 'Cognitive role assignments — cortex, cerebellum, hippocampus, and prefrontal models.',
    icon: Bot,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['fleet', 'cortex', 'cerebellum', 'hippocampus', 'prefrontal'],
    legacyAliases: ['fleet-tab'],
  },
  {
    id: 'model-reflection',
    label: 'Background Review & Reflection',
    description: 'Background models for titles, memory extraction, and self-reflection critics.',
    icon: Lightbulb,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['background', 'reflection', 'critic'],
    legacyAliases: ['reflection-tab'],
  },
  {
    id: 'model-live',
    label: 'Live (STT/TTS)',
    description: 'Speech-to-text and text-to-speech engines for live voice sessions.',
    icon: AudioLines,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['stt', 'tts', 'speech', 'voice', 'microphone'],
    legacyAliases: ['live-tab'],
  },
  {
    id: 'model-aliases',
    label: 'Aliases',
    description: 'User-defined model aliases routed to a real provider + model pair.',
    icon: Route,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['aliases', 'alias routing', 'rename model'],
    legacyAliases: ['aliases-tab'],
  },
  {
    id: 'model-fallback',
    label: 'Fallback',
    description: 'Automatic failover chains when a provider errors or rate-limits mid-turn.',
    icon: GitBranch,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['fallback', 'failover', 'chain'],
    legacyAliases: ['fallback-tab'],
  },
  {
    id: 'model-quotas',
    label: 'Quotas',
    description: 'Daily token limits and per-provider spend ceilings.',
    icon: Coins,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['token limit', 'spend ceiling', 'daily limit'],
    legacyAliases: ['quotas-tab'],
  },
  {
    id: 'memory-facts',
    label: 'Facts & Rules',
    description: 'Structured facts August extracted and behavioral rules it learned.',
    icon: FolderOpen,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['facts', 'heuristics', 'rules', 'learned', 'semantic', 'knowledge'],
    legacyAliases: ['semantic-facts'],
  },
  {
    id: 'recurring-tasks',
    label: 'Reminders',
    description:
      'Recurring-task daemon — time- and workspace-based reminders fired into the notification surface.',
    icon: Bell,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['reminder', 'reminders', 'recurring', 'task', 'every', 'when i open', 'daemon'],
  },
  {
    id: 'agents-automation',
    label: 'Automations',
    description: 'Agent registry, permissions, automations, and approvals.',
    icon: Kanban,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['agent', 'automation', 'permission', 'scope', 'approval', 'terminal', 'schedule', 'job'],
    legacyAliases: ['agents', 'agent-permissions', 'automations', 'terminal'],
  },
  {
    id: 'agent-board',
    label: 'Agent Board',
    description: 'Durable kanban board for multi-agent work across sessions.',
    icon: Flame,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['board', 'cards'],
    legacyAliases: ['kanban'],
  },
  {
    id: 'agent-sandbox',
    label: 'Files & Shell Access',
    description:
      'Sandbox reach, always-here path grants, and the safe Python cell — one access page.',
    icon: Shield,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['sandbox', 'seatbelt', 'landlock', 'appcontainer', 'isolation', 'workspace-write', 'reach'],
    legacyAliases: ['codex-sandbox', 'agent-sandbox'],
  },
  {
    id: 'tool-grants',
    label: 'Path Permissions',
    description: 'Always-here tool grants by workspace path — list, explain, revoke.',
    icon: FolderLock,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['grant', 'always', 'path-permission', 'revoke', 'allowlist-path'],
    legacyAliases: ['always-grants', 'path-grants'],
  },
  {
    id: 'python-sandbox',
    label: 'Python Sandbox',
    description: 'Safe Python cell with no network, banned imports, and timeout.',
    icon: Code2,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['python', 'cell', 'exec'],
    legacyAliases: ['sandbox'],
  },
  {
    id: 'computer-access',
    label: 'Desktop App Permissions',
    description: 'Filesystem scope, allowed roots, and computer-use app allowlist.',
    icon: CheckCircle2,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['roots', 'security', 'allowlist', 'computer-use-scope'],
  },
  {
    id: 'api-access',
    label: 'External API Access',
    description: 'Open or close the proxy gateway for external clients, manage the API key.',
    icon: Radio,
    category: 'capabilities',
    tier: 'hidden',
    keywords: ['api', 'access', 'gateway', 'key', 'external', 'client', 'curl', 'openai', 'anthropic', 'bearer', 'sdk', 'endpoint'],
  },

  /* ── Data and statistics header ────────────────────────────────── */
  {
    id: 'indexing',
    label: 'Indexing',
    description: 'Workspace codebase indexing, vector search, and semantic knowledge cache.',
    icon: ShieldCheck,
    category: 'data',
    tier: 'basic',
    keywords: ['indexing', 'indexer', 'codebase index', 'vector search', 'semantic cache'],
    legacyAliases: ['index', 'workspace-index', 'vector-index'],
  },
  {
    id: 'usage',
    label: 'Usage stats',
    description: 'Token usage, model cost, quotas, and per-model consumption.',
    icon: Gauge,
    category: 'data',
    tier: 'basic',
    keywords: ['usage stats', 'limits', 'spend', 'quotas', 'tokens', 'usage-limits', 'statistics', 'streak'],
    legacyAliases: ['usage-limits'],
  },
  {
    id: 'observability',
    label: 'Activity Log',
    description: 'Audit log, rollback history, post-observation screenshots, traffic, and logs.',
    icon: LineChart,
    category: 'data',
    tier: 'hidden',
    keywords: ['audit', 'rollback', 'observation', 'compliance', 'undo', 'traffic', 'log', 'activity'],
    legacyAliases: ['traffic-activity', 'overview', 'logs', 'traffic', 'activity', 'audit', 'rollback', 'observations'],
  },
  {
    id: 'conversations-history',
    label: 'Conversations',
    description: 'Archived chat sessions and per-conversation history.',
    icon: MessagesSquare,
    category: 'data',
    tier: 'hidden',
    keywords: ['conversation', 'history', 'archive', 'session', 'chat'],
    legacyAliases: ['archive', 'conversations', 'chat-history', 'session-history'],
  },
  {
    id: 'conversation-inspector',
    label: 'Request Inspector',
    description: 'Readable transcript, raw request/response bodies, and assistant thinking.',
    icon: SearchIcon,
    category: 'data',
    tier: 'hidden',
    keywords: ['inspector', 'request', 'response', 'body', 'thinking', 'trace', 'finish reason', 'error'],
    legacyAliases: ['inspector', 'conversation', 'thinking'],
  },
  {
    id: 'feature-flow',
    label: 'Feature Flow',
    description: 'Animated live pipeline of backend feature execution with inventory directory.',
    icon: Sparkles,
    category: 'data',
    tier: 'hidden',
    keywords: ['feature', 'flow', 'pipeline', 'animation', 'inventory', 'sse', 'execution'],
    legacyAliases: ['feature-flow-viz', 'execution-visualizer'],
  },
  {
    id: 'harness-improve',
    label: 'Harness Improvements',
    description: 'Improvement proposals the model filed against its own harness — review, approve, or reject.',
    icon: HeartPulse,
    category: 'data',
    tier: 'hidden',
    keywords: ['harness', 'proposal', 'self-improvement', 'introspect', 'review queue', 'approve'],
    legacyAliases: ['reliability', 'harness-proposals'],
  },
  {
    id: 'backend-monitor',
    label: 'Backend Monitor',
    description: 'Real-time stream of proxy, memory, scheduler, and tool events.',
    icon: Stethoscope,
    category: 'data',
    tier: 'hidden',
    keywords: ['events', 'monitor', 'websocket', 'proxy', 'scheduler'],
  },
  {
    id: 'health-simulator',
    label: 'Provider Health Simulator',
    description: 'Preflight a provider + model: connectivity, tool support, and fallback route before relying on it.',
    icon: Zap,
    category: 'data',
    tier: 'hidden',
    keywords: ['simulate', 'simulator', 'probe', 'preflight', 'diagnose', 'tool support', 'fallback route'],
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

/** Hidden split-views that still have ids for deep links. The rail
 *  highlights the parent hub instead of listing each as its own tab. */
const RAIL_PARENT: Readonly<Record<string, string>> = {
  'recalled-memory': 'memory-knowledge',
  'added-memory': 'memory-knowledge',
  'project-memories': 'memory-knowledge',
  'ui-designer': 'appearance',
  'tool-grants': 'agent-sandbox',
  'python-sandbox': 'agent-sandbox',
  'backend-monitor': 'observability',
  'health-simulator': 'system-health',
};

/** Visible tree children: section id → child section ids rendered as
 *  indented sub-items under the parent in the rail tree (2026-08-28:
 *  UI Designer moved under Appearance per the UI enhancement request). */
export const RAIL_CHILDREN: Readonly<Record<string, readonly string[]>> = {
  appearance: ['ui-designer'],
};

/** Section id the left rail should mark active. */
export function railCanonicalId(id: string): string {
  return RAIL_PARENT[id] ?? id;
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

    if (s.tier !== 'basic' && s.tier !== 'advanced' && s.tier !== 'hidden') {
      throw new Error(
        `settings-registry: section "${s.id}" has invalid tier "${String(s.tier)}" — must be "basic", "advanced", or "hidden"`,
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
