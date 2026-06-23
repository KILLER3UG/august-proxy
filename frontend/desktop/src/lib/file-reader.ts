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

// ── Helpers ─────────────────────────────────────────────────────────────────
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function truncate(text: string, maxChars: number): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false };
  return { content: text.slice(0, maxChars) + '\n\n[... truncated — file exceeds 100 KB text limit]', truncated: true };
}

// ── PDF extraction ──────────────────────────────────────────────────────────
async function extractPdfText(file: File): Promise<{ content: string; truncated: boolean }> {
  // Dynamic import so the heavy pdf.js library is only loaded when needed
  const pdfjsLib = await import('pdfjs-dist');

  // Set the worker source to a CDN to avoid bundling issues
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await readFileAsArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const maxPages = Math.min(pdf.numPages, 50);
  const textParts: string[] = [];

  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item: any) => item.str).join(' ');
    textParts.push(`--- Page ${i} ---\n${pageText}`);
  }

  const fullText = textParts.join('\n\n');
  return truncate(fullText, TEXT_MAX_CHARS);
}

// ── DOCX extraction ─────────────────────────────────────────────────────────
async function extractDocxText(file: File): Promise<{ content: string; truncated: boolean }> {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const result = await mammoth.extractRawText({ arrayBuffer });
  return truncate(result.value, TEXT_MAX_CHARS);
}

// ── XLSX extraction ─────────────────────────────────────────────────────────
async function extractSpreadsheetText(file: File): Promise<{ content: string; truncated: boolean }> {
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    parts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
  }

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
export async function readFileContent(file: File): Promise<FileReadResult> {
  const ext = getExtension(file.name);
  const mimeType = file.type || '';

  // ── Images ──────────────────────────────────────────────────────────
  if (IMAGE_EXTENSIONS.has(ext) || IMAGE_MIMES.has(mimeType)) {
    if (file.size > IMAGE_MAX_SIZE) {
      return { type: 'image', dataUrl: await readFileAsDataUrl(file), mimeType, truncated: true };
    }
    return { type: 'image', dataUrl: await readFileAsDataUrl(file), mimeType };
  }

  // ── PDF ─────────────────────────────────────────────────────────────
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    try {
      const { content, truncated } = await extractPdfText(file);
      return { type: 'text', content, mimeType, truncated };
    } catch (err) {
      console.warn('[file-reader] PDF extraction failed:', err);
      return { type: 'unsupported', mimeType };
    }
  }

  // ── DOCX ────────────────────────────────────────────────────────────
  if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const { content, truncated } = await extractDocxText(file);
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
      const { content, truncated } = await extractSpreadsheetText(file);
      return { type: 'text', content, mimeType, truncated };
    } catch (err) {
      console.warn('[file-reader] Spreadsheet extraction failed:', err);
      return { type: 'unsupported', mimeType };
    }
  }

  // ── Plain text / code ───────────────────────────────────────────────
  if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith('text/')) {
    try {
      const raw = await readFileAsText(file);
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
      const raw = await readFileAsText(file);
      // Check if it looks like text (no null bytes in the first 512 bytes)
      const sample = raw.slice(0, 512);
      if (!sample.includes('\0')) {
        const { content, truncated } = truncate(raw, TEXT_MAX_CHARS);
        return { type: 'text', content, mimeType, truncated };
      }
    } catch (_) {}
  }

  return { type: 'unsupported', mimeType };
}
