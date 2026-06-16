/* ── tool-icon.test.ts ─ unit tests for lib/tool-icon.ts ────────────── */

import { describe, it, expect } from 'vitest';
import { getToolIcon } from '../tool-icon';

/** Asserts the resolved Icon is renderable (function or forwardRef object). */
function expectRenderable(r: ReturnType<typeof getToolIcon>) {
  const t = typeof r.Icon;
  expect(t === 'function' || t === 'object').toBe(true);
}

describe('getToolIcon — event types', () => {
  it('returns the thought kind for "thought"', () => {
    const r = getToolIcon('thought', 'tool');
    expect(r.kind).toBe('thought');
    expect(r.isAnimated).toBe(false);
  });

  it('returns the exploring kind for "exploring" with isAnimated=true', () => {
    const r = getToolIcon('exploring', 'tool');
    expect(r.kind).toBe('exploring');
    expect(r.isAnimated).toBe(true);
  });

  it('returns the thinking kind for "thinking" with isAnimated=true', () => {
    const r = getToolIcon('thinking', 'tool');
    expect(r.kind).toBe('thinking');
    expect(r.isAnimated).toBe(true);
  });

  it.each(['ran', 'edited', 'todo', 'explored'])(
    'returns the %s kind for "%s"',
    (eventName) => {
      expect(getToolIcon(eventName, 'tool').kind).toBe(eventName);
    }
  );
});

describe('getToolIcon — tool names', () => {
  it.each([
    ['read_file',     'read'],
    ['@read_file',    'read'],
    ['edit_file',     'edit'],
    ['@edit_file',    'edit'],
    ['apply_patch',   'edit'],
    ['write_file',    'write'],
    ['@write_file',   'write'],
    ['web_search',    'search'],
    ['@web_search',   'search'],
    ['fetch_url',     'fetch'],
    ['@fetch_url',    'fetch'],
    ['run_command',   'bash'],
    ['@run_command',  'bash'],
    ['bash',          'bash-sh'],
    ['shell',         'bash-sh'],
    ['sh',            'bash-sh'],
    ['zsh',           'zsh'],
    ['pwsh',          'powershell'],
    ['powershell',    'powershell'],
  ])('returns %s for %s', (toolName, expectedKind) => {
    expect(getToolIcon(toolName, 'tool').kind).toBe(expectedKind);
  });

  it.each(['git_status', 'git_diff', 'git_log', 'git_commit', 'git_push', 'git_pull', 'git_checkout', 'git_clone', 'git_init'])(
    'returns git for %s',
    (toolName) => {
      const r = getToolIcon(toolName, 'tool');
      expect(r.kind).toBe('git');
      expectRenderable(r);
    }
  );

  it('returns gh for gh_pr / gh_issue', () => {
    expect(getToolIcon('gh_pr', 'tool').kind).toBe('gh');
    expect(getToolIcon('gh_issue', 'tool').kind).toBe('gh');
  });

  it('returns docker-tool for docker_run / docker_compose', () => {
    expect(getToolIcon('docker_run', 'tool').kind).toBe('docker-tool');
    expect(getToolIcon('docker_compose', 'tool').kind).toBe('docker-tool');
  });

  it('returns kubectl for kubectl_apply / kubectl_get', () => {
    expect(getToolIcon('kubectl_apply', 'tool').kind).toBe('kubectl');
    expect(getToolIcon('kubectl_get', 'tool').kind).toBe('kubectl');
  });

  it('returns terraform for terraform_apply', () => {
    expect(getToolIcon('terraform_apply', 'tool').kind).toBe('terraform');
  });

  it('returns chrome for browser_navigate', () => {
    expect(getToolIcon('browser_navigate', 'tool').kind).toBe('chrome');
  });

  it('returns tool-unknown for an unknown tool', () => {
    const r = getToolIcon('weirdxyz', 'tool');
    expect(r.kind).toBe('tool-unknown');
  });
});

describe('getToolIcon — command parsing', () => {
  it.each([
    ['npm install',                       'npm'],
    ['npx vite build',                    'npx'],
    ['pnpm test',                         'pnpm'],
    ['pnpm install --frozen-lockfile',    'pnpm'],
    ['yarn install',                      'yarn'],
    ['bun install',                       'bun'],
    ['node script.js',                    'node'],
    ['tsc --noEmit',                      'tsc'],
    ['vite build',                        'vite'],
    ['vite preview',                      'vite'],
    ['webpack --mode production',         'webpack'],
    ['tauri build',                       'tauri'],
    ['tauri dev',                         'tauri'],
    ['cargo build --release',             'cargo'],
    ['rustc main.rs',                     'rust'],
    ['go test ./...',                     'go'],
    ['python3 script.py',                 'python'],
    ['pip install requests',              'pip'],
    ['docker compose up -d',              'docker-tool'],
    ['docker run -it alpine',             'docker-tool'],
    ['gh pr create --fill',               'gh'],
    ['gh issue list',                     'gh'],
    ['glab mr create',                    'gitlab-cli'],
    ['curl https://api.example.com',      'curl'],
    ['wget https://example.com/file',     'wget'],
    ['bash ./script.sh',                  'bash-sh'],
    ['zsh -c "echo hello"',               'zsh'],
    ['eslint src/',                       'eslint'],
    ['prettier --write .',                'prettier'],
    ['jest --runInBand',                  'jest'],
    ['vitest run',                        'vitest'],
    ['cypress run',                       'cypress'],
  ])('returns %s for "%s"', (cmd, expectedKind) => {
    expect(getToolIcon(cmd, 'command').kind).toBe(expectedKind);
  });
});

describe('getToolIcon — path / wrapper stripping', () => {
  it('strips a path prefix from the command binary', () => {
    expect(getToolIcon('/usr/local/bin/npm install', 'command').kind).toBe('npm');
  });

  it('strips the sudo wrapper', () => {
    // apt isn't in the map; sudo is stripped but the underlying command isn't
    // recognised, so the result is command-unknown
    expect(getToolIcon('sudo apt update', 'command').kind).toBe('command-unknown');
  });

  it('strips the time wrapper', () => {
    expect(getToolIcon('time npm install', 'command').kind).toBe('npm');
  });

  it('strips the env wrapper', () => {
    expect(getToolIcon('env FOO=bar tsc', 'command').kind).toBe('tsc');
  });

  it('handles compound commands with &&', () => {
    expect(getToolIcon('cd /tmp && pnpm test', 'command').kind).toBe('pnpm');
  });

  it('handles compound commands with ;', () => {
    expect(getToolIcon('echo hello; yarn build', 'command').kind).toBe('yarn');
  });

  it('handles compound commands with |', () => {
    expect(getToolIcon('cat foo.txt | grep bar', 'command').kind).toBe('bash-sh');
  });

  it('handles empty command', () => {
    expect(getToolIcon('', 'command').kind).toBe('command-unknown');
  });
});

describe('getToolIcon — isAnimated flag', () => {
  it('is true for "exploring"', () => {
    expect(getToolIcon('exploring', 'tool').isAnimated).toBe(true);
  });

  it('is true for "thinking"', () => {
    expect(getToolIcon('thinking', 'tool').isAnimated).toBe(true);
  });

  it('is false for non-event kinds', () => {
    expect(getToolIcon('npm install', 'command').isAnimated).toBe(false);
    expect(getToolIcon('read_file', 'tool').isAnimated).toBe(false);
    expect(getToolIcon('git_commit', 'tool').isAnimated).toBe(false);
  });
});

describe('getToolIcon — color verification', () => {
  it('npm uses red #cb3837', () => {
    expect(getToolIcon('npm install', 'command').color).toBe('#cb3837');
  });

  it('cargo uses rust #dea584', () => {
    expect(getToolIcon('cargo build', 'command').color).toBe('#dea584');
  });

  it('tauri uses yellow #ffc131', () => {
    expect(getToolIcon('tauri build', 'command').color).toBe('#ffc131');
  });

  it('docker uses charcoal #384d54', () => {
    expect(getToolIcon('docker compose up', 'command').color).toBe('#384d54');
  });

  it('gh uses GitHub black #181717', () => {
    expect(getToolIcon('gh pr create', 'command').color).toBe('#181717');
  });
});
