/* ── Universal file reader ─ extract text from any file type ──────── */
/* Provides browser-side content extraction so the AI model can read   */
/* attached files. Supports plain text, PDF, DOCX, XLSX, and images.  */

import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

// ── Limits ──────────────────────────────────────────────────────────────────
const TEXT_MAX_CHARS = 100_000;   // 100 KB of extracted text
const IMAGE_MAX_SIZE = 10 * 1024 * 1024; // 10 MB for images

// ── Types ───────────────────────────────────────────────────────────────────
export type FileReadType = 'text' | 'image' | 'unsupported';

export interface FileReadResult {
  type: FileReadType;
  /** Extracted text content (for text-type files). */
  content?: string;
  /** Base64 data URL (for image files). */
  dataUrl?: string;
  /** First-page thumbnail data URL (PDFs); UI preview only. */
  thumbnailUrl?: string;
  /** MIME type of the original file. */
  mimeType: string;
  /** True if content was truncated to stay within limits. */
  truncated?: boolean;
}

// ── Extension → category mapping ────────────────────────────────────────────
const TEXT_EXTENSIONS = new Set([
  // Plain text / code
  'txt', 'md', 'mdx', 'csv', 'tsv', 'json', 'jsonc', 'json5',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'dart',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'php', 'scala',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'lua', 'pl', 'hs', 'clj', 'ex', 'exs',
  'html', 'htm', 'xhtml', 'svg', 'css', 'scss', 'sass', 'less',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'sql', 'graphql', 'proto',
  'dockerfile', 'makefile', 'cmake',
  'gitignore', 'gitattributes', 'editorconfig',
  'env', 'log',
  // Misc text
  'rst', 'adoc', 'tex', 'latex',
]);

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'avif', 'ico', 'svg',
]);

const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'image/bmp', 'image/tiff', 'image/svg+xml', 'image/avif',
]);

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return '';
  return filename.slice(dot + 1).toLowerCase();
}

// ── Progress ────────────────────────────────────────────────────────────────
export type FileReadProgress = (pct: number) => void;

/** Map FileReader load progress (0–1 of file bytes) into a sub-range. */
function scaleProgress(loaded: number, total: number, from: number, to: number): number {
  if (!total || total <= 0) return from;
  const t = Math.min(1, Math.max(0, loaded / total));
  return Math.round(from + t * (to - from));
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function readFileAsText(file: File, onProgress?: FileReadProgress): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(scaleProgress(e.loaded, e.total, 0, 90));
    };
    reader.onload = () => {
      onProgress?.(100);
      resolve(reader.result as string);
    };
    reader.onerror = () => reject(new Error(String(reader.error ?? 'FileReader error')));
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file: File, onProgress?: FileReadProgress): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(scaleProgress(e.loaded, e.total, 0, 95));
    };
    reader.onload = () => {
      onProgress?.(100);
      resolve(reader.result as string);
    };
    reader.onerror = () => reject(new Error(String(reader.error ?? 'FileReader error')));
    reader.readAsDataURL(file);
  });
}

function readFileAsArrayBuffer(file: File, onProgress?: FileReadProgress): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(scaleProgress(e.loaded, e.total, 0, 70));
    };
    reader.onload = () => {
      onProgress?.(70);
      resolve(reader.result as ArrayBuffer);
    };
    reader.onerror = () => reject(new Error(String(reader.error ?? 'FileReader error')));
    reader.readAsArrayBuffer(file);
  });
}

function truncate(text: string, maxChars: number): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false };
  return { content: text.slice(0, maxChars) + '\n\n[... truncated — file exceeds 100 KB text limit]', truncated: true };
}

// ── PDF extraction ──────────────────────────────────────────────────────────
async function renderPdfThumbnail(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdf: { getPage: (n: number) => Promise<any> },
): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined;
  try {
    const page = await pdf.getPage(1);
    // Target ~160px-wide card; scale from PDF default viewport.
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 160 / Math.max(base.width, 1));
    const viewport = page.getViewport({ scale: Math.max(scale, 0.5) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch (err) {
    console.warn('[file-reader] PDF thumbnail failed:', err);
    return undefined;
  }
}

async function extractPdfText(
  file: File,
  onProgress?: FileReadProgress,
): Promise<{ content: string; truncated: boolean; thumbnailUrl?: string }> {
  // Dynamic import so the heavy pdf.js library is only loaded when needed
  const pdfjsLib = await import('pdfjs-dist');

  // Set the worker source to a CDN to avoid bundling issues
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await readFileAsArrayBuffer(file, onProgress);
  onProgress?.(75);
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const thumbnailUrl = await renderPdfThumbnail(pdf);
  onProgress?.(78);
  const maxPages = Math.min(pdf.numPages, 50);
  const textParts: string[] = [];

  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item: Record<string, unknown>) => {
      const str = item.str;
      return typeof str === 'string' ? str : '';
    }).join(' ');
    textParts.push(`--- Page ${i} ---\n${pageText}`);
    onProgress?.(scaleProgress(i, maxPages, 78, 98));
  }

  const fullText = textParts.join('\n\n');
  onProgress?.(100);
  const truncated = truncate(fullText, TEXT_MAX_CHARS);
  return { ...truncated, thumbnailUrl };
}

// ── DOCX extraction ─────────────────────────────────────────────────────────
async function extractDocxText(
  file: File,
  onProgress?: FileReadProgress,
): Promise<{ content: string; truncated: boolean }> {
  const arrayBuffer = await readFileAsArrayBuffer(file, onProgress);
  onProgress?.(85);
  const result = await mammoth.extractRawText({ arrayBuffer });
  onProgress?.(100);
  return truncate(result.value, TEXT_MAX_CHARS);
}

// ── XLSX extraction ─────────────────────────────────────────────────────────
async function extractSpreadsheetText(
  file: File,
  onProgress?: FileReadProgress,
): Promise<{ content: string; truncated: boolean }> {
  const arrayBuffer = await readFileAsArrayBuffer(file, onProgress);
  onProgress?.(85);
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    parts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
  }

  onProgress?.(100);
  return truncate(parts.join('\n\n'), TEXT_MAX_CHARS);
}

// ── Main API ────────────────────────────────────────────────────────────────
/**
 * Read a file and extract its content in a format the AI model can consume.
 *
 * - **Text files**: returns extracted plain text (code, CSV, JSON, etc.)
 * - **PDF**: extracts text page-by-page (up to 50 pages)
 * - **DOCX**: extracts raw text via mammoth
 * - **XLSX/CSV**: extracts as CSV per sheet
 * - **Images**: returns a base64 data URL for vision analysis
 * - **Other**: returns `{ type: 'unsupported' }`
 */
export async function readFileContent(
  file: File,
  onProgress?: FileReadProgress,
): Promise<FileReadResult> {
  const ext = getExtension(file.name);
  const mimeType = file.type || '';

  // ── Images ──────────────────────────────────────────────────────────
  if (IMAGE_EXTENSIONS.has(ext) || IMAGE_MIMES.has(mimeType)) {
    if (file.size > IMAGE_MAX_SIZE) {
      return {
        type: 'image',
        dataUrl: await readFileAsDataUrl(file, onProgress),
        mimeType,
        truncated: true,
      };
    }
    return {
      type: 'image',
      dataUrl: await readFileAsDataUrl(file, onProgress),
      mimeType,
    };
  }

  // ── PDF ─────────────────────────────────────────────────────────────
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    try {
      const { content, truncated, thumbnailUrl } = await extractPdfText(file, onProgress);
      return { type: 'text', content, mimeType, truncated, thumbnailUrl };
    } catch (err) {
      console.warn('[file-reader] PDF extraction failed:', err);
      return { type: 'unsupported', mimeType };
    }
  }

  // ── DOCX ────────────────────────────────────────────────────────────
  if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const { content, truncated } = await extractDocxText(file, onProgress);
      return { type: 'text', content, mimeType, truncated };
    } catch (err) {
      console.warn('[file-reader] DOCX extraction failed:', err);
      return { type: 'unsupported', mimeType };
    }
  }

  // ── XLSX / XLS ─────────────────────────────────────────────────────
  if (ext === 'xlsx' || ext === 'xls' || ext === 'ods' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel') {
    try {
      const { content, truncated } = await extractSpreadsheetText(file, onProgress);
      return { type: 'text', content, mimeType, truncated };
    } catch (err) {
      console.warn('[file-reader] Spreadsheet extraction failed:', err);
      return { type: 'unsupported', mimeType };
    }
  }

  // ── Plain text / code ───────────────────────────────────────────────
  if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith('text/')) {
    try {
      const raw = await readFileAsText(file, onProgress);
      const { content, truncated } = truncate(raw, TEXT_MAX_CHARS);
      return { type: 'text', content, mimeType, truncated };
    } catch (err) {
      console.warn('[file-reader] Text extraction failed:', err);
      return { type: 'unsupported', mimeType };
    }
  }

  // ── Try reading as text as a fallback ───────────────────────────────
  if (file.size < 500 * 1024) {
    try {
      const raw = await readFileAsText(file, onProgress);
      // Check if it looks like text (no null bytes in the first 512 bytes)
      const sample = raw.slice(0, 512);
      if (!sample.includes('\0')) {
        const { content, truncated } = truncate(raw, TEXT_MAX_CHARS);
        return { type: 'text', content, mimeType, truncated };
      }
    } catch { /* silent */ }
  }

  onProgress?.(100);
  return { type: 'unsupported', mimeType };
}

/** True when a File is likely an image (for immediate preview while reading). */
export function isImageFile(file: File): boolean {
  const ext = getExtension(file.name);
  return IMAGE_EXTENSIONS.has(ext) || IMAGE_MIMES.has(file.type);
}
