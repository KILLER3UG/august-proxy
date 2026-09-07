/* ── ChatAttachmentService ────────────────────────────────────────────── */
/* Reads files and clipboard images into FileAttachment[] for the composer. */

import { isImageFile, readFileContent, type FileReadResult } from '@/lib/file-reader';
import { api } from '@/api/client';
import { toast } from 'sonner';
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

/** Paste becomes a .txt attachment at or above this character count. */
export const LONG_PASTE_CHAR_THRESHOLD = 2000;
/** Or when the paste has at least this many lines (whichever hits first). */
export const LONG_PASTE_LINE_THRESHOLD = 40;

export class ChatAttachmentService {
  /** Highlight language for fenced blocks in the user prompt. */
  static codeLangFor(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return CODE_LANG_MAP[ext] ?? '';
  }

  /** True when clipboard plain text is large enough to attach as a file. */
  static isLongPasteText(text: string): boolean {
    if (!text) return false;
    if (text.length >= LONG_PASTE_CHAR_THRESHOLD) return true;
    let lines = 1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) lines++;
    }
    return lines >= LONG_PASTE_LINE_THRESHOLD;
  }

  /** Filename for a long paste converted to an attachment. */
  static pastedTextFilename(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `pasted-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`
    );
  }

  /** Build a text/plain File from pasted clipboard text. */
  static textFileFromPaste(text: string, name?: string): File {
    return new File([text], name || this.pastedTextFilename(), {
      type: 'text/plain',
      lastModified: Date.now(),
    });
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
        mimeType: result.mimeType || file.type || undefined,
        thumbnailUrl: result.thumbnailUrl,
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

  /** Build an attachment from a real filesystem path (Tauri drag-drop).
   *  The webview only receives the path from drop events — bytes are read
   *  via the shell's read_file_base64 command, and the attachment keeps
   *  its source ``path`` so tools that need the real file can find it. */
  static async fromPath(path: string): Promise<FileAttachment | null> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<{ ok: boolean; data: string; name: string; path: string }>(
        'read_file_base64',
        { path },
      );
      const binary = atob(res.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], res.name, { lastModified: Date.now() });
      const pending = this.createPending(file);
      pending.path = res.path;
      const done = await this.readInto(file, pending);
      // Drop ephemeral blob preview once we have a stable data URL (or on error).
      if (done.previewUrl && (done.dataUrl || done.status === 'error')) {
        URL.revokeObjectURL(done.previewUrl);
        done.previewUrl = undefined;
      }
      return done;
    } catch (err) {
      console.warn('[attachments] path read failed:', err);
      return null;
    }
  }

  /** Build an attachment from a filesystem path via the backend read route.
   *  Fallback for dev / backend-only runs where the Tauri FS API is not
   *  available (``invoke('read_file_base64')`` throws outside the desktop
   *  shell). Mirrors ``fromPath`` — same pending/readInto pipeline. */
  static async fromBackendPath(path: string, sessionId?: string): Promise<FileAttachment | null> {
    try {
      const qs = new URLSearchParams({ path });
      if (sessionId) qs.set('sessionId', sessionId);
      const res = await api.get<{
        ok: boolean;
        data: string;
        name: string;
        path: string;
        mimeType: string;
      }>(`/api/workbench/files/read?${qs.toString()}`);
      if (!res?.ok || !res.data) return null;
      const binary = atob(res.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], res.name, {
        type: res.mimeType || undefined,
        lastModified: Date.now(),
      });
      const pending = this.createPending(file);
      pending.path = res.path;
      const done = await this.readInto(file, pending);
      // Drop ephemeral blob preview once we have a stable data URL (or on error).
      if (done.previewUrl && (done.dataUrl || done.status === 'error')) {
        URL.revokeObjectURL(done.previewUrl);
        done.previewUrl = undefined;
      }
      return done;
    } catch (err) {
      console.warn('[attachments] backend path read failed:', err);
      return null;
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

  /**
   * Upload ready attachments into the session workspace so the agent can
   * actually open them — before this the bytes never left the client and
   * analyze_media could only say "File not found". Images upload their data
   * URL bytes; text files upload their extracted content. Mutates each
   * uploaded attachment with `savedPath`. On failure the prompt keeps the
   * placeholder — the caller surfaces one toast so the user isn't left
   * thinking the model can see the file.
   */
  static async uploadImages(
    workbenchSessionId: string,
    attachments: FileAttachment[],
    workspacePath?: string,
  ): Promise<void> {
    if (!workbenchSessionId) return;
    const pending = attachments.filter(
      (a) =>
        a.status === 'ready' &&
        !a.savedPath &&
        ((a.type === 'image' && a.dataUrl) || (a.type === 'text' && a.content)),
    );
    if (pending.length === 0) return;
    let failed = 0;
    await Promise.all(
      pending.map(async (a) => {
        try {
          // Image bytes ride the data URL; text files send their extracted
          // content as a data URL so the backend stores real file bytes.
          const payload =
            a.type === 'image'
              ? a.dataUrl
              : `data:text/plain;base64,${btoa(unescape(encodeURIComponent(a.content ?? '')))}`;
          const res = await api.post<{ ok?: boolean; path?: string }>(
            '/api/workbench/attachments',
            {
              sessionId: workbenchSessionId,
              name: a.name,
              dataUrl: payload,
              ...(workspacePath ? { workspace: workspacePath } : {}),
            },
          );
          if (res?.ok && res.path) a.savedPath = res.path;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }),
    );
    if (failed > 0) {
      toast.error(
        `Could not store ${failed} attachment${failed === 1 ? '' : 's'} — the model may not be able to open ${failed === 1 ? 'it' : 'them'}`,
      );
    }
  }

  /** Serialize attachments into markdown sections for the model prompt. */
  static formatForPrompt(attachments: FileAttachment[]): string {
    const ready = this.readyOnly(attachments);
    if (ready.length === 0) return '';
    const sections = ready.map((a) => {
      const header = `📄 **${a.name}**`;
      // An uploaded attachment is a real workspace file — name the path so
      // analyze_media/read_file can open it (and skip the inline text dump:
      // the file is on disk now, inlining both would double the tokens).
      if (a.savedPath) {
        const kind = a.type === 'image' ? 'vision description' : 'contents';
        return `${header}\n[Attached file — stored at ${a.savedPath}. Open it with analyze_media (${kind}) or read_file.]`;
      }
      if (a.type === 'text' && a.content) {
        const lang = this.codeLangFor(a.name);
        return `${header}\n\`\`\`${lang}\n${a.content}\n\`\`\``;
      }
      if (a.type === 'image') {
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

  /**
   * Strip attachment prompt sections from stored message content so the bubble
   * can show file cards instead of the raw model dump (legacy messages).
   */
  static stripPromptSections(content: string): string {
    if (!content) return '';
    let out = content;
    // 📄 **name** + fenced body
    out = out.replace(/\n*\n---\n\n📄 \*\*[^*]+\*\*\n```[\s\S]*?```/g, '');
    // 📄 **name** + bracketed placeholder (images / unsupported)
    out = out.replace(/\n*\n---\n\n📄 \*\*[^*]+\*\*\n\[[^\]]*\]/g, '');
    // Orphan leading --- separators left behind
    out = out.replace(/^\s*---\s*/g, '');
    return out.trim();
  }

  /** Display text for a user bubble: typed text only when attachments exist. */
  static displayText(content: string, attachments?: FileAttachment[]): string {
    if (attachments && attachments.length > 0) {
      return this.stripPromptSections(content);
    }
    return content;
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
