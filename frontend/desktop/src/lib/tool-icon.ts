/* ── Tool-icon utility ─ brand-aware tool / command / event icons ── */
/* Single source of truth for tool, command, and event-type icons used  */
/* by DisclosureRow, ToolCallItem, and anywhere else that renders an      */
/* agent action (Thought, Explored, Edited, Ran, …).                      */
/*                                                                       */
/* Coverage:                                                              */
/*   • 7 event types (matches the reference design)                      */
/*   • 14 generic tool categories                                         */
/*   • 60+ brand-specific tools/CLIs/services                             */
/*   • Compound-command + wrapper-stripping parser                        */
/*                                                                       */
/* Brand logos come from react-icons/si (Simple Icons, CC0). No-brand    */
/* formats fall back to themed lucide-react icons.                        */

import type { ComponentType, SVGProps } from 'react';
import {
  // Lucide — semantic + event-type icons
  Brain, Search, Pencil, SquareTerminal, Loader2, ListTodo, Sparkles,
  FileSearch, FilePlus, FilePen, Wrench, Package, Globe, Plug,
} from 'lucide-react';
import {
  // Simple Icons — brand tools (most-common subset)
  SiGit, SiGithub, SiGitlab, SiDocker,
  SiNpm, SiPnpm, SiYarn, SiBun, SiNodedotjs, SiDeno,
  SiTypescript, SiVite, SiWebpack, SiTauri, SiRollupdotjs,
  SiRust, SiGo, SiPython, SiGnubash, SiPowers, SiZsh,
  SiGooglechrome, SiFirefox,
  SiEslint, SiPrettier, SiJest, SiVitest, SiCypress,
  SiPostman, SiGraphql,
  SiKubernetes, SiTerraform, SiAnsible,
  SiGooglecloud, SiCloudflare,
  SiRedis, SiPostgresql, SiMysql, SiMongodb, SiSqlite, SiElasticsearch,
  SiFirebase, SiSupabase,
  SiOpenai, SiHuggingface,
  SiPytorch, SiTensorflow,
  SiFfmpeg,
} from 'react-icons/si';
import {
  // Lucide fallbacks for brands that have no Simple Icons export
  Cloud, Drama, Network,
} from 'lucide-react';

type IconComp = ComponentType<{ size?: number; color?: string } & SVGProps<SVGSVGElement>>;

export type ToolKind =
  // Event types (mirror the reference's per-row glyphs)
  | 'thought' | 'explored' | 'edited' | 'ran' | 'exploring' | 'todo' | 'thinking'
  // Generic tool categories
  | 'read' | 'write' | 'edit' | 'bash' | 'search' | 'fetch'
  | 'git' | 'docker' | 'package-manager' | 'browser' | 'api'
  // Brand-specific tools
  | 'npm' | 'pnpm' | 'yarn' | 'bun' | 'npx' | 'node' | 'deno'
  | 'tsc' | 'vite' | 'webpack' | 'rollup' | 'tauri' | 'swc'
  | 'cargo' | 'rust' | 'go' | 'python' | 'pip' | 'uv'
  | 'gh' | 'gitlab-cli' | 'docker-tool' | 'kubectl' | 'terraform' | 'ansible'
  | 'curl' | 'wget'
  | 'bash-sh' | 'zsh' | 'powershell'
  | 'eslint' | 'prettier' | 'jest' | 'vitest' | 'cypress' | 'playwright'
  | 'chrome' | 'firefox' | 'postman' | 'graphql-client'
  | 'aws' | 'gcp' | 'azure' | 'cloudflare'
  | 'redis' | 'postgres' | 'mysql' | 'mongodb' | 'sqlite' | 'elasticsearch'
  | 'firebase' | 'supabase'
  | 'openai' | 'huggingface'
  | 'pytorch' | 'tensorflow'
  | 'ffmpeg'
  // Fallback
  | 'tool-unknown' | 'command-unknown';

export interface ToolIcon {
  Icon: IconComp;
  color: string;
  kind: ToolKind;
  isAnimated: boolean;  // true for spinners
}

const ICONS: Record<ToolKind, { Icon: IconComp; color: string; isAnimated?: boolean }> = {
  // Event types
  thought:    { Icon: Brain,           color: '#a78bfa' },
  explored:   { Icon: Search,          color: '#94a3b8' },
  edited:     { Icon: Pencil,          color: '#e0b84e' },
  ran:        { Icon: SquareTerminal,  color: '#5a8a6a' },
  exploring:  { Icon: Loader2,         color: '#4a8fff', isAnimated: true },
  todo:       { Icon: ListTodo,        color: '#94a3b8' },
  thinking:   { Icon: Sparkles,        color: '#4a8fff', isAnimated: true },

  // Generic categories
  read:       { Icon: FileSearch,      color: '#94a3b8' },
  write:      { Icon: FilePlus,        color: '#4ade80' },
  edit:       { Icon: FilePen,         color: '#e0b84e' },
  bash:       { Icon: SquareTerminal,  color: '#5a8a6a' },
  search:     { Icon: Search,          color: '#4a8fff' },
  fetch:      { Icon: Globe,           color: '#4a8fff' },
  git:        { Icon: SiGit,           color: '#f05032' },
  docker:     { Icon: SiDocker,        color: '#384d54' },
  'package-manager': { Icon: Package, color: '#cb3837' },
  browser:    { Icon: SiGooglechrome,  color: '#4285f4' },
  api:        { Icon: Plug,            color: '#4a8fff' },

  // Brand-specific
  npm:        { Icon: SiNpm,           color: '#cb3837' },
  npx:        { Icon: SiNpm,           color: '#cb3837' },
  pnpm:       { Icon: SiPnpm,          color: '#f69220' },
  yarn:       { Icon: SiYarn,          color: '#2c8ebb' },
  bun:        { Icon: SiBun,           color: '#fbf0df' },
  node:       { Icon: SiNodedotjs,     color: '#5fa04e' },
  deno:       { Icon: SiDeno,          color: '#000000' },
  tsc:        { Icon: SiTypescript,    color: '#3178c6' },
  vite:       { Icon: SiVite,          color: '#646cff' },
  webpack:    { Icon: SiWebpack,       color: '#8dd6f9' },
  rollup:     { Icon: SiRollupdotjs,   color: '#df3333' },
  tauri:      { Icon: SiTauri,         color: '#ffc131' },
  swc:        { Icon: SiRust,          color: '#dea584' },
  cargo:      { Icon: SiRust,          color: '#dea584' },
  rust:       { Icon: SiRust,          color: '#dea584' },
  go:         { Icon: SiGo,            color: '#00add8' },
  python:     { Icon: SiPython,        color: '#3776ab' },
  pip:        { Icon: SiPython,        color: '#3776ab' },
  uv:         { Icon: SiPython,        color: '#3776ab' },
  gh:         { Icon: SiGithub,        color: '#181717' },
  'gitlab-cli': { Icon: SiGitlab,      color: '#fc6d26' },
  'docker-tool': { Icon: SiDocker,     color: '#384d54' },
  kubectl:    { Icon: SiKubernetes,    color: '#326ce5' },
  terraform:  { Icon: SiTerraform,     color: '#7b42bc' },
  ansible:    { Icon: SiAnsible,       color: '#1a1918' },
  curl:       { Icon: Globe,           color: '#4a8fff' },
  wget:       { Icon: Globe,           color: '#4a8fff' },
  'bash-sh':  { Icon: SquareTerminal,  color: '#5a8a6a' },
  zsh:        { Icon: SiZsh,           color: '#f15a29' },
  powershell: { Icon: SiPowers,        color: '#012456' },

  // Dev tooling
  eslint:     { Icon: SiEslint,        color: '#4b32c3' },
  prettier:   { Icon: SiPrettier,      color: '#f7b93e' },
  jest:       { Icon: SiJest,          color: '#99425b' },
  vitest:     { Icon: SiVitest,        color: '#6e9f18' },
  cypress:    { Icon: SiCypress,       color: '#17202c' },
  playwright:    { Icon: Drama,           color: '#2ead33' },

  // Network / API
  chrome:     { Icon: SiGooglechrome,  color: '#4285f4' },
  firefox:    { Icon: SiFirefox,       color: '#ff7139' },
  postman:    { Icon: SiPostman,       color: '#ff6c37' },
  'graphql-client': { Icon: SiGraphql, color: '#e10098' },

  // Cloud
  aws:        { Icon: Cloud,           color: '#ff9900' },
  gcp:        { Icon: SiGooglecloud,   color: '#4285f4' },
  azure:      { Icon: Cloud,           color: '#0078d4' },
  cloudflare: { Icon: SiCloudflare,    color: '#f38020' },

  // Data
  redis:      { Icon: SiRedis,         color: '#dc382d' },
  postgres:   { Icon: SiPostgresql,    color: '#4169e1' },
  mysql:      { Icon: SiMysql,         color: '#4479a1' },
  mongodb:    { Icon: SiMongodb,       color: '#47a248' },
  sqlite:     { Icon: SiSqlite,        color: '#003b57' },
  elasticsearch: { Icon: SiElasticsearch, color: '#005571' },
  firebase:   { Icon: SiFirebase,      color: '#ffca28' },
  supabase:   { Icon: SiSupabase,      color: '#3ecf8e' },

  // AI / ML
  openai:     { Icon: SiOpenai,        color: '#10a37f' },
  huggingface: { Icon: SiHuggingface,  color: '#ff9a00' },
  pytorch:    { Icon: SiPytorch,       color: '#ee4c2c' },
  tensorflow: { Icon: SiTensorflow,    color: '#ff6f00' },

  // Media
  ffmpeg:     { Icon: SiFfmpeg,        color: '#007808' },

  // Fallback
  'tool-unknown':     { Icon: Wrench,         color: '#94a3b8' },
  'command-unknown':  { Icon: SquareTerminal, color: '#5a8a6a' },
};

// Tool names that the workbench can invoke (case-insensitive lookup)
const TOOL_NAME_MAP: Record<string, ToolKind> = {
  // Event types (mirror the reference's per-row glyphs)
  thought: 'thought', thinking: 'thinking',
  explored: 'explored', exploring: 'exploring',
  edited: 'edited', ran: 'ran', todo: 'todo',

  // File ops
  read_file: 'read', '@read_file': 'read', 'fs.read': 'read',
  write_file: 'write', '@write_file': 'write', 'fs.write': 'write',
  edit_file: 'edit', '@edit_file': 'edit',
  apply_patch: 'edit', '@apply_patch': 'edit',
  create_file: 'write', '@create_file': 'write',
  replace_file: 'edit', '@replace_file': 'edit',

  // Web
  web_search: 'search', '@web_search': 'search', search: 'search',
  web_fetch: 'fetch', '@web_fetch': 'fetch',
  fetch_url: 'fetch', '@fetch_url': 'fetch',

  // Shell
  run_command: 'bash', '@run_command': 'bash',
  bash: 'bash-sh', shell: 'bash-sh', sh: 'bash-sh',
  local_bash: 'bash-sh', 'local-bash': 'bash-sh',
  zsh: 'zsh', pwsh: 'powershell', powershell: 'powershell',

  // VCS
  git_status: 'git', git_diff: 'git', git_log: 'git',
  git_commit: 'git', git_push: 'git', git_pull: 'git', git_fetch: 'git',
  git_checkout: 'git', git_branch: 'git', git_clone: 'git', git_init: 'git',
  gh_pr: 'gh', gh_issue: 'gh', gh_release: 'gh', glab_mr: 'gitlab-cli',

  // Docker
  docker_run: 'docker-tool', docker_build: 'docker-tool',
  docker_compose: 'docker-tool', docker_ps: 'docker-tool',
  kubectl_apply: 'kubectl', kubectl_get: 'kubectl', kubectl_logs: 'kubectl',
  terraform_apply: 'terraform', terraform_plan: 'terraform',
  ansible_playbook: 'ansible',

  // Browser
  browser_navigate: 'chrome', browser_screenshot: 'chrome', browser_click: 'chrome',
};

/** Map a raw shell binary name to its ToolKind. Separate from the ICONS map so
 *  that binary names like `docker` don't collide with the `docker` file-icon kind. */
const COMMAND_MAP: Record<string, ToolKind> = {
  // Package managers
  npm: 'npm', npx: 'npx', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun',
  // JS / TS runtimes
  node: 'node', deno: 'deno', tsx: 'node', ts: 'node',
  // Language toolchains
  tsc: 'tsc', cargo: 'cargo', rustc: 'rust', rustup: 'rust',
  go: 'go', python: 'python', python3: 'python', pip: 'pip', pip3: 'pip', pipx: 'pip', uv: 'uv', poetry: 'uv',
  // Build tools
  vite: 'vite', webpack: 'webpack', rollup: 'rollup', esbuild: 'vite', swc: 'rust', tauri: 'tauri',
  // VCS
  git: 'git', gh: 'gh', glab: 'gitlab-cli',
  // Containers / cloud
  docker: 'docker-tool', docker_compose: 'docker-tool', kubectl: 'kubectl',
  terraform: 'terraform', ansible: 'ansible',
  // Network
  curl: 'curl', wget: 'wget', http: 'curl', https: 'curl',
  // Shells
  bash: 'bash-sh', sh: 'bash-sh', zsh: 'zsh', fish: 'bash-sh',
  pwsh: 'powershell', powershell: 'powershell',
  // Common Unix tools (default to bash-sh)
  cat: 'bash-sh', grep: 'bash-sh', egrep: 'bash-sh', fgrep: 'bash-sh',
  find: 'bash-sh', ls: 'bash-sh', cp: 'bash-sh', mv: 'bash-sh',
  rm: 'bash-sh', mkdir: 'bash-sh', rmdir: 'bash-sh', touch: 'bash-sh',
  chmod: 'bash-sh', chown: 'bash-sh', echo: 'bash-sh', pwd: 'bash-sh',
  cd: 'bash-sh', sed: 'bash-sh', awk: 'bash-sh', sort: 'bash-sh',
  head: 'bash-sh', tail: 'bash-sh', wc: 'bash-sh', xargs: 'bash-sh',
  uniq: 'bash-sh', tr: 'bash-sh', cut: 'bash-sh', tee: 'bash-sh',
  // Dev tooling
  eslint: 'eslint', prettier: 'prettier',
  jest: 'jest', vitest: 'vitest', cypress: 'cypress',
};

/**
 * Extract the first real binary from a command line.
 * Strips:
 *   - path prefix  (`/usr/local/bin/npm` → `npm`)
 *   - leading wrappers (`sudo`, `time`, `nice`, `env`, `command`)
 *   - env-var assignments (`FOO=bar npm install` → `npm`)
 *   - compound operators (returns the first segment, before && ; | || >>)
 */
function parseCommand(cmd: string): string {
  let stripped = cmd.replace(/^\s*(sudo|time|nice|env|command)\s+/g, '').trim();
  // Drop leading env-var assignments: FOO=bar BAZ=qux npm → npm
  stripped = stripped
    .split(/\s+/)
    .filter(tok => !/^[A-Z_][A-Z0-9_]*=/.test(tok))
    .join(' ');
  const first = stripped.split(/&&|;|\||\|\||>>/)[0].trim();
  const base = first.split(/\s+/)[0] || '';
  return (base.split('/').pop() || base).toLowerCase();
}

function resolveKind(kind: ToolKind): ToolIcon {
  const e = ICONS[kind];
  return {
    Icon: e.Icon,
    color: e.color,
    kind,
    isAnimated: !!e.isAnimated,
  };
}

/**
 * Resolve the brand-aware icon for a tool call or shell command.
 *
 * @param name  Tool name (e.g. `read_file`, `@web_search`) or a shell command string.
 * @param kind  `'tool'` (default) or `'command'`. Commands are parsed for the
 *              first real binary; compound commands like `cd foo && pnpm test`
 *              resolve to `pnpm`.
 */
export function getToolIcon(name: string, kind: 'tool' | 'command' = 'tool'): ToolIcon {
  if (kind === 'tool') {
    const normalised = name.replace(/^@/, '');
    const lower = normalised.toLowerCase();

    if (TOOL_NAME_MAP[normalised]) return resolveKind(TOOL_NAME_MAP[normalised]);
    if (TOOL_NAME_MAP[lower]) return resolveKind(TOOL_NAME_MAP[lower]);

    // Substring heuristic
    for (const [key, value] of Object.entries(TOOL_NAME_MAP)) {
      if (lower.includes(key)) return resolveKind(value);
    }
    return resolveKind('tool-unknown');
  }

  // Command parsing — try each `&&`/`;`/`|` segment in order, preferring
  // the first *meaningful* command over trivial context-setters (cd, echo, pwd).
  const segments = name.split(/&&|;|\|/g).map(s => s.trim()).filter(Boolean);
  const trivial = new Set(['bash-sh', 'bash', 'command-unknown']);
  let firstMatch: ToolKind | null = null;
  for (const seg of segments) {
    const parsed = parseCommand(seg);
    if (!parsed || !COMMAND_MAP[parsed]) continue;
    const kind = COMMAND_MAP[parsed];
    if (firstMatch === null) firstMatch = kind;
    if (!trivial.has(kind)) return resolveKind(kind);
  }
  return resolveKind(firstMatch ?? 'command-unknown');
}
