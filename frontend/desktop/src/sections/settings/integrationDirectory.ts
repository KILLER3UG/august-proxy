/* ── Integration directory catalog ─────────────────────────────────── */
/* Browseable list of things the user can add to August.
 * Account facets (Gmail vs Calendar vs Drive) are separate so users
 * only enable what they need. MCP extensions install as real servers.
 *
 * HONESTY CONTRACT — this list is a set of SIGN-IN SLOTS and INSTALL
 * RECIPES, not a capability registry. August ships no built-in Gmail,
 * Calendar, Drive, GitHub or Slack tools, so an entry here never means
 * "the agent can now do this". Every entry says which of the three it
 * is (`capability`), states in words what the user does and does not
 * get (`capabilityNote`), and — for a recipe — names the tools the
 * THIRD-PARTY server exposes once it is running. */

export type CatalogBrand =
  | 'google'
  | 'github'
  | 'slack'
  | 'filesystem'
  | 'memory'
  | 'browser'
  | 'generic';

export type CatalogKind = 'account-facet' | 'mcp-extension';

/**
 * What a catalog entry actually gives the user today.
 *
 * The catalog is a set of SIGN-IN SLOTS and INSTALL RECIPES, not a
 * capability registry. August has no built-in Gmail, Calendar, Drive,
 * GitHub or Slack tools, so an entry that connects an account is NOT the
 * same thing as an entry that gives the agent something to do. Every
 * entry states which of the three it is.
 */
export type CatalogCapability =
  /** August has its own tools for this — the agent can act on it. */
  | 'capability'
  /** Connecting only stores a credential. No August tool calls the API. */
  | 'sign-in'
  /**
   * A third-party MCP server August can launch. Its tools exist only
   * while that server is running, and they are the SERVER's tools, not
   * August's.
   */
  | 'recipe';

/** Short human label for an entry's capability — shown in words, not just a badge. */
const CAPABILITY_LABELS: Record<CatalogCapability, string> = {
  capability: 'Capability',
  'sign-in': 'Sign-in only',
  recipe: 'Install recipe',
};

export function catalogCapabilityLabel(capability: CatalogCapability): string {
  return CAPABILITY_LABELS[capability];
}

/** Env field collected in the install modal before registering an MCP server. */
export interface CatalogEnvField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** Default value pre-filled in the install form (not secrets). */
  defaultValue?: string;
}

export interface IntegrationCatalogEntry {
  id: string;
  kind: CatalogKind;
  name: string;
  tagline: string;
  description: string;
  developer: string;
  categories: string[];
  brand: CatalogBrand;
  verified?: boolean;
  isNew?: boolean;
  isCommunity?: boolean;
  /** Account provider this facet uses for auth (shared OAuth/token). */
  accountProvider?: 'google' | 'github' | 'slack';
  /** Optional package metadata for MCP extensions. */
  packageName?: string;
  packageVersion?: string;
  /** What this entry gives the user today — see CatalogCapability. */
  capability: CatalogCapability;
  /**
   * One plain sentence saying what the user gets — and what they do NOT
   * get. Rendered in full on the card and the detail page, so the real
   * state is never carried by a badge alone.
   */
  capabilityNote: string;
  /**
   * Tool names, when the entry has any.
   *
   * For `recipe` entries these are the tools the THIRD-PARTY MCP server
   * exposes once it is installed and running — they are not August tools
   * and they do not exist before the server starts. An entry that exposes
   * no tools of its own omits the field entirely.
   */
  tools?: string[];
  /** MCP install recipe (stdio). */
  mcp?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    transport?: 'stdio' | 'http' | 'sse';
  };
  /**
   * When set, the Install button collects these values and merges them into
   * the MCP server env + global MCP env (so Sign in with Google can work).
   */
  requiredEnv?: CatalogEnvField[];
  helpUrl?: string;
  requirements?: string;
}

/** Durable list of catalog ids the user has added (account facets + MCP). */
export const ENABLED_INTEGRATIONS_KEY = 'august-enabled-integrations-v1';

export function loadEnabledIntegrationIds(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(ENABLED_INTEGRATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveEnabledIntegrationIds(ids: string[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(ENABLED_INTEGRATIONS_KEY, JSON.stringify([...new Set(ids)]));
}

export function enableIntegrationId(id: string): string[] {
  const next = [...new Set([...loadEnabledIntegrationIds(), id])];
  saveEnabledIntegrationIds(next);
  return next;
}

export function disableIntegrationId(id: string): string[] {
  const next = loadEnabledIntegrationIds().filter((x) => x !== id);
  saveEnabledIntegrationIds(next);
  return next;
}

/**
 * Full directory — what appears in the Add Integrations modal.
 * Google is split so calendar/email/drive can be added independently.
 *
 * NOTE the absence of `tools:` on every account facet below. Those
 * arrays used to name Gmail / Calendar / Drive / GitHub / Slack tools in
 * a dotted `service.action` shape — none of which was ever a registered
 * August tool (the only Google entry point is `connect_google`, which
 * stores a token). They were display metadata for a capability that does
 * not exist, and a user reading them reasonably concluded that mail
 * worked.
 */
export const INTEGRATION_DIRECTORY: readonly IntegrationCatalogEntry[] = [
  {
    id: 'google-gmail',
    kind: 'account-facet',
    name: 'Gmail',
    tagline: 'Sign in to Gmail — August has no Gmail tools yet.',
    description:
      'Adds a Gmail slot to your integrations and starts Google sign-in (PKCE, browser consent), ' +
      'requesting only the Gmail scopes. The token is stored in August and refreshed for you.\n\n' +
      'What this does NOT give you: August exposes no built-in Gmail tool, so connecting this ' +
      'does not let the agent read, search or send mail. It is a working sign-in, not a capability.',
    developer: 'Google',
    categories: ['Email', 'Productivity'],
    brand: 'google',
    verified: true,
    accountProvider: 'google',
    capability: 'sign-in',
    capabilityNote:
      'Sign-in only. Stores a Gmail-scoped Google token — August exposes no Gmail tools, so nothing can read or send mail yet.',
    helpUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  {
    id: 'google-calendar',
    kind: 'account-facet',
    name: 'Google Calendar',
    tagline: 'Sign in to Google Calendar — August has no Calendar tools yet.',
    description:
      'Adds a Calendar slot and starts Google sign-in for the Calendar scope only, independent ' +
      'of Gmail. The token is stored in August and refreshed for you.\n\n' +
      'What this does NOT give you: August exposes no built-in Calendar tool, so connecting this ' +
      'does not let the agent check availability or create events. The calendar August shows ' +
      'today lists only its own automations and reminders.',
    developer: 'Google',
    categories: ['Calendar', 'Productivity'],
    brand: 'google',
    verified: true,
    accountProvider: 'google',
    capability: 'sign-in',
    capabilityNote:
      'Sign-in only. Stores a Calendar-scoped Google token — August exposes no Calendar tools, so nothing can list or create events yet.',
    helpUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  {
    id: 'google-drive',
    kind: 'account-facet',
    name: 'Google Drive',
    tagline: 'Sign in to Google Drive — August has no Drive tools yet.',
    description:
      'Adds a Drive slot and starts Google sign-in for the Drive scope only, separate from ' +
      'Gmail and Calendar so you can limit access. The token is stored in August and refreshed ' +
      'for you.\n\n' +
      'What this does NOT give you: August exposes no built-in Drive tool, so connecting this ' +
      'does not let the agent search or open files.',
    developer: 'Google',
    categories: ['Files', 'Productivity'],
    brand: 'google',
    verified: true,
    accountProvider: 'google',
    capability: 'sign-in',
    capabilityNote:
      'Sign-in only. Stores a Drive-scoped Google token — August exposes no Drive tools, so nothing can search or open files yet.',
    helpUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  {
    id: 'github',
    kind: 'account-facet',
    name: 'GitHub',
    tagline: 'Connect GitHub with a token — August has no GitHub tools yet.',
    description:
      'Stores a GitHub personal access token. August validates it against GitHub so you can see ' +
      'that it works and which account it belongs to.\n\n' +
      'What this does NOT give you: August exposes no built-in GitHub tool, so connecting this ' +
      'does not let the agent search code, read issues or PRs, or open reviews.',
    developer: 'GitHub',
    categories: ['Developer', 'Code'],
    brand: 'github',
    verified: true,
    accountProvider: 'github',
    capability: 'sign-in',
    capabilityNote:
      'Sign-in only. Stores a GitHub personal access token — August exposes no repository, issue or pull-request tools.',
    helpUrl: 'https://github.com/settings/tokens',
  },
  {
    id: 'slack',
    kind: 'account-facet',
    name: 'Slack',
    tagline: 'Connect Slack with a bot token — August has no Slack tools yet.',
    description:
      'Stores a Slack bot token. August validates it against Slack, and can send a single ' +
      'connectivity test message if you give it a channel.\n\n' +
      'What this does NOT give you: August exposes no built-in Slack tool, so connecting this ' +
      'does not let the agent read channels, post messages or react.',
    developer: 'Slack',
    categories: ['Chat', 'Productivity'],
    brand: 'slack',
    verified: true,
    accountProvider: 'slack',
    capability: 'sign-in',
    capabilityNote:
      'Sign-in only. Stores a Slack bot token — August exposes no channel, message or reaction tools.',
    helpUrl: 'https://api.slack.com/apps',
  },
  {
    id: 'mcp-filesystem',
    kind: 'mcp-extension',
    name: 'Filesystem',
    tagline: 'Let August access your filesystem to read and write files.',
    description:
      'This extension allows August to interact with your local filesystem, enabling it to read and write files directly. Useful for file management, data processing, and automation. Provides tools to navigate directories, read file contents, and write or modify files.\n\nUnder the hood it uses @modelcontextprotocol/server-filesystem. Only enable for trusted workspaces — the agent will be able to read and write under the configured path.',
    developer: 'Anthropic (MCP)',
    categories: ['Files', 'MCP', 'Local'],
    brand: 'filesystem',
    verified: true,
    isNew: true,
    packageName: '@modelcontextprotocol/server-filesystem',
    packageVersion: '2026.7.4',
    capability: 'recipe',
    capabilityNote:
      'Install recipe. Starts the official @modelcontextprotocol/server-filesystem server; its file tools reach the agent only while that server is running.',
    tools: [
      'read_file',
      'read_text_file',
      'read_media_file',
      'read_multiple_files',
      'write_file',
      'edit_file',
      'create_directory',
      'list_directory',
      'directory_tree',
      'move_file',
      'search_files',
      'get_file_info',
      'list_allowed_directories',
    ],
    mcp: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2026.7.4', '.'],
      transport: 'stdio',
    },
    requirements: 'Node.js + npx available on PATH. Restrict the path argument to a safe workspace.',
    helpUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem',
  },
  {
    id: 'mcp-memory',
    kind: 'mcp-extension',
    name: 'Knowledge Graph Memory',
    tagline: 'Persistent entity memory via MCP knowledge graph.',
    description:
      'Installs the official MCP memory server so August can store and recall entities and relations in a local knowledge graph.',
    developer: 'Anthropic (MCP)',
    categories: ['Memory', 'MCP'],
    brand: 'memory',
    verified: true,
    packageName: '@modelcontextprotocol/server-memory',
    packageVersion: 'latest',
    capability: 'recipe',
    capabilityNote:
      'Install recipe. Starts the official MCP memory server; its knowledge-graph tools reach the agent only while that server is running.',
    tools: ['create_entities', 'create_relations', 'add_observations', 'search_nodes', 'open_nodes', 'read_graph'],
    mcp: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      transport: 'stdio',
    },
    helpUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-memory',
  },
  {
    id: 'mcp-fetch',
    kind: 'mcp-extension',
    name: 'Fetch',
    tagline: 'HTTP fetch tool for web content.',
    description:
      'Installs the MCP fetch server so August can retrieve web pages as structured text for research and grounding.',
    developer: 'Anthropic (MCP)',
    categories: ['Web', 'MCP'],
    brand: 'browser',
    verified: true,
    isCommunity: false,
    packageName: '@modelcontextprotocol/server-fetch',
    packageVersion: 'latest',
    capability: 'recipe',
    capabilityNote:
      'Install recipe. Starts the official MCP fetch server; its fetch tool reaches the agent only while that server is running.',
    tools: ['fetch'],
    mcp: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
      transport: 'stdio',
    },
    helpUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-fetch',
  },
  {
    id: 'mcp-github',
    kind: 'mcp-extension',
    name: 'GitHub MCP',
    tagline: 'GitHub tools over MCP (repos, issues, PRs).',
    description:
      'Official GitHub MCP server for repository and issue workflows. Requires a GITHUB_PERSONAL_ACCESS_TOKEN in the server env.',
    developer: 'GitHub / MCP',
    categories: ['Developer', 'MCP', 'Code'],
    brand: 'github',
    verified: true,
    isCommunity: true,
    packageName: '@modelcontextprotocol/server-github',
    packageVersion: 'latest',
    capability: 'recipe',
    capabilityNote:
      'Install recipe. Starts the GitHub MCP server; its repository and issue tools reach the agent only while that server is running.',
    tools: ['create_or_update_file', 'search_repositories', 'create_issue', 'list_issues', 'create_pull_request'],
    mcp: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      transport: 'stdio',
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    },
    requirements: 'Set GITHUB_PERSONAL_ACCESS_TOKEN in the MCP server environment after install.',
    helpUrl: 'https://github.com/modelcontextprotocol/servers',
    requiredEnv: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub personal access token',
        secret: true,
        required: true,
        placeholder: 'ghp_…',
        help: 'Create a classic or fine-grained PAT with repo access.',
      },
    ],
  },
  {
    id: 'mcp-google-workspace',
    kind: 'mcp-extension',
    name: 'Google Workspace MCP',
    tagline: 'A third-party Google Workspace server (workspace-mcp) — needs uv/uvx on PATH.',
    description:
      'Installs workspace-mcp — a separate third-party program that August launches as a ' +
      'subprocess. It is NOT an August feature, and August ships none of these tools itself.\n\n' +
      'What this does NOT give you: August has no built-in Gmail, Calendar or Drive tools. ' +
      '"Sign in with Google" stores a Google token and adds no mail, calendar or file ' +
      'capability on its own. The Workspace tools exist only if this server is installed ' +
      'and running.\n\n' +
      'On this machine the recipe needs uv/uvx on PATH. If the launcher is missing, August ' +
      'cannot start the server and you get no tools from it — the Install button says so ' +
      'rather than pretending the recipe worked.',
    developer: 'workspace-mcp (taylorwilsdon)',
    categories: ['Email', 'Calendar', 'Files', 'MCP', 'Google'],
    brand: 'google',
    verified: true,
    isNew: true,
    packageName: 'workspace-mcp',
    packageVersion: 'latest',
    capability: 'recipe',
    capabilityNote:
      'Install recipe for a THIRD-PARTY server (workspace-mcp). It needs uv/uvx on PATH. August has no Gmail, Calendar or Drive tools of its own — anything you get comes from that server, and only while it runs.',
    tools: [
      // These are workspace-mcp's OWN tools, not August tools. They exist
      // only once the third-party server is installed and running — which
      // needs uv/uvx on PATH. Auth is native August OAuth (Settings →
      // Sign in with Google); start_google_auth only exists in
      // workspace-mcp --tool-tier complete.
      'search_gmail_messages',
      'get_gmail_message_content',
      'send_gmail_message',
      'list_calendars',
      'create_event',
      'search_drive_files',
    ],
    mcp: {
      command: 'uvx',
      args: ['workspace-mcp', '--tool-tier', 'core'],
      transport: 'stdio',
      env: {
        GOOGLE_OAUTH_CLIENT_ID: '',
        GOOGLE_OAUTH_CLIENT_SECRET: '',
        OAUTHLIB_INSECURE_TRANSPORT: '1',
      },
    },
    requiredEnv: [
      {
        key: 'GOOGLE_OAUTH_CLIENT_ID',
        label: 'Google OAuth client ID',
        required: true,
        placeholder: '….apps.googleusercontent.com',
        help: 'Prefer a Desktop app client. Secret not required when using August Sign in (PKCE).',
      },
      {
        key: 'GOOGLE_OAUTH_CLIENT_SECRET',
        label: 'Google OAuth client secret (optional for Desktop)',
        secret: true,
        required: false,
        placeholder: 'GOCSPX-… (only for Web/confidential clients)',
        help: 'Leave empty for Desktop + PKCE. Required only for Web application clients.',
      },
      {
        key: 'OAUTHLIB_INSECURE_TRANSPORT',
        label: 'Allow local HTTP OAuth (dev)',
        required: false,
        defaultValue: '1',
        help: 'Set to 1 so local http://127.0.0.1 callbacks work during development.',
      },
    ],
    requirements:
      'Python 3.10+ and uv/uvx on PATH — without uvx the server never starts and no tool arrives. ' +
      'Google Cloud Desktop OAuth client recommended (PKCE — Client ID only), used by August\'s own ' +
      'Sign in with Google. Redirect for August Sign in: ' +
      'http://127.0.0.1:8085/api/service-connections/google/callback',
    helpUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
  },
];

export function getCatalogEntry(id: string): IntegrationCatalogEntry | undefined {
  return INTEGRATION_DIRECTORY.find((e) => e.id === id);
}
