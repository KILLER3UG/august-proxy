/* ── RightDrawerFileSection ─ focused attachment/document preview ───── */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  FileWarning,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { getFileIcon } from '@/lib/file-icon';
import { usePreferencesStore } from '@/lib/preferences';
import { copyFilesToDir, revealInFolder, selectDirectory } from '@/lib/tauri-shell';
import { isTauri } from '@/lib/tauri-detect';
import { cn } from '@/lib/utils';
import { backendOriginSync } from '@/api/client';
import { PdfPager } from './PdfPager';
import { closeRightDrawer, useRightDrawerStore } from './RightDrawerState';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import type { FileAttachment } from '@/types/chat';

const MAX_PREVIEW_LINES = 5000;

function TextPreview({ content }: { content: string }) {
  const allLines = content.split('\n');
  const lines = allLines.slice(0, MAX_PREVIEW_LINES);
  const truncated = lines.length < allLines.length;

  return (
    <div className="min-h-full bg-sunken py-3 font-mono text-[0.75rem] leading-6 text-foreground/90">
      {lines.map((line, index) => (
        <div key={index} className="grid grid-cols-[3.5rem_minmax(0,1fr)] px-4 hover:bg-white/[0.035]">
          <span className="select-none pr-4 text-right text-muted-foreground/45">{index + 1}</span>
          <span className="whitespace-pre-wrap break-words pr-4">{line || ' '}</span>
        </div>
      ))}
      {truncated && (
        <div className="mt-3 border-t border-border/50 px-4 pt-3 text-xs text-muted-foreground">
          Preview limited to the first {MAX_PREVIEW_LINES.toLocaleString()} lines.
        </div>
      )}
    </div>
  );
}

/** Which canvas a file renders in the viewer (shared by the canvas and the
 *  header view-mode toggle so both always agree on what is available). */
function describePreview(file: FileAttachment): {
  isImage: boolean;
  hasText: boolean;
  isHtml: boolean;
  isSvg: boolean;
  isMarkdown: boolean;
  isPdf: boolean;
} {
  const hasText = file.type === 'text' && typeof file.content === 'string';
  const isHtml =
    hasText && /\.(html?|xhtml)$/i.test(file.name || '') &&
    /<\/html|<!doctype html|<body/i.test(file.content ?? '');
  // A standalone SVG is a live *document* (its <script> runs) — the Anatomy
  // figures the artifact route exists for. Only as a text-type attachment;
  // an image-type SVG (bytes in the webview) stays an <img>, which is what
  // a picture should be.
  const isSvg = hasText && /\.svg$/i.test(file.name || '');
  const isMarkdown =
    hasText && /\.(md|markdown|mdown|mkdn|mdx)$/i.test(file.name || '');
  const isImage = file.type === 'image' && !!(file.dataUrl || file.previewUrl);
  // A PDF is readable page-by-page only when its bytes are in the webview
  // (data: or http(s) URL). The extracted text alone can't paginate, so a PDF
  // with neither falls through to the text view. `file-reader.ts` now keeps
  // those bytes for any PDF under its inline ceiling — before that, nothing but
  // the design lab's fixture ever carried a PDF data URL, so this branch was
  // unreachable in the shipped app and every real PDF opened as its text dump.
  // The mime test is the second door: a PDF that arrived without the extension
  // would otherwise land in the generic `<img src={dataUrl}>` fallback below.
  const isPdf =
    (/\.pdf$/i.test(file.name || '') || file.mimeType === 'application/pdf') &&
    !!(file.dataUrl || file.previewUrl);
  return { isImage, hasText, isHtml, isSvg, isMarkdown, isPdf };
}

/** The artifact route that serves a live document from the backend's own
 *  origin, or null when this file must stay a static render.
 *
 *  Provenance, not extension, decides: `savedPath` marks a file the session
 *  uploaded through the composer door and `sessionAuthored` one opened from a
 *  deliverable/artifact card (`openFileInDrawer`). The default (`auto`) goes
 *  live only for those. A file the user dragged in or picked has only `path`
 *  and renders statically unless the preference says otherwise. */
function liveArtifactUrl(file: FileAttachment, pref: 'auto' | 'on' | 'off'): string | null {
  const docPath = file.savedPath || file.path || '';
  if (!docPath) return null;
  const wantLive = pref === 'on' || (pref === 'auto' && (!!file.savedPath || !!file.sessionAuthored));
  if (!wantLive) return null;
  // backendOriginSync() is null in a plain web run (same-origin Vite proxy) —
  // a relative URL is correct there. In Tauri it is the discovered sidecar
  // base (http://127.0.0.1:<port>), a DIFFERENT origin from the shell, which
  // is the whole point: the response's own CSP applies instead of the shell's.
  const base = backendOriginSync() ?? '';
  return `${base}/api/workbench/artifact/html?path=${encodeURIComponent(docPath)}`;
}

/** The zoom-scaled preview body — rendered identically in the drawer pane
 *  and in the fullscreen overlay so both views always agree. The preview /
 *  source choice comes from the header toggle (`showSource`). */
function PreviewCanvas({ file, zoom, showSource }: { file: FileAttachment; zoom: number; showSource: boolean }) {
  const imageSrc = file.dataUrl || file.previewUrl;
  const { isImage, isHtml, isSvg, isMarkdown, isPdf } = describePreview(file);
  const livePref = usePreferencesStore((s) => s.liveHtmlPreview);
  const liveUrl = (isHtml || isSvg) ? liveArtifactUrl(file, livePref) : null;
  const hasText = file.type === 'text' && typeof file.content === 'string';
  const pdfSrc = file.dataUrl || file.previewUrl;
  // The PDF branch zooms by RE-RENDERING at the new width (see PdfPager): a CSS
  // scale over an already-rasterized page magnifies the bitmap, so 200% bought
  // softness rather than detail. Text source mode keeps the box transform — it
  // has no raster to re-render, and shrinking the card would be the surprise.
  const zoomsByRender = isPdf && !!pdfSrc && !showSource;

  return (
    <div
      style={
        zoomsByRender
          ? undefined
          : { transform: `scale(${zoom})`, transformOrigin: 'top left' }
      }
      className={zoomsByRender ? 'contents' : zoom !== 1 ? 'h-full w-full' : 'contents'}
    >
      {isImage ? (
        <div className="flex min-h-full items-center justify-center bg-sunken p-6">
          <img
            src={imageSrc}
            alt={file.name}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        </div>
      ) : isPdf && pdfSrc ? (
        // Rendered = page-by-page pdf.js; source = the extracted text the model
        // reads. Both stay reachable: the 50-page text extraction feeds the
        // model and must not disappear behind the pager.
        <div className="flex h-full min-h-full flex-col bg-background" data-testid="file-preview-pdf">
          {showSource ? (
            <TextPreview content={file.content ?? ''} />
          ) : (
            <PdfPager src={pdfSrc} label={file.name} zoom={zoom} className="flex-1" />
          )}
        </div>
      ) : isHtml || isSvg ? (
        <div className="flex h-full min-h-full flex-col bg-background" data-testid="file-preview-html-live">
          {showSource ? (
            <TextPreview content={file.content ?? ''} />
          ) : liveUrl ? (
            // Live document: served from the backend origin under the route's
            // own document-scoped CSP, so inline script runs HERE while the
            // shell CSP stays `script-src 'self'`. `allow-scripts` WITHOUT
            // `allow-same-origin` — an opaque origin cannot read the parent
            // window or reach the Tauri IPC bridge. (The Surfer embed's
            // `allow-same-origin` is a different case: a genuinely foreign
            // https origin, not an opaque one — do not copy it here.)
            <iframe
              title={`Live preview of ${file.name}`}
              sandbox="allow-scripts"
              src={liveUrl}
              className="min-h-[24rem] w-full flex-1 border-0 bg-white dark:bg-sunken"
              data-testid="file-preview-html-live-iframe"
            />
          ) : (
            // Static fallback: an arbitrary file the user opened (no session
            // provenance) renders inert — full sandbox, no script — exactly
            // like a pasted attachment always did.
            <iframe
              title={`HTML preview of ${file.name}`}
              sandbox=""
              srcDoc={file.content ?? ''}
              className="min-h-[24rem] w-full flex-1 border-0 bg-white dark:bg-sunken"
            />
          )}
        </div>
      ) : isMarkdown ? (
        <div className="flex h-full min-h-full flex-col bg-background" data-testid="file-preview-markdown">
          {showSource ? (
            <TextPreview content={file.content ?? ''} />
          ) : (
            <div className="flex-1 overflow-y-auto px-6 py-5 chat-scroll select-text">
              <div className="markdown-content max-w-none">
                {/* Deliberately NOT `demoteHeadings`, unlike the settings dialog
                    and the drafted-skill preview. This pane is the file: the user
                    opened it to read it, the adjacent toggle shows its raw text
                    with `# Title` on line one, and a shifted heading here would
                    make the render disagree with the source it is next to. The
                    demotion rule exists for authored documents shown as content
                    *under* another surface, and this surface is the document. */}
                <Markdown content={file.content ?? ''} />
              </div>
            </div>
          )}
        </div>
      ) : hasText ? (
        <TextPreview content={file.content ?? ''} />
      ) : file.dataUrl || file.previewUrl ? (
        <iframe
          src={file.dataUrl || file.previewUrl}
          title={`Preview of ${file.name}`}
          className="h-full min-h-[24rem] w-full border-0 bg-background"
        />
      ) : (
        <div className="flex h-full min-h-[24rem] flex-col items-center justify-center px-8 text-center">
          {file.status === 'error' ? (
            <FileWarning className="size-9 text-destructive/70" />
          ) : (
            <ImageIcon className="size-9 text-muted-foreground/45" />
          )}
          <div className="mt-3 text-sm font-medium text-foreground">
            {file.status === 'error' ? 'This file could not be read' : 'Preview unavailable'}
          </div>
          <div className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
            {file.error || 'The file is attached, but there is no inline viewer for this file type.'}
          </div>
        </div>
      )}
    </div>
  );
}

/** Header preview/source toggle (Eye = rendered preview, Code2 = source).
 *  Supports HTML/SVG live previews and Markdown rich document rendering. */
function ViewModeToggle({
  file,
  isHtml,
  isSvg,
  isMarkdown,
  isPdf,
  showSource,
  setShowSource,
}: {
  file: FileAttachment;
  isHtml: boolean;
  isSvg: boolean;
  isMarkdown: boolean;
  isPdf: boolean;
  showSource: boolean;
  setShowSource: (v: boolean) => void;
}) {
  // The Eye now targets the PDF pager too, so a PDF has a rendered view.
  const hasRenderable = isHtml || isSvg || isMarkdown || isPdf;
  const ext = file.name.split('.').pop()?.toUpperCase() ?? '';
  // Office formats have no client-side renderer and we do not add a LibreOffice
  // dependency for them — say so plainly rather than promising a preview that
  // only exists where soffice happens to be installed.
  const OFFICE = new Set(['PPT', 'PPTX', 'DOC', 'DOCX', 'XLS', 'XLSX', 'ODT', 'ODS', 'ODP']);
  const noPreviewTip = OFFICE.has(ext)
    ? `No rendered preview for ${ext} — the source text is available`
    : 'No rendered preview for this file type';
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => setShowSource(false)}
        disabled={!hasRenderable}
        aria-pressed={hasRenderable && !showSource}
        aria-label="Show rendered preview"
        title={hasRenderable ? 'Rendered preview' : noPreviewTip}
        data-testid="html-preview-tab-render"
        className={cn(
          'rounded-md p-1.5 transition',
          hasRenderable
            ? 'text-muted-foreground hover:bg-muted/50 hover:text-foreground cursor-pointer'
            : 'cursor-not-allowed text-muted-foreground/35',
          hasRenderable && !showSource && 'bg-muted/60 text-foreground',
        )}
      >
        <Eye className="size-3" />
      </button>
      <button
        type="button"
        onClick={() => setShowSource(true)}
        aria-pressed={showSource}
        aria-label="Show source code"
        title="Source code"
        data-testid="html-preview-tab-source"
        className={cn(
          'rounded-md p-1.5 transition text-muted-foreground hover:bg-muted/50 hover:text-foreground cursor-pointer',
          showSource && 'bg-muted/60 text-foreground',
        )}
      >
        <Code2 className="size-3" />
      </button>
    </div>
  );
}

/** Copy the document's text.
 *
 *  A `Button` primitive rather than a hand-rolled one so the strip has a focus
 *  ring like every other control in the app: this button, and the zoom buttons
 *  beside it, were the only ones in the drawer that a keyboard user could land
 *  on with no visible focus. */
function CopyFileButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      return; // a rejected write must not report success
    }
    setCopied(true);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => { void copy(); }}
      title={copied ? 'Copied to clipboard' : 'Copy content'}
      aria-label="Copy content"
      data-testid="file-preview-copy"
      className="gap-1 text-muted-foreground"
    >
      {copied ? <Check className="text-success" /> : <Copy />}
      <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
    </Button>
  );
}

/** Save a copy of the document the viewer is showing.
 *
 *  The viewer's control set had truncation badge, preview/source toggle, copy,
 *  zoom, fullscreen and close — and no save, so the only way to get a produced
 *  file out of August was the Artifacts panel, one surface away, or the
 *  transcript row that said "Download" and opened the drawer instead. The
 *  desktop copy path already existed for the panel's "Download all"; this is
 *  the same three calls for one file, so the file is copied by the Rust side
 *  and its bytes never cross the webview.
 *
 *  `savedPath || path` is the ON-DISK location, never `dataUrl`/`previewUrl`:
 *  those are base64 in the webview, and copying one would need exactly the
 *  byte marshalling the Rust path exists to avoid. A file with neither is a
 *  paste/upload that only exists in the transcript, and the message says so
 *  instead of opening a picker that cannot produce anything. */
function SaveFileButton({ file }: { file: FileAttachment }) {
  const [saved, setSaved] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const save = async () => {
    const sourcePath = file.savedPath || file.path || '';
    if (!sourcePath) {
      toast.message(`“${file.name}” has no file on disk to save — it arrived inline.`);
      return;
    }
    if (!isTauri) {
      toast.message('Saving needs the desktop build — open August to copy this file into a folder.');
      return;
    }
    const dest = await selectDirectory();
    if (!dest) return; // the user cancelled the picker; silence is the answer
    const report = await copyFilesToDir(dest, [sourcePath]);
    if (!report || report.copied === 0) {
      toast.error(`Could not save “${file.name}”`);
      return;
    }
    setSaved(true);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setSaved(false), 2000);
    toast.success(`Saved ${file.name}`);
    await revealInFolder(dest);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => { void save(); }}
      title={saved ? 'Saved to the folder you picked' : 'Save a copy to a folder you pick'}
      aria-label="Save a copy"
      data-testid="file-preview-save"
      className="gap-1 text-muted-foreground"
    >
      {saved ? <Check className="text-success" /> : <Download />}
      <span className="hidden sm:inline">{saved ? 'Saved' : 'Save'}</span>
    </Button>
  );
}

function ZoomControls({ zoom, setZoom }: { zoom: number; setZoom: (fn: (z: number) => number) => void }) {
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
        title="Zoom out"
        data-testid="file-preview-zoom-out"
        className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
      >
        <Minus className="size-3" />
      </button>
      <span
        className="min-w-[3rem] text-center text-2xs tabular-nums text-muted-foreground"
        data-testid="file-preview-zoom-level"
      >
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        onClick={() => setZoom((z) => Math.min(5, z + 0.25))}
        title="Zoom in"
        data-testid="file-preview-zoom-in"
        className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
      >
        <Plus className="size-3" />
      </button>
    </>
  );
}

export function RightDrawerFileSection({ file, bare = false }: { file: FileAttachment; bare?: boolean }) {
  const fileIcon = getFileIcon(file.name);
  const Icon = fileIcon.Icon;
  // Claude-style viewer: zoom applies to the image/iframe canvas.
  const [zoom, setZoom] = useState(1);
  // ⤢ expands the preview into a full-window overlay (Esc / ⤡ exits).
  const [fullscreen, setFullscreen] = useState(false);
  // Preview-vs-source choice, lifted here so the header toggle and the
  // canvas (drawer + fullscreen) share one state.
  const { hasText, isHtml, isSvg, isMarkdown, isPdf } = describePreview(file);
  const [showSource, setShowSource] = useState(false);
  /* The reference's panel carries a muted line of prose under the content —
     the producing tool's own words about the artifact. It lives in the
     drawer state beside the file, so the file view shows it and nothing
     else carries it. */
  const caption = useRightDrawerStore((s) => s.artifactCaption);
  useEffect(() => {
    setShowSource(false);
  }, [file.id, file.name]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setFullscreen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // In bare mode the OUTER drawer header already shows the filename + close,
  // so this renders only the viewer's controls on a slim bar — one title bar
  // for one document, the way a Claude artifact reads. Fullscreen always keeps
  // its own full header: it is a separate window-sized surface.
  const controls = (
    <>
      {file.truncated && (
        <span className="rounded border border-warning/30 bg-warning/10 px-2 py-1 text-2xs text-warning">
          Truncated
        </span>
      )}
      {hasText && (
        <ViewModeToggle file={file} isHtml={isHtml} isSvg={isSvg} isMarkdown={isMarkdown} isPdf={isPdf} showSource={showSource} setShowSource={setShowSource} />
      )}
      {hasText && file.content && (
        <CopyFileButton content={file.content} />
      )}
      <SaveFileButton file={file} />
      <ZoomControls zoom={zoom} setZoom={setZoom} />
      <button
        type="button"
        onClick={() => setFullscreen(true)}
        title="Fullscreen preview"
        aria-label="Fullscreen preview"
        data-testid="file-preview-fullscreen"
        className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground cursor-pointer"
      >
        <Maximize2 className="size-3" />
      </button>
      {!bare && (
        <button
          type="button"
          onClick={closeRightDrawer}
          title="Close preview" aria-label="Close preview"
          data-testid="file-preview-close"
          className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground cursor-pointer"
        >
          <X className="size-4" />
        </button>
      )}
    </>
  );

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-background" data-testid="right-drawer-file-preview">
        {bare ? (
          // Controls-only bar; the filename lives in the drawer header above.
          <div className="flex h-10 shrink-0 items-center justify-end gap-2.5 border-b border-border/60 px-3">
            {controls}
          </div>
        ) : (
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 bg-card/70 px-4">
            <Icon size={17} color={fileIcon.color} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">{file.name}</div>
              <div className="text-2xs text-muted-foreground/70">
                {file.size || 'Attached file'}
              </div>
            </div>
            {controls}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          <PreviewCanvas file={file} zoom={zoom} showSource={showSource} />
        </div>
        {caption ? (
          <p
            className="shrink-0 border-t border-border/60 px-4 py-2 text-2xs leading-relaxed text-muted-foreground"
            data-testid="file-preview-caption"
          >
            {caption}
          </p>
        ) : null}
      </div>

      {fullscreen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex flex-col bg-background"
            role="dialog"
            aria-label={`Fullscreen preview of ${file.name}`}
            data-testid="file-preview-overlay"
          >
            <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 bg-card/70 px-4">
              <Icon size={17} color={fileIcon.color} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">{file.name}</div>
              </div>
              {file.truncated && (
                <span className="rounded border border-warning/30 bg-warning/10 px-2 py-1 text-2xs text-warning">
                  Truncated
                </span>
              )}
              {hasText && (
                <ViewModeToggle file={file} isHtml={isHtml} isSvg={isSvg} isMarkdown={isMarkdown} isPdf={isPdf} showSource={showSource} setShowSource={setShowSource} />
              )}
              {hasText && file.content && (
                <CopyFileButton content={file.content} />
              )}
              <SaveFileButton file={file} />
              <ZoomControls zoom={zoom} setZoom={setZoom} />
              <button
                type="button"
                onClick={() => setFullscreen(false)}
                title="Exit fullscreen (Esc)"
                aria-label="Exit fullscreen"
                data-testid="file-preview-fullscreen-exit"
                className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
              >
                <Minimize2 className="size-3" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <PreviewCanvas file={file} zoom={zoom} showSource={showSource} />
            </div>
            {caption ? (
              <p
                className="shrink-0 border-t border-border/60 px-4 py-2 text-2xs leading-relaxed text-muted-foreground"
                data-testid="file-preview-caption"
              >
                {caption}
              </p>
            ) : null}
          </div>,
          document.body,
        )}
    </>
  );
}
