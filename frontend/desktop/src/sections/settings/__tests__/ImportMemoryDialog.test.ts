/* ── ImportMemoryDialog parser tests ─────────────────────────────────────── */
/* The dialog parses the dropped file client-side before anything is        */
/* persisted; these tests pin the four supported shapes (August frontmatter  */
/* export, Claude plain-bullet dumps, generic key:value bullets, JSON).      */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

import { parseMemoryImportEntries } from '../ImportMemoryDialog';

describe('parseMemoryImportEntries — Claude plain-bullet dumps', () => {
  it('parses plain sentence bullets with headings as category hints', () => {
    const text = [
      '# Claude memory',
      '',
      '## User profile',
      '- Prefers concise answers without preamble',
      '- Works on a Tauri desktop app called August Proxy',
      '',
      '## Preferences',
      '- Dislikes horizontal pill tabs in settings UIs',
    ].join('\n');
    const entries = parseMemoryImportEntries(text, 'claude-legacy-memory.md');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      key: 'prefers-concise-answers-without-preamble',
      value: 'Prefers concise answers without preamble',
      category: 'user',
    });
    expect(entries[1]).toMatchObject({
      key: 'works-on-a-tauri-desktop-app',
      value: 'Works on a Tauri desktop app called August Proxy',
      category: 'user',
    });
    expect(entries[2].category).toBe('feedback');
  });

  it('parses numbered list items', () => {
    const entries = parseMemoryImportEntries('1. First fact here\n2) Second fact here', 'f.md');
    expect(entries.map((e) => e.value)).toEqual(['First fact here', 'Second fact here']);
  });

  it('keeps time/ratio colons whole instead of splitting them as key:value', () => {
    const entries = parseMemoryImportEntries('- The standup is at 3:00 pm daily', 'f.md');
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe('The standup is at 3:00 pm daily');
  });

  it('appends indented continuation lines to the previous bullet', () => {
    const text = '- Long memory entry starts here\n  and continues on this line\n- Next entry';
    const entries = parseMemoryImportEntries(text, 'f.md');
    expect(entries).toHaveLength(2);
    expect(entries[0].value).toBe('Long memory entry starts here\nand continues on this line');
  });
});

describe('parseMemoryImportEntries — generic key:value bullets', () => {
  it('splits "- key: value" bullets', () => {
    const entries = parseMemoryImportEntries('- Plant name: Gerald', 'f.md');
    expect(entries[0]).toMatchObject({ key: 'plant-name', value: 'Gerald' });
  });

  it('strips bold markers from "**Key:** value" bullets', () => {
    const entries = parseMemoryImportEntries('- **Work hours**: 9 to 5', 'f.md');
    expect(entries[0]).toMatchObject({ key: 'work-hours', value: '9 to 5' });
  });

  it('parses em-dash separators and memory-index link bullets', () => {
    const text = ['- Editor — Neovim', '- [Plant name](plant.md) — Gerald'].join('\n');
    const entries = parseMemoryImportEntries(text, 'f.md');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: 'editor', value: 'Neovim' });
    expect(entries[1]).toMatchObject({ key: 'plant-name', value: 'Gerald' });
  });

  it('skips horizontal rules and code fences', () => {
    const text = ['---', '```', '- not an entry (inside fence)', '```', '- Real entry'].join('\n');
    const entries = parseMemoryImportEntries(text, 'f.md');
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe('Real entry');
  });
});

describe('parseMemoryImportEntries — August frontmatter export round-trip', () => {
  it('parses a single frontmatter entry with body', () => {
    const text = [
      '---',
      'name: user:plant',
      'description: My plant is named Gerald',
      'type: user',
      'updated: 2026-08-28T10:00:00Z',
      '---',
      '',
      'My plant is named Gerald',
    ].join('\n');
    const entries = parseMemoryImportEntries(text, 'memories-export.md');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'userplant',
      value: 'My plant is named Gerald',
      category: 'user',
    });
  });

  it('parses multiple entries joined by --- separators', () => {
    const text = [
      '---',
      'name: user:editor',
      'description: Prefers dark mode',
      'type: user',
      '---',
      '',
      'Prefers dark mode',
      '',
      '---',
      'name: project:stack',
      'description: FastAPI backend',
      'type: project',
      '---',
      '',
      'FastAPI backend',
      'with extra detail lines',
    ].join('\n');
    const entries = parseMemoryImportEntries(text, 'facts-export.md');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: 'usereditor', value: 'Prefers dark mode', category: 'user' });
    expect(entries[1]).toMatchObject({
      key: 'projectstack',
      value: 'FastAPI backend\nwith extra detail lines',
      category: 'project',
    });
  });

  it('falls back to the description field when the body is empty', () => {
    const text = ['---', 'name: bare-entry', 'description: Only a description', 'type: general', '---'].join('\n');
    const entries = parseMemoryImportEntries(text, 'f.md');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'bare-entry', value: 'Only a description' });
  });
});

describe('parseMemoryImportEntries — JSON shapes', () => {
  it('parses {key, value} arrays and Claude {fact, details} values', () => {
    const text = JSON.stringify([
      { key: 'user:plant', value: 'My plant is named Gerald', category: 'user' },
      { key: 'project:stack', value: { fact: 'FastAPI backend', details: 'uv + ruff' } },
    ]);
    const entries = parseMemoryImportEntries(text, 'export.json');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: 'userplant', value: 'My plant is named Gerald', category: 'user' });
    expect(entries[1].value).toBe('FastAPI backend\n\nuv + ruff');
  });
});

describe('parseMemoryImportEntries — dedupe', () => {
  it('keeps the last entry when derived keys collide (save_fact upsert semantics)', () => {
    const text = '- User prefers dark mode everywhere\n- User prefers dark mode on terminals';
    const entries = parseMemoryImportEntries(text, 'f.md');
    expect(entries).toHaveLength(2);
    const colliding = ['- User prefers dark mode in the editor\n- User prefers dark mode in the editor'].join('\n');
    const deduped = parseMemoryImportEntries(colliding, 'f.md');
    expect(deduped).toHaveLength(1);
  });

  it('returns zero entries for noise-only files', () => {
    expect(parseMemoryImportEntries('---\n***\n\n', 'f.md')).toHaveLength(0);
  });
});
