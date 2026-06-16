/* ── file-icon.test.ts ─ unit tests for lib/file-icon.ts ────────────── */

import { describe, it, expect } from 'vitest';
import { getFileIcon } from '../file-icon';

/** Asserts the resolved Icon is renderable (function or forwardRef object). */
function expectRenderable(r: ReturnType<typeof getFileIcon>) {
  // lucide-react components are forwardRef-wrapped, so typeof === 'object';
  // react-icons Si* are plain function components.
  const t = typeof r.Icon;
  expect(t === 'function' || t === 'object').toBe(true);
}

/** Asserts a brand logo was chosen (a function) rather than a lucide File* fallback. */
function expectBrand(r: ReturnType<typeof getFileIcon>, expectedKind: string) {
  expect(r.kind).toBe(expectedKind);
  // Brand logos are plain function components
  expect(typeof r.Icon).toBe('function');
  expect(r.Icon).toBeDefined();
}

describe('getFileIcon — extension match', () => {
  it.each([
    ['Button.tsx',        'react',         '#61dafb'],
    ['config.ts',         'typescript',    '#3178c6'],
    ['utils.js',          'javascript',    '#f7df1e'],
    ['script.py',         'python',        '#3776ab'],
    ['main.rs',           'rust',          '#dea584'],
    ['server.go',         'go',            '#00add8'],
    ['Main.kt',           'kotlin',        '#7f52ff'],
    ['Program.cs',        'csharp',        '#239120'],
    ['main.cpp',          'cpp',           '#00599c'],
    ['main.c',            'c',             '#a8b9cc'],
    ['App.swift',         'swift',         '#f05138'],
    ['index.html',        'html',          '#e34f26'],
    ['styles.css',        'css',           '#1572b6'],
    ['styles.scss',       'scss',          '#cc6699'],
    ['config.yaml',       'yaml',          '#cb171e'],
    ['script.sh',         'shell',         '#4eaa25'],
    ['App.vue',           'vue',           '#42b883'],
    ['App.svelte',        'svelte',        '#ff3e00'],
    ['server.rb',         'ruby',          '#cc342d'],
    ['App.java',          'java',          '#f89820'],
    ['index.php',         'php',           '#777bb4'],
    ['lib.lua',           'lua',           '#000080'],
    ['lib.pl',            'perl',          '#0298c3'],
    ['lib.hs',            'haskell',       '#5e5086'],
    ['core.clj',          'clojure',       '#db5855'],
  ])('returns %s for %s', (filename, expectedKind, expectedColor) => {
    const r = getFileIcon(filename);
    expect(r.kind).toBe(expectedKind);
    expect(r.color).toBe(expectedColor);
    expectBrand(r, expectedKind);
  });
});

describe('getFileIcon — filename match wins over extension', () => {
  it('returns docker for Dockerfile', () => {
    expectBrand(getFileIcon('Dockerfile'), 'docker');
  });

  it('returns docker for Containerfile', () => {
    expect(getFileIcon('Containerfile').kind).toBe('docker');
  });

  it('returns docker for Dockerfile.prod', () => {
    expect(getFileIcon('Dockerfile.prod').kind).toBe('docker');
  });

  it('returns makefile for Makefile', () => {
    expect(getFileIcon('Makefile').kind).toBe('makefile');
  });

  it('returns gnumakefile for GNUmakefile', () => {
    expect(getFileIcon('GNUmakefile').kind).toBe('gnumakefile');
  });

  it('returns lock for package-lock.json (not json)', () => {
    expect(getFileIcon('package-lock.json').kind).toBe('lock');
  });

  it('returns lock for yarn.lock (not yaml)', () => {
    expect(getFileIcon('yarn.lock').kind).toBe('lock');
  });

  it('returns lock for Cargo.lock', () => {
    expect(getFileIcon('Cargo.lock').kind).toBe('lock');
  });

  it('returns gradle for build.gradle.kts (not kotlin)', () => {
    expect(getFileIcon('build.gradle.kts').kind).toBe('gradle');
  });

  it('returns maven for pom.xml (not xml)', () => {
    expect(getFileIcon('pom.xml').kind).toBe('maven');
  });

  it('returns env for .env', () => {
    expect(getFileIcon('.env').kind).toBe('env');
  });

  it('returns gitignore for .gitignore', () => {
    expect(getFileIcon('.gitignore').kind).toBe('gitignore');
  });

  it('returns license for LICENSE', () => {
    expect(getFileIcon('LICENSE').kind).toBe('license');
  });

  it('returns readme for README.md', () => {
    expect(getFileIcon('README.md').kind).toBe('readme');
  });

  it('returns changelog for CHANGELOG.md', () => {
    expect(getFileIcon('CHANGELOG.md').kind).toBe('changelog');
  });
});

describe('getFileIcon — heuristics', () => {
  it('returns docker for case-insensitive dockerfile', () => {
    expect(getFileIcon('dockerfile').kind).toBe('docker');
    expect(getFileIcon('Dockerfile').kind).toBe('docker');
    expect(getFileIcon('DOCKERFILE').kind).toBe('docker');
  });

  it('returns makefile for case-insensitive makefile', () => {
    expect(getFileIcon('makefile').kind).toBe('makefile');
    expect(getFileIcon('Makefile').kind).toBe('makefile');
  });

  it('returns license for files starting with "license"', () => {
    expect(getFileIcon('license.txt').kind).toBe('license');
    expect(getFileIcon('license.md').kind).toBe('license');
  });

  it('returns readme for files starting with "readme"', () => {
    expect(getFileIcon('readme.txt').kind).toBe('readme');
  });

  it('returns changelog for files starting with "changelog"', () => {
    expect(getFileIcon('changelog.txt').kind).toBe('changelog');
  });
});

describe('getFileIcon — fallback', () => {
  it('returns unknown for an unknown extension', () => {
    const r = getFileIcon('weird.xyz');
    expect(r.kind).toBe('unknown');
    expectRenderable(r);
  });

  it('returns unknown for an empty string', () => {
    expect(getFileIcon('').kind).toBe('unknown');
  });
});

describe('getFileIcon — paths', () => {
  it('uses the basename of a nested path', () => {
    expect(getFileIcon('src/components/Button.tsx').kind).toBe('react');
  });

  it('uses the basename of a Windows path', () => {
    expect(getFileIcon('C:\\projects\\foo\\main.py').kind).toBe('python');
  });
});

describe('getFileIcon — media / config / archive', () => {
  it('returns image for .png', () => {
    expect(getFileIcon('logo.png').kind).toBe('image');
  });

  it('returns video for .mp4', () => {
    expect(getFileIcon('clip.mp4').kind).toBe('video');
  });

  it('returns audio for .mp3', () => {
    expect(getFileIcon('song.mp3').kind).toBe('audio');
  });

  it('returns font for .woff2', () => {
    expect(getFileIcon('Inter.woff2').kind).toBe('font');
  });

  it('returns archive for .zip', () => {
    expect(getFileIcon('bundle.zip').kind).toBe('archive');
  });

  it('returns pdf for .pdf', () => {
    expect(getFileIcon('doc.pdf').kind).toBe('pdf');
  });

  it('returns env for .env.local', () => {
    expect(getFileIcon('.env.local').kind).toBe('env');
  });

  it('returns toml for .toml (FileCog fallback, no brand)', () => {
    expect(getFileIcon('pyproject.toml').kind).toBe('toml');
  });

  it('returns json for .json (FileJson fallback, no brand)', () => {
    expect(getFileIcon('data.json').kind).toBe('json');
  });

  it('returns sql for .sql', () => {
    expect(getFileIcon('query.sql').kind).toBe('sql');
  });

  it('returns graphql for .graphql', () => {
    expect(getFileIcon('schema.graphql').kind).toBe('graphql');
  });

  it('returns markdown for .md', () => {
    expect(getFileIcon('README.md').kind).toBe('readme'); // filename match wins
    expect(getFileIcon('notes.md').kind).toBe('markdown'); // extension wins when no filename match
  });
});
