/**
 * code-highlight — single source of truth for syntax highlighting.
 *
 * Both the chat Markdown renderer (fenced code blocks) and the inline diff
 * panel (DiffCodePanel) highlight through here, so they share one language
 * set, one theme, and one escaping contract. highlight.js is loaded as
 * `lib/core` + an explicit language list (tree-shaken) and the dark
 * `vs2015` theme is imported once, globally, so its `.hljs-*` token colours
 * apply wherever the highlighted HTML is rendered.
 */

import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import jsonLang from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import yaml from 'highlight.js/lib/languages/yaml';
import plaintext from 'highlight.js/lib/languages/plaintext';
import 'highlight.js/styles/vs2015.css';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('json', jsonLang);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sh', shell);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', cpp);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('text', plaintext);
hljs.registerLanguage('plaintext', plaintext);

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Highlight a snippet and return ready-to-inject HTML (escaped + wrapped in
 * `.hljs-*` token spans). Falls back to `highlightAuto` for unknown languages
 * and to plain escaping if highlighting throws.
 */
export function highlightCode(text: string, lang: string): string {
  const normalized = lang.toLowerCase().replace(/^language-/, '');
  try {
    if (normalized && hljs.getLanguage(normalized)) {
      return hljs.highlight(text, { language: normalized, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}

/**
 * Map a filename's extension to a registered highlight.js language name.
 * Returns '' when unknown — callers should then let `highlightCode` auto-detect.
 * Kept deliberately narrow to the languages registered above so we never ask
 * hljs for a grammar it doesn't have.
 */
const EXT_TO_LANG: Record<string, string> = {
  tsx: 'typescript',
  ts: 'typescript',
  jsx: 'javascript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  css: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  c: 'cpp',
  h: 'cpp',
  rb: 'ruby',
  yaml: 'yaml',
  yml: 'yaml',
};

export function languageForFilename(filename: string | null | undefined): string {
  if (!filename) return '';
  const base = filename.split(/[\\/]/).pop() || filename;
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const ext = base.slice(dot + 1).toLowerCase();
    if (EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
  }
  return '';
}
