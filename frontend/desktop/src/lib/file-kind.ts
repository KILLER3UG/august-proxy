/**
 * File-kind classification for the unified ChangesCard (plan §4.5).
 *
 * `classifyFileKind` lifts the old produced-files `kindLabel` mapping and
 * adds text/document kinds so `.md`/`.txt` read `Document · MD` instead of a
 * bare extension. `openFileInDrawer` is the shared open flow (right-drawer
 * viewer with reveal-in-folder fallback).
 */

import { openRightDrawerFile } from '@/components/shell/RightDrawerState';
import { ChatAttachmentService } from '@/sections/chat/services/ChatAttachmentService';
import { revealInFolder } from '@/lib/tauri-shell';
import { toast } from 'sonner';

export type FileKind = 'code' | 'document' | 'image' | 'video' | 'pdf';

export interface FileKindInfo {
  kind: FileKind;
  /** Row subtitle, e.g. `Document · MD`, `Image · PNG`. */
  label: string;
  /** Glyph for the square DocumentBadge, e.g. `M↓`, `PDF`. */
  badgeText: string;
  /** Badge tone — keyed off the kind. */
  badgeTone: FileKind;
}

const IMAGE_EXTS = new Set(['PNG', 'JPG', 'JPEG', 'SVG', 'WEBP', 'GIF', 'BMP', 'ICO']);
const VIDEO_EXTS = new Set(['MP4', 'MOV', 'WEBM', 'AVI', 'MKV']);
/** Document kinds keep the down-arrow glyph convention (document/download). */
const DOCUMENT_EXTS = new Set([
  'MD', 'TXT', 'RTF', 'DOC', 'DOCX', 'ODT', 'XLS', 'XLSX', 'CSV', 'TSV', 'PPT', 'PPTX',
]);

function extOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  const dot = base.lastIndexOf('.');
  // No dot, leading dot (.env), or trailing dot → treat as extensionless.
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toUpperCase();
}

/** Classify a file path into a ChangesCard row kind. */
export function classifyFileKind(path: string): FileKindInfo {
  const ext = extOf(path);
  if (!ext) return { kind: 'code', label: 'File', badgeText: 'F↓', badgeTone: 'code' };

  if (ext === 'PDF') {
    return { kind: 'pdf', label: 'PDF', badgeText: 'PDF', badgeTone: 'pdf' };
  }
  if (IMAGE_EXTS.has(ext)) {
    return { kind: 'image', label: `Image · ${ext}`, badgeText: 'IMG', badgeTone: 'image' };
  }
  if (VIDEO_EXTS.has(ext)) {
    return { kind: 'video', label: `Video · ${ext}`, badgeText: 'VID', badgeTone: 'video' };
  }
  if (ext === 'HTML' || ext === 'HTM') {
    return { kind: 'document', label: 'Interactive · HTML', badgeText: 'H↓', badgeTone: 'document' };
  }
  if (ext === 'PPTX' || ext === 'PPT') {
    return { kind: 'document', label: `Presentation · ${ext}`, badgeText: 'P↓', badgeTone: 'document' };
  }
  if (ext === 'XLSX' || ext === 'XLS' || ext === 'CSV' || ext === 'TSV') {
    return { kind: 'document', label: `Spreadsheet · ${ext}`, badgeText: 'X↓', badgeTone: 'document' };
  }
  if (DOCUMENT_EXTS.has(ext)) {
    return { kind: 'document', label: `Document · ${ext}`, badgeText: `${ext[0]}↓`, badgeTone: 'document' };
  }
  // Code rows normally show a FileIcon instead of a badge; this text is only
  // used when a code file temporarily renders document-style (no diff yet).
  return { kind: 'code', label: ext, badgeText: ext.slice(0, 3), badgeTone: 'code' };
}

/**
 * Open a produced file in the right-drawer viewer (Claude-style deliverable
 * panel); falls back to revealing the file in the OS file manager when the
 * attachment service cannot load it. Errors surface as a toast only.
 *
 * Read order: Tauri FS invoke → backend `/api/workbench/files/read` (dev /
 * backend-only runs have no desktop FS API) → reveal in folder.
 */
export async function openFileInDrawer(path: string, sessionId?: string): Promise<void> {
  try {
    let attachment = await ChatAttachmentService.fromPath(path);
    if (!attachment) {
      attachment = await ChatAttachmentService.fromBackendPath(path, sessionId);
    }
    if (attachment) {
      openRightDrawerFile(attachment);
    } else {
      await revealInFolder(path);
    }
  } catch (err) {
    toast.error('Could not open file');
    console.warn('[file-kind] open failed:', err);
  }
}
