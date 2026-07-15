/* ── Integration directory catalog ─────────────────────────────────── */
/* Browseable list of things the user can add to August (not Claude).
 * Account facets (Gmail vs Calendar vs Drive) are separate so users
 * only enable what they need. MCP extensions install as real servers. */

export type CatalogBrand =
  | 'google'
  | 'github'
  | 'slack'
  | 'filesystem'
  | 'memory'
  | 'browser'
  | 'generic';

export type CatalogKind = 'account-facet' | 'mcp-extension';

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
 */
export const INTEGRATION_DIRECTORY: readonly IntegrationCatalogEntry[] = [
  {
    id: 'google-gmail',
    kind: 'account-facet',
    name: 'Gmail',
    tagline: 'Read and send email from Gmail.',
    description:
      'Connect Gmail so August can read threads, draft replies, and send mail with your permission. Uses your Google account sign-in; only enable Gmail if you need email tools.',
    developer: 'Google',
    categories: ['Email', 'Productivity'],
    brand: 'google',
    verified: true,
    accountProvider: 'google',
    tools: ['gmail.read', 'gmail.send', 'gmail.search'],
    helpUrl: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
  },
  {
    id: 'google-calendar',
    kind: 'account-facet',
    name: 'Google Calendar',
    tagline: 'Create and list calendar events.',
    description:
      'Connect Google Calendar so August can check availability and create events. Independent from Gmail — add only if you want calendar tools.',
    developer: 'Google',
    categories: ['Calendar', 'Productivity'],
    brand: 'google',
    verified: true,
    accountProvider: 'google',
    tools: ['calendar.list', 'calendar.create', 'calendar.update'],
    helpUrl: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
  },
  {
    id: 'google-drive',
    kind: 'account-facet',
    name: 'Google Drive',
    tagline: 'Search and open files in Drive.',
    description:
      'Connect Drive so August can search files and open Docs/Sheets links. Separate from Gmail and Calendar so you can limit access.',
    developer: 'Google',
    categories: ['Files', 'Productivity'],
    brand: 'google',
    verified: true,
    accountProvider: 'google',
    tools: ['drive.search', 'drive.read_meta'],
    helpUrl: 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
  },
  {
    id: 'github',
    kind: 'account-facet',
    name: 'GitHub',
    tagline: 'Repositories, issues, pull requests, and code search.',
    description:
      'Connect GitHub with a personal access token so August can search code, read issues and PRs, and open reviews without leaving your session.',
    developer: 'GitHub',
    categories: ['Developer', 'Code'],
    brand: 'github',
    verified: true,
    accountProvider: 'github',
    tools: ['repos', 'issues', 'pull_requests', 'code_search'],
    helpUrl: 'https://github.com/settings/tokens',
  },
  {
    id: 'slack',
    kind: 'account-facet',
    name: 'Slack',
    tagline: 'Channels, messages, threads, and reactions.',
    description:
      'Connect Slack with a bot token so August can read channels, post messages, and react from inside the agent.',
    developer: 'Slack',
    categories: ['Chat', 'Productivity'],
    brand: 'slack',
    verified: true,
    accountProvider: 'slack',
    tools: ['channels.list', 'chat.post', 'reactions.add'],
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
    tagline: 'Gmail, Calendar, Drive, Docs, Sheets — sign in with Google in the browser.',
    description:
      'Installs workspace-mcp so August can use Gmail, Calendar, Drive, and other Google Workspace APIs.\n\n' +
      'After install: open Gmail / Calendar / Drive (or this card) and click Sign in with Google. ' +
      'Your browser opens Google consent — same pattern as Claude Desktop’s Google Workspace extension.\n\n' +
      'You need a free Google Cloud OAuth client (Client ID + Secret) once. Create a Desktop app or Web app ' +
      'and enable Gmail / Calendar / Drive APIs. Add yourself as a test user while the consent screen is in Testing.',
    developer: 'workspace-mcp (taylorwilsdon)',
    categories: ['Email', 'Calendar', 'Files', 'MCP', 'Google'],
    brand: 'google',
    verified: true,
    isNew: true,
    packageName: 'workspace-mcp',
    packageVersion: 'latest',
    tools: [
      'start_google_auth',
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
        help: 'Google Cloud Console → APIs & Services → Credentials → OAuth client ID',
      },
      {
        key: 'GOOGLE_OAUTH_CLIENT_SECRET',
        label: 'Google OAuth client secret',
        secret: true,
        required: true,
        placeholder: 'GOCSPX-…',
        help: 'From the same OAuth client. Required for confidential clients.',
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
      'Python 3.10+ and uv/uvx on PATH (https://github.com/astral-sh/uv). ' +
      'Google Cloud project with Gmail/Calendar/Drive APIs enabled and an OAuth client. ' +
      'For August’s built-in Sign in button, also add redirect URI: ' +
      'http://127.0.0.1:8085/api/service-connections/google/callback',
    helpUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
  },
];

export function getCatalogEntry(id: string): IntegrationCatalogEntry | undefined {
  return INTEGRATION_DIRECTORY.find((e) => e.id === id);
}
