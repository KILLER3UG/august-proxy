/* ── Mock data — drives every section when backend is unreachable ──── */
/* Sections prefer real API data; they fall back to these mocks so the UI
 * is always populated, even offline. Toggled by VITE_USE_MOCK env. */

export interface Provider {
  id: string;
  name: string;
  apiMode: string;
  isAvailable: boolean;
}

export interface RequestLog {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface Session {
  id: string;
  title: string;
  startedAt: string;
  messageCount: number;
  lastMessage: string;
  provider: string;
  model: string;
}

export interface MemoryEntry {
  id: string;
  type: 'fact' | 'preference' | 'event' | 'context';
  content: string;
  weight: number;
  createdAt: string;
  accessedAt: string;
}

export interface ThinkingStep {
  id: string;
  title: string;
  status: 'done' | 'active' | 'pending';
  detail: string;
  duration?: number;
  timestamp: string;
}

export interface ServiceConnection {
  name: 'google' | 'github' | 'slack' | 'notion' | 'linear' | 'figma';
  status: 'connected' | 'disconnected';
  account?: string;
  scopes: string[];
}

export const mockOverview = {
  requests: 12_847,
  activity: 8_421,
  inspector: 4_426,
  errors: 23,
  cost: { input: 1_245_823, output: 487_213, total: 12.84 },
  activeConfig: {
    provider: 'opencode-go',
    model: 'claude-opus-4-7',
    region: 'us-east-1',
    rateLimit: '60 rpm',
    maxTokens: 8192,
    temperature: 0.7,
    topP: 0.9,
    cacheEnabled: true,
    cacheTtlSeconds: 3600,
  },
};

export const mockHealth = {
  claude: { status: 'ok', latencyMs: 234, lastCheck: new Date().toISOString() },
  codex:  { status: 'ok', latencyMs: 412, lastCheck: new Date().toISOString() },
  uptime: 8_640,
  memory: { used: 412, total: 2048 },
  cpu: 0.18,
  disk: { used: 12_400, total: 100_000 },
};

export const mockProviders: Provider[] = [
  { id: 'opencode-go',      name: 'OpenCode Go',        apiMode: 'openai_chat',        isAvailable: true },
  { id: 'opencode-zen',     name: 'OpenCode Zen',       apiMode: 'openai_chat',        isAvailable: false },
  { id: 'kilo',             name: 'KiloCode',           apiMode: 'openai_chat',        isAvailable: true },
  { id: 'openrouter',       name: 'OpenRouter',         apiMode: 'openai_chat',        isAvailable: true },
  { id: 'minimax',          name: 'MiniMax (Global)',  apiMode: 'anthropic_messages',isAvailable: true },
  { id: 'minimax-cn',       name: 'MiniMax (China)',   apiMode: 'anthropic_messages',isAvailable: false },
  { id: 'anthropic',        name: 'Anthropic',          apiMode: 'anthropic_messages',isAvailable: false },
  { id: 'openai-api',       name: 'OpenAI API',         apiMode: 'codex_responses',    isAvailable: false },
  { id: 'deepseek',         name: 'DeepSeek',           apiMode: 'openai_chat',        isAvailable: false },
  { id: 'gemini',           name: 'Google AI Studio',   apiMode: 'openai_chat',        isAvailable: false },
  { id: 'xai',              name: 'xAI',                apiMode: 'codex_responses',    isAvailable: false },
  { id: 'copilot',          name: 'GitHub Copilot',     apiMode: 'openai_chat',        isAvailable: false },
  { id: 'bedrock',          name: 'AWS Bedrock',        apiMode: 'bedrock_converse',   isAvailable: false },
  { id: 'azure-foundry',    name: 'Azure AI Foundry',   apiMode: 'openai_chat',        isAvailable: false },
  { id: 'huggingface',      name: 'Hugging Face',       apiMode: 'openai_chat',        isAvailable: false },
  { id: 'novita',           name: 'Novita AI',          apiMode: 'openai_chat',        isAvailable: false },
  { id: 'cline',            name: 'Cline AI',           apiMode: 'openai_chat',        isAvailable: true },
  { id: 'custom',           name: 'Custom (OpenAI-compat)', apiMode: 'openai_chat',    isAvailable: false },
  { id: 'nvidia',           name: 'NVIDIA NIM',         apiMode: 'openai_chat',        isAvailable: true },
  { id: 'nvidia-nim',       name: 'NVIDIA NIM (alt)',   apiMode: 'openai_chat',        isAvailable: true },
  { id: 'openrouter-2',     name: 'OpenRouter (alt)',   apiMode: 'openai_chat',        isAvailable: true },
  { id: 'minimax-2',        name: 'minimax (alt)',      apiMode: 'openai_chat',        isAvailable: true },
  { id: 'opencode-2',        name: 'opencode (alt)',     apiMode: 'openai_chat',        isAvailable: true },
  { id: 'tokenrouter',       name: 'Token Router',       apiMode: 'openai_chat',        isAvailable: true },
];

function makeRequests(): RequestLog[] {
  const arr: RequestLog[] = [];
  const methods = ['POST', 'POST', 'POST', 'GET', 'POST', 'POST'];
  const paths = ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/models', '/v1/embeddings'];
  const providers = ['opencode-go', 'minimax', 'kilo', 'openrouter', 'cline'];
  const models = ['claude-opus-4-7', 'gpt-5', 'kilo/kimi-k2', 'anthropic/claude-sonnet-4', 'claude-haiku-4-5'];
  for (let i = 0; i < 120; i++) {
    const status = i % 23 === 0 ? 500 : i % 47 === 0 ? 429 : 200;
    const method = i === 0 ? 'GET' : methods[i % methods.length];
    arr.push({
      id: `req_${(12345 + i).toString(36)}`,
      timestamp: new Date(Date.now() - i * 7_000).toISOString(),
      method,
      path: paths[i % paths.length],
      status,
      durationMs: 200 + Math.floor(Math.random() * 1800),
      provider: providers[i % providers.length],
      model: models[i % models.length],
      inputTokens: 100 + Math.floor(Math.random() * 4000),
      outputTokens: 50 + Math.floor(Math.random() * 2000),
      cost: Number((Math.random() * 0.42).toFixed(4)),
    });
  }
  return arr;
}
export const mockRequests: RequestLog[] = makeRequests();

function makeSessions(): Session[] {
  const arr: Session[] = [];
  const titles = ['Refactor the dashboard nav', 'Add providers page', 'Fix URL routing bug', 'Tauri tray icon', 'Memory graph query', 'Embed xterm in Workbench', 'Ship the desktop MSI', 'Onboarding flow', 'Add cmdk palette', 'Wire up statusbar', 'Fix rerenderCostSummary', 'Refactor to React 19'];
  const last = ['Done — committed on refactor/ui-v2.', 'Looking at the inspector now.', 'Pushed. Need review.', 'Will continue tomorrow.'];
  const providers = ['opencode-go', 'minimax', 'kilo', 'openrouter'];
  const models = ['claude-opus-4-7', 'gpt-5', 'kilo/kimi-k2', 'anthropic/claude-sonnet-4'];
  for (let i = 0; i < 24; i++) {
    arr.push({
      id: `sess_${i.toString(36)}_${(9876 + i).toString(36)}`,
      title: titles[i % 12],
      startedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
      messageCount: 4 + (i * 3) % 80,
      lastMessage: last[i % 4],
      provider: providers[i % 4],
      model: models[i % 4],
    });
  }
  return arr;
}
export const mockSessions: Session[] = makeSessions();

function makeMemory(): MemoryEntry[] {
  const arr: MemoryEntry[] = [];
  const content = [
    'User prefers dark mode in all UIs by default',
    'August Proxy is a Node.js AI gateway running on port 8085',
    'Project uses Tauri 2 for the desktop build',
    'User refactored the dashboard from vanilla JS to React 19 in June 2026',
    'Active model: claude-opus-4-7 (changed from gpt-5 last week)',
    'User dislikes numbered nav badges in sidebars',
    'User prefers concise responses without bullet fluff',
    'Design language follows Hermes Desktop (shadcn new-york, three-pane shell)',
    'Tailscale magic DNS resolves *.august.local to the dev box',
    'User wants the Providers tab to actually work (bug fixed in 4b65b7e)',
    'Claude API key is in ~/.env as MINIMAX_API_KEY',
    'MCP server workspace-mcp handles Google/GitHub/Slack integration',
    'Right rail pattern: per-section details pane (planned but not built yet)',
    'User runs Windows 11 with git-bash; PowerShell is not the default',
    'Tailscale is used for cross-device access to the proxy',
    'User wants Tauri 2 (not Electron) for the desktop build',
    'Cline is the only working non-Claude provider in this env',
  ];
  const types: MemoryEntry['type'][] = ['fact', 'preference', 'event', 'context'];
  for (let i = 0; i < 18; i++) {
    arr.push({
      id: `mem_${i.toString(36)}`,
      type: types[i % 4],
      content: content[i],
      weight: 0.4 + (i % 5) * 0.12,
      createdAt: new Date(Date.now() - i * 86_400_000).toISOString(),
      accessedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
    });
  }
  return arr;
}
export const mockMemory: MemoryEntry[] = makeMemory();

export const mockThinking: ThinkingStep[] = [
  { id: 't1', title: 'Understand the request',          status: 'done',   duration: 1240, timestamp: new Date(Date.now() - 18000).toISOString(), detail: 'Parsed user intent: refactor the localhost UI to React 19 + Tauri 2.' },
  { id: 't2', title: 'Inspect current codebase',        status: 'done',   duration: 3400, timestamp: new Date(Date.now() - 17000).toISOString(), detail: 'Listed 12 sections, found 13 nav items, identified rerenderCostSummary bug in Overview.' },
  { id: 't3', title: 'Diagnose Providers tab',         status: 'done',   duration: 2100, timestamp: new Date(Date.now() - 14000).toISOString(), detail: 'Found loadProviderList is hoisted into wrong scope; init.js swallows the ReferenceError silently.' },
  { id: 't4', title: 'Plan the refactor',              status: 'done',   duration: 5800, timestamp: new Date(Date.now() - 12000).toISOString(), detail: 'Phase 0 bugfix → Phase 1 foundation → Phase 2 components → Phase 3 shell → Phase 4 sections → Phase 5 backend → Phase 6 Tauri → Phase 7 cutover.' },
  { id: 't5', title: 'Fix URL routing',                status: 'done',   duration:  420, timestamp: new Date(Date.now() -  6000).toISOString(), detail: 'Changed req.url === "/" to use URL.pathname in index.js.' },
  { id: 't6', title: 'Fix Providers tab',              status: 'done',   duration:  680, timestamp: new Date(Date.now() -  5500).toISOString(), detail: 'Explicit window.loadProviderList assignment + typeof guards in init.js.' },
  { id: 't7', title: 'Scaffold Vite + React 19 + TS',  status: 'active', duration:  320, timestamp: new Date(Date.now() -  4800).toISOString(), detail: 'Building the foundation: package.json, vite.config.ts, tsconfig, styles.css, utils, api client.' },
  { id: 't8', title: 'Build shadcn component library', status: 'pending',                timestamp: new Date(Date.now() -  3000).toISOString(), detail: 'Button, Card, Input, Badge, Spinner, Skeleton, Separator, StatusDot, StatusPill.' },
  { id: 't9', title: 'Build AppShell + CommandPalette',status: 'pending',                timestamp: new Date(Date.now() -  2000).toISOString(), detail: 'Three-pane shell, sidebar, titlebar, statusbar, cmdk palette, gateway state machine.' },
  { id: 't10',title: 'Migrate sections one by one',   status: 'pending',                timestamp: new Date(Date.now() -  1000).toISOString(), detail: 'Overview → Health → Providers → Workbench → Services → Traffic → Conversations → Inspector → Thinking → Memory → MCP → August.' },
];

export const mockServices: ServiceConnection[] = [
  { name: 'google', status: 'connected', account: 'robertacepayales69@gmail.com', scopes: ['gmail.read', 'gmail.send', 'calendar', 'drive', 'docs', 'sheets', 'slides', 'tasks', 'contacts'] },
  { name: 'github', status: 'connected', account: 'rober-cepayales',                scopes: ['repo', 'read:user', 'workflow', 'gist'] },
  { name: 'slack',  status: 'disconnected',                                              scopes: [] },
  { name: 'notion', status: 'disconnected',                                              scopes: [] },
  { name: 'linear', status: 'disconnected',                                              scopes: [] },
  { name: 'figma',  status: 'disconnected',                                              scopes: [] },
];

export const mockChatThread = [
  { id: 'm1', role: 'user'      as const, content: 'Refactor the localhost UI to React 19 + Tauri 2.',                  timestamp: new Date(Date.now() - 120_000).toISOString() },
  { id: 'm2', role: 'assistant' as const, content: 'Got it. Reading the current code now and planning the refactor.',  timestamp: new Date(Date.now() - 110_000).toISOString() },
  { id: 'm3', role: 'assistant' as const, content: "I found 12 sections, vanilla JS + server-rendered HTML, no build step. The Providers tab has a loadProviderList hoisting bug. I'll fix the bug first, then plan the React refactor.", timestamp: new Date(Date.now() -  90_000).toISOString() },
  { id: 'm4', role: 'user'      as const, content: 'Make sure the UI matches Hermes Desktop aesthetic.',                timestamp: new Date(Date.now() -  60_000).toISOString() },
  { id: 'm5', role: 'assistant' as const, content: 'Will use shadcn new-york, three-pane shell, command palette (cmdk), gateway state machine for proxy health. Source of truth: ~/.hermes/plans/2026-06-06_071200-august-proxy-ui-v2.md.', timestamp: new Date(Date.now() -  30_000).toISOString() },
];
