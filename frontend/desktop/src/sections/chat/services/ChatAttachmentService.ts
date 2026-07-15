/* ── ChatAttachmentService ────────────────────────────────────────────── */
/* Reads files and clipboard images into FileAttachment[] for the composer. */

import { isImageFile, readFileContent, type FileReadResult } from '@/lib/file-reader';
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

export type AttachmentProgressHandler = (id: string, progress: number) => void;

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

  static newId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /** Build a pending attachment row shown immediately while content is read. */
  static createPending(file: File): FileAttachment {
    const image = isImageFile(file);
    return {
      id: this.newId(),
      name: file.name || (image ? 'pasted-image.png' : 'attachment'),
      size: this.formatSize(file.size),
      type: image ? 'image' : 'text',
      status: 'reading',
      progress: 0,
      // Instant local preview for images while FileReader runs.
      previewUrl: image ? URL.createObjectURL(file) : undefined,
    };
  }

  /** Read a single file and merge into a completed FileAttachment. */
  static async readInto(
    file: File,
    pending: FileAttachment,
    onProgress?: (progress: number) => void,
  ): Promise<FileAttachment> {
    try {
      const result: FileReadResult = await readFileContent(file, onProgress);
      return {
        ...pending,
        name: file.name || (result.type === 'image' ? 'pasted-image.png' : pending.name),
        content: result.content,
        dataUrl: result.dataUrl,
        type: result.type,
        truncated: result.truncated,
        status: 'ready',
        progress: 100,
        error: undefined,
      };
    } catch (err) {
      return {
        ...pending,
        type: 'unsupported',
        status: 'error',
        progress: 0,
        error: err instanceof Error ? err.message : 'Failed to read file',
      };
    }
  }

  /** Read browser File objects into chat attachments (blocking, no live progress). */
  static async fromFiles(files: Iterable<File>): Promise<FileAttachment[]> {
    const out: FileAttachment[] = [];
    for (const f of files) {
      const pending = this.createPending(f);
      const done = await this.readInto(f, pending);
      // Drop ephemeral blob preview once we have a stable data URL (or on error).
      if (done.previewUrl && (done.dataUrl || done.status === 'error')) {
        URL.revokeObjectURL(done.previewUrl);
        done.previewUrl = undefined;
      }
      out.push(done);
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

  /** Only ready attachments participate in the model prompt. */
  static readyOnly(attachments: FileAttachment[]): FileAttachment[] {
    return attachments.filter((a) => (a.status ?? 'ready') === 'ready');
  }

  /** True while any attachment is still being read. */
  static isReading(attachments: FileAttachment[]): boolean {
    return attachments.some((a) => a.status === 'reading');
  }

  /** Serialize attachments into markdown sections for the model prompt. */
  static formatForPrompt(attachments: FileAttachment[]): string {
    const ready = this.readyOnly(attachments);
    if (ready.length === 0) return '';
    const sections = ready.map((a) => {
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

  /** Revoke any blob: preview URLs held by attachments. */
  static revokePreviews(attachments: FileAttachment[]): void {
    for (const a of attachments) {
      if (a.previewUrl) {
        try {
          URL.revokeObjectURL(a.previewUrl);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
