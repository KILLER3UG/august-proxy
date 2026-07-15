/* ── ChatAttachmentService ────────────────────────────────────────────── */
/* OOP service for reading files / clipboard into FileAttachment[].       */

import { readFileContent, type FileReadResult } from '@/lib/file-reader';
import type { FileAttachment } from '@/types/chat';

const CODE_LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  vue: 'vue',
  svelte: 'svelte',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  graphql: 'graphql',
  gql: 'graphql',
};

export class ChatAttachmentService {
  /** Highlight language for fenced blocks in the user prompt. */
  static codeLangFor(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return CODE_LANG_MAP[ext] ?? '';
  }

  static formatSize(bytes: number): string {
    return bytes > 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`;
  }

  /** Read browser File objects into chat attachments. */
  static async fromFiles(files: Iterable<File>): Promise<FileAttachment[]> {
    const out: FileAttachment[] = [];
    for (const f of files) {
      const sizeStr = this.formatSize(f.size);
      try {
        const result: FileReadResult = await readFileContent(f);
        out.push({
          name: f.name || (result.type === 'image' ? 'pasted-image.png' : 'attachment'),
          size: sizeStr,
          content: result.content,
          dataUrl: result.dataUrl,
          type: result.type,
          truncated: result.truncated,
        });
      } catch {
        out.push({
          name: f.name || 'attachment',
          size: sizeStr,
          type: 'unsupported',
        });
      }
    }
    return out;
  }

  /** Extract File objects from a paste event (images preferred). */
  static filesFromClipboard(data: DataTransfer | null): File[] {
    if (!data?.items?.length) return [];
    const files: File[] = [];
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    return files;
  }

  /** Serialize attachments into markdown sections for the model prompt. */
  static formatForPrompt(attachments: FileAttachment[]): string {
    if (attachments.length === 0) return '';
    const sections = attachments.map((a) => {
      const header = `📄 **${a.name}**`;
      if (a.type === 'text' && a.content) {
        const lang = this.codeLangFor(a.name);
        return `${header}\n\`\`\`${lang}\n${a.content}\n\`\`\``;
      }
      if (a.type === 'image' && a.dataUrl) {
        return `${header}\n[Image attached — available for vision analysis]`;
      }
      return `${header}\n[File attached — content could not be extracted]`;
    });
    return `\n\n---\n\n${sections.join('\n\n')}`;
  }

  /** Merge user text + attachment sections. */
  static composeUserText(text: string, attachments: FileAttachment[]): string {
    const body = text.trim();
    const attach = this.formatForPrompt(attachments);
    if (!attach) return body;
    return body ? `${body}${attach}` : attach.trim();
  }
}
