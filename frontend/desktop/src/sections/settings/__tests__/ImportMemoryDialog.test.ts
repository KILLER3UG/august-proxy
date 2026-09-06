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

describe('parseMemoryImportEntries — Claude prose dumps (no bullets)', () => {
  // Claude's legacy memory export: bold section labels + prose paragraphs,
  // NO bullets anywhere. The bullet parser finds nothing; the prose parser
  // must pick the paragraphs up with the section as category hint.
  const proseDump = [
    '**Work context**',
    '',
    'Sheesh is a Computer Engineering student at JRMSU, expected to graduate in 2029.',
    'Sheesh works part-time and helps with a family business daily.',
    '',
    '**Personal context**',
    '',
    'Sheesh is based in the Philippines (UTC+8), currently in or near Dapitan City.',
    'Hobbies include competitive gaming and basketball.',
    '',
    '**Top of mind**',
    '',
    'Sheesh is actively working on August Proxy, a Tauri + React + FastAPI desktop AI proxy system.',
  ].join('\n');

  it('parses prose paragraphs as entries with section labels as category hints', () => {
    // One entry per PROSE PARAGRAPH: consecutive lines inside a section are
    // one soft-wrapped paragraph and join with spaces.
    const entries = parseMemoryImportEntries(proseDump, 'claude-legacy-memory.md');
    expect(entries).toHaveLength(3);
    expect(entries[0].value).toContain('Computer Engineering student at JRMSU');
    expect(entries[0].value).toContain('family business daily'); // soft-wrapped join
    expect(entries[0].category).toBe('user'); // "Work context"
    expect(entries[1].value).toContain('Dapitan City');
    expect(entries[1].category).toBe('user'); // "Personal context"
    expect(entries[2].value).toContain('August Proxy');
    expect(entries[2].category).toBe('project'); // "Top of mind"
    // Keys are stable slugs derived from the paragraph's first words.
    expect(entries[0].key).toMatch(/^[a-z0-9-]+$/);
  });

  it('joins soft-wrapped lines of one paragraph into a single entry', () => {
    const wrapped = [
      '**Work context**',
      '',
      'The trading agent uses a GRPO reinforcement learning pipeline',
      'with a multi-component reward structure and walk-forward validation.',
    ].join('\n');
    const entries = parseMemoryImportEntries(wrapped, 'f.md');
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe(
      'The trading agent uses a GRPO reinforcement learning pipeline with a multi-component reward structure and walk-forward validation.',
    );
  });

  it('collapses byte-identical paragraphs (idempotent re-import) and suffixes same-key distinct ones', () => {
    const dupes = [
      '**Work context**',
      '',
      'Sheesh works part-time and helps with a family business daily.',
      '',
      'Sheesh works part-time and helps with a family business daily.',
      '',
      'Sheesh works part-time and helps with a family business on weekends too.',
    ].join('\n');
    const entries = parseMemoryImportEntries(dupes, 'f.md');
    expect(entries).toHaveLength(2);
    expect(entries[0].key).toBe(entries[1].key.replace(/-\d+$/, ''));
    expect(entries[1].key).not.toBe(entries[0].key); // distinct paragraph survives
  });

  it('still prefers bullets when the file has them (prose parser is fallback only)', () => {
    const mixed = [
      '# Claude memory',
      '',
      '- Prefers concise answers without preamble',
      '',
      'A stray prose paragraph that should NOT become an entry.',
    ].join('\n');
    const entries = parseMemoryImportEntries(mixed, 'f.md');
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe('Prefers concise answers without preamble');
  });

  it('maps top-of-mind and brief-history section labels to sane categories', () => {
    const entries = parseMemoryImportEntries(
      '**Brief history**\n\nSheesh published as a Science & Technology writer for The State Collegian.',
      'f.md',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('reference'); // "history"
  });
});
