/* ── File-icon utility ─ brand-aware language/file icons ──────────── */
/* Single source of truth for language-coloured file icons used by       */
/* DisclosureRow, ToolCallItem, DiffView, and anywhere else that        */
/* renders a filename.                                                  */
/*                                                                       */
/* Coverage: 60+ kinds grouped by category. Brand logos come from        */
/* react-icons/si (Simple Icons, official CC0 SVGs). No-brand formats    */
/* fall back to themed lucide-react File* variants.                      */

import type { ComponentType, SVGProps } from 'react';
import {
  // Web / JS ecosystem
  SiReact, SiTypescript, SiJavascript, SiVuedotjs, SiSvelte,
  // Backend languages
  SiPython, SiRuby, SiGo, SiRust, SiOpenjdk, SiKotlin, SiSwift,
  SiC, SiCplusplus, SiSharp, SiPhp, SiScala, SiElixir, SiDart,
  // Shell / scripting
  SiGnubash, SiPowers, SiLua, SiPerl, SiHaskell, SiClojure,
  // Web markup / styles
  SiHtml5, SiCss3, SiSass, SiLess, SiPostcss,
  // Data / config
  SiYaml, SiMarkdown, SiDotenv,
  // Query / schema
  SiSqlite, SiGraphql,
  // Build / tooling
  SiDocker, SiApachemaven, SiGradle,
  // VCS / meta
  SiGitignoredotio,
} from 'react-icons/si';
import {
  FileText, FileCode, FileCog, FileJson, FileImage, FileVideo, FileMusic,
  FileType, FileArchive, FileSpreadsheet, FileLock, File as FileGeneric,
  Settings, BookOpen, ScrollText, Hash, BookText, Network,
} from 'lucide-react';

type IconComp = ComponentType<{ size?: number; color?: string } & SVGProps<SVGSVGElement>>;

export type FileKind =
  // Web / JS
  | 'react' | 'typescript' | 'javascript' | 'vue' | 'svelte'
  // Backend
  | 'python' | 'ruby' | 'go' | 'rust' | 'java' | 'kotlin' | 'swift'
  | 'c' | 'cpp' | 'csharp' | 'php' | 'scala' | 'elixir' | 'dart'
  // Shell / scripting
  | 'shell' | 'powershell' | 'lua' | 'perl' | 'haskell' | 'clojure'
  // Web markup / styles
  | 'html' | 'css' | 'scss' | 'less' | 'stylus' | 'postcss'
  // Data / config
  | 'json' | 'yaml' | 'toml' | 'ini' | 'xml' | 'csv' | 'env' | 'lock'
  // Docs
  | 'markdown' | 'rst' | 'asciidoc' | 'latex'
  // Query / schema
  | 'sql' | 'graphql' | 'protobuf'
  // Build / tooling
  | 'docker' | 'makefile' | 'cmake' | 'gradle' | 'maven' | 'gnumakefile'
  // VCS / meta
  | 'gitignore' | 'editorconfig' | 'license' | 'changelog' | 'readme' | 'log'
  // Media / assets
  | 'image' | 'video' | 'audio' | 'font' | 'binary'
  | 'archive' | 'pdf' | 'ebook' | 'spreadsheet'
  // Fallback
  | 'config' | 'plaintext' | 'unknown';

export interface FileIcon {
  Icon: IconComp;
  color: string;
  kind: FileKind;
}

const ICONS: Record<FileKind, { Icon: IconComp; color: string }> = {
  // ── Web / JS ecosystem ──
  react:         { Icon: SiReact,         color: '#61dafb' },
  typescript:    { Icon: SiTypescript,    color: '#3178c6' },
  javascript:    { Icon: SiJavascript,    color: '#f7df1e' },
  vue:           { Icon: SiVuedotjs,      color: '#42b883' },
  svelte:        { Icon: SiSvelte,        color: '#ff3e00' },

  // ── Backend languages ──
  python:        { Icon: SiPython,        color: '#3776ab' },
  ruby:          { Icon: SiRuby,          color: '#cc342d' },
  go:            { Icon: SiGo,            color: '#00add8' },
  rust:          { Icon: SiRust,          color: '#dea584' },
  java:          { Icon: SiOpenjdk,       color: '#f89820' },
  kotlin:        { Icon: SiKotlin,        color: '#7f52ff' },
  swift:         { Icon: SiSwift,         color: '#f05138' },
  c:             { Icon: SiC,             color: '#a8b9cc' },
  cpp:           { Icon: SiCplusplus,     color: '#00599c' },
  csharp:        { Icon: SiSharp,         color: '#239120' },
  php:           { Icon: SiPhp,           color: '#777bb4' },
  scala:         { Icon: SiScala,         color: '#dc322f' },
  elixir:        { Icon: SiElixir,        color: '#4b275f' },
  dart:          { Icon: SiDart,          color: '#0175c2' },

  // ── Shell / scripting ──
  shell:         { Icon: SiGnubash,       color: '#4eaa25' },
  powershell:    { Icon: SiPowers,        color: '#012456' },
  lua:           { Icon: SiLua,           color: '#000080' },
  perl:          { Icon: SiPerl,          color: '#0298c3' },
  haskell:       { Icon: SiHaskell,       color: '#5e5086' },
  clojure:       { Icon: SiClojure,       color: '#db5855' },

  // ── Web markup / styles ──
  html:          { Icon: SiHtml5,         color: '#e34f26' },
  css:           { Icon: SiCss3,          color: '#1572b6' },
  scss:          { Icon: SiSass,          color: '#cc6699' },
  less:          { Icon: SiLess,          color: '#1d365d' },
  stylus:        { Icon: FileCog,         color: '#ff6347' },
  postcss:       { Icon: SiPostcss,       color: '#dc3a0c' },

  // ── Data / config ──
  json:          { Icon: FileJson,        color: '#cbcb41' },
  yaml:          { Icon: SiYaml,          color: '#cb171e' },
  toml:          { Icon: FileCog,         color: '#9c4221' },
  ini:           { Icon: FileCog,         color: '#6b6b6b' },
  xml:           { Icon: FileCode,        color: '#0060ac' },
  csv:           { Icon: FileSpreadsheet, color: '#237346' },
  env:           { Icon: SiDotenv,        color: '#ecd53f' },
  lock:          { Icon: FileLock,        color: '#7f7f7f' },

  // ── Docs ──
  markdown:      { Icon: SiMarkdown,      color: '#083fa1' },
  rst:           { Icon: BookText,        color: '#141414' },
  asciidoc:      { Icon: BookText,        color: '#3a4045' },
  latex:         { Icon: Hash,            color: '#3d6117' },

  // ── Query / schema ──
  sql:           { Icon: SiSqlite,        color: '#dad8d8' },
  graphql:       { Icon: SiGraphql,       color: '#e10098' },
  protobuf:      { Icon: Network,         color: '#4285f4' },

  // ── Build / tooling ──
  docker:        { Icon: SiDocker,        color: '#384d54' },
  makefile:      { Icon: SiGnubash,       color: '#427819' },
  gnumakefile:   { Icon: SiGnubash,       color: '#427819' },
  cmake:         { Icon: FileCog,         color: '#064f8c' },
  gradle:        { Icon: SiGradle,        color: '#02303a' },
  maven:         { Icon: SiApachemaven,   color: '#a91e1e' },

  // ── VCS / meta ──
  gitignore:     { Icon: SiGitignoredotio, color: '#f14e32' },
  editorconfig:  { Icon: Settings,        color: '#7c7c7c' },
  license:       { Icon: ScrollText,      color: '#cfa337' },
  changelog:     { Icon: BookOpen,        color: '#7c7c7c' },
  readme:        { Icon: BookOpen,        color: '#083fa1' },
  log:           { Icon: FileText,        color: '#888888' },

  // ── Media / assets ──
  image:         { Icon: FileImage,       color: '#a074c4' },
  video:         { Icon: FileVideo,       color: '#ee5757' },
  audio:         { Icon: FileMusic,       color: '#f7a41d' },
  font:          { Icon: FileType,        color: '#b1351f' },
  binary:        { Icon: FileGeneric,     color: '#6b6b6b' },
  archive:       { Icon: FileArchive,     color: '#a07433' },
  pdf:           { Icon: FileText,        color: '#b30b00' },
  ebook:         { Icon: BookOpen,        color: '#7c4dff' },
  spreadsheet:   { Icon: FileSpreadsheet, color: '#237346' },

  // ── Fallback ──
  config:        { Icon: FileCog,         color: '#6b6b6b' },
  plaintext:     { Icon: FileText,        color: '#aaaaaa' },
  unknown:       { Icon: FileGeneric,     color: '#888888' },
};

const EXT_MAP: Record<string, FileKind> = {
  // Web / JS
  tsx: 'react', ts: 'typescript', jsx: 'react', js: 'javascript',
  mjs: 'javascript', cjs: 'javascript', vue: 'vue', svelte: 'svelte',

  // Backend
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'gradle',
  swift: 'swift', m: 'c', mm: 'cpp',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', scala: 'scala', sc: 'scala',
  ex: 'elixir', exs: 'elixir', dart: 'dart',

  // Shell / scripting
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  lua: 'lua', pl: 'perl', hs: 'haskell', lhs: 'haskell',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',

  // Web markup / styles
  html: 'html', htm: 'html', xhtml: 'html', svg: 'image',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', styl: 'stylus', pcss: 'postcss',

  // Data / config
  json: 'json', jsonc: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml', tom: 'toml', toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'config',
  xml: 'xml', csv: 'csv', tsv: 'spreadsheet',

  // Docs
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  rst: 'rst', adoc: 'asciidoc', asciidoc: 'asciidoc',
  tex: 'latex', latex: 'latex',

  // Query / schema
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',

  // Build / tooling
  cmake: 'cmake', gradle: 'gradle', pom: 'maven',

  // Media / assets
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  bmp: 'image', ico: 'image', tiff: 'image', tif: 'image', avif: 'image', heic: 'image',
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', flv: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', eot: 'font',
  exe: 'binary', dll: 'binary', so: 'binary', dylib: 'binary',

  // Archives / docs
  zip: 'archive', tar: 'archive', gz: 'archive', bz2: 'archive',
  xz: 'archive', '7z': 'archive', rar: 'archive', zst: 'archive',
  pdf: 'pdf', epub: 'ebook', mobi: 'ebook', azw: 'ebook',
  xls: 'spreadsheet', xlsx: 'spreadsheet', ods: 'spreadsheet',
};

const FILENAME_MAP: Record<string, FileKind> = {
  // Build / tooling
  Dockerfile: 'docker', dockerfile: 'docker',
  'Dockerfile.prod': 'docker', 'Dockerfile.dev': 'docker', 'Dockerfile.local': 'docker',
  Containerfile: 'docker', containerfile: 'docker',
  Makefile: 'makefile', GNUmakefile: 'gnumakefile', makefile: 'makefile',
  'CMakeLists.txt': 'cmake',
  'gradle.properties': 'config', 'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle', 'settings.gradle': 'gradle', 'pom.xml': 'maven',

  // Lock / package files (filename match wins over .json / .yaml / .lock)
  'package.json': 'json', 'tsconfig.json': 'json', 'jsconfig.json': 'json',
  'package-lock.json': 'lock', 'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock', 'bun.lockb': 'lock', 'Cargo.lock': 'lock',
  'composer.lock': 'lock', 'Gemfile.lock': 'lock', 'poetry.lock': 'lock',
  'Pipfile.lock': 'lock', 'go.sum': 'lock',

  // Meta
  '.gitignore': 'gitignore', '.dockerignore': 'gitignore',
  '.npmignore': 'gitignore', '.eslintignore': 'gitignore', '.prettierignore': 'gitignore',
  '.editorconfig': 'editorconfig', '.gitattributes': 'config',
  '.env': 'env', '.env.local': 'env', '.env.example': 'env',
  '.env.development': 'env', '.env.production': 'env',

  // License
  LICENSE: 'license', license: 'license', LICENCE: 'license', licence: 'license',
  'LICENSE.md': 'license', 'LICENSE.txt': 'license',
  'license.md': 'license', 'license.txt': 'license',
  COPYING: 'license', 'COPYING.md': 'license', 'copying.md': 'license',

  // Docs
  README: 'readme', readme: 'readme', 'README.md': 'readme', 'readme.md': 'readme',
  CHANGELOG: 'changelog', changelog: 'changelog', 'CHANGELOG.md': 'changelog', 'changelog.md': 'changelog',
  CONTRIBUTING: 'markdown', 'CONTRIBUTING.md': 'markdown', 'contributing.md': 'markdown',
  AUTHORS: 'plaintext', CONTRIBUTORS: 'plaintext',
  'CODE_OF_CONDUCT.md': 'markdown', 'SECURITY.md': 'markdown',
};

/**
 * Resolve the brand-aware icon for a filename.
 * Lookup order:
 *   1. exact-case filename match (dotfiles, Makefile, etc.)
 *   2. lowercase filename match
 *   3. extension match
 *   4. filename heuristics (dockerfile, makefile, license*, readme*, changelog*)
 *   5. fallback to `unknown`
 */
export function getFileIcon(filename: string): FileIcon {
  const base = filename.split(/[\\/]/).pop() || filename;

  if (FILENAME_MAP[base]) {
    const kind = FILENAME_MAP[base];
    return { kind, Icon: ICONS[kind].Icon, color: ICONS[kind].color };
  }

  const lower = base.toLowerCase();
  if (FILENAME_MAP[lower]) {
    const kind = FILENAME_MAP[lower];
    return { kind, Icon: ICONS[kind].Icon, color: ICONS[kind].color };
  }

  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const ext = base.slice(dot + 1).toLowerCase();
    if (EXT_MAP[ext]) {
      const kind = EXT_MAP[ext];
      return { kind, Icon: ICONS[kind].Icon, color: ICONS[kind].color };
    }
  }

  // No-extension heuristics
  if (lower === 'dockerfile' || lower === 'containerfile') {
    return { kind: 'docker', Icon: ICONS.docker.Icon, color: ICONS.docker.color };
  }
  if (lower === 'makefile') {
    return { kind: 'makefile', Icon: ICONS.makefile.Icon, color: ICONS.makefile.color };
  }
  if (lower === 'gnumakefile') {
    return { kind: 'gnumakefile', Icon: ICONS.gnumakefile.Icon, color: ICONS.gnumakefile.color };
  }
  if (lower.startsWith('license')) {
    return { kind: 'license', Icon: ICONS.license.Icon, color: ICONS.license.color };
  }
  if (lower.startsWith('readme')) {
    return { kind: 'readme', Icon: ICONS.readme.Icon, color: ICONS.readme.color };
  }
  if (lower.startsWith('changelog')) {
    return { kind: 'changelog', Icon: ICONS.changelog.Icon, color: ICONS.changelog.color };
  }

  return { kind: 'unknown', Icon: ICONS.unknown.Icon, color: ICONS.unknown.color };
}
