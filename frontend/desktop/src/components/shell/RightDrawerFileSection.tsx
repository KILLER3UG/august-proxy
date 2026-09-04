/* ── RightDrawerFileSection ─ focused attachment/document preview ───── */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Code2,
  Eye,
  FileWarning,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  X,
} from 'lucide-react';
import { getFileIcon } from '@/lib/file-icon';
import { cn } from '@/lib/utils';
import { closeRightDrawer } from './RightDrawerState';
import type { FileAttachment } from '@/types/chat';

const MAX_PREVIEW_LINES = 5000;

function extensionLabel(name: string): string {
  const extension = name.split('.').pop()?.toUpperCase();
  return extension && extension.length <= 8 ? extension : 'FILE';
}

function TextPreview({ content }: { content: string }) {
  const allLines = content.split('\n');
  const lines = allLines.slice(0, MAX_PREVIEW_LINES);
  const truncated = lines.length < allLines.length;

  return (
    <div className="min-h-full bg-[#171717] py-3 font-mono text-[12px] leading-6 text-foreground/90">
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
} {
  const hasText = file.type === 'text' && typeof file.content === 'string';
  const isHtml =
    hasText && /\.(html?|xhtml)$/i.test(file.name || '') &&
    /<\/html|<!doctype html|<body/i.test(file.content ?? '');
  const isImage = file.type === 'image' && !!(file.dataUrl || file.previewUrl);
  return { isImage, hasText, isHtml };
}

/** The zoom-scaled preview body — rendered identically in the drawer pane
 *  and in the fullscreen overlay so both views always agree. The preview /
 *  source choice comes from the header toggle (`showSource`). */
function PreviewCanvas({ file, zoom, showSource }: { file: FileAttachment; zoom: number; showSource: boolean }) {
  const imageSrc = file.dataUrl || file.previewUrl;
  const { isImage, isHtml } = describePreview(file);
  // Live HTML documents render in a sandboxed iframe (scripts allowed —
  // these are the model's interactive explainers); "source" shows the code.
  const liveSrcDoc = isHtml ? file.content ?? '' : '';
  const hasText = file.type === 'text' && typeof file.content === 'string';

  return (
    <div
      style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
      className={zoom !== 1 ? 'h-full w-full' : 'contents'}
    >
      {isImage ? (
        <div className="flex min-h-full items-center justify-center bg-[#111] p-6">
          <img
            src={imageSrc}
            alt={file.name}
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        </div>
      ) : isHtml ? (
        <div className="flex h-full min-h-full flex-col bg-background" data-testid="file-preview-html-live">
          {showSource ? (
            <TextPreview content={file.content ?? ''} />
          ) : (
            <iframe
              title={`Interactive preview of ${file.name}`}
              sandbox="allow-scripts allow-pointer-lock"
              srcDoc={liveSrcDoc}
              className="min-h-[24rem] w-full flex-1 border-0 bg-white dark:bg-[#111]"
            />
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
 *  Shown for text-ish files only; the Eye side is disabled for non-HTML
 *  text, which has no live viewer (e.g. PPT/PPTX). */
function ViewModeToggle({
  file,
  isHtml,
  showSource,
  setShowSource,
}: {
  file: FileAttachment;
  isHtml: boolean;
  showSource: boolean;
  setShowSource: (v: boolean) => void;
}) {
  const ext = file.name.split('.').pop()?.toUpperCase() ?? '';
  const noPreviewTip =
    ext === 'PPT' || ext === 'PPTX'
      ? `No preview available for ${ext}`
      : 'No rendered preview for this file type';
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => setShowSource(false)}
        disabled={!isHtml}
        aria-pressed={isHtml && !showSource}
        aria-label="Show rendered preview"
        title={isHtml ? 'Rendered preview' : noPreviewTip}
        data-testid="html-preview-tab-render"
        className={cn(
          'rounded-md p-1.5 transition',
          isHtml
            ? 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            : 'cursor-not-allowed text-muted-foreground/35',
          isHtml && !showSource && 'bg-muted/60 text-foreground',
        )}
      >
        <Eye size={14} />
      </button>
      <button
        type="button"
        onClick={() => setShowSource(true)}
        aria-pressed={showSource}
        aria-label="Show source code"
        title="Source code"
        data-testid="html-preview-tab-source"
        className={cn(
          'rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground',
          showSource && 'bg-muted/60 text-foreground',
        )}
      >
        <Code2 size={14} />
      </button>
    </div>
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
        <Minus size={14} />
      </button>
      <span
        className="min-w-[3rem] text-center text-[11px] tabular-nums text-muted-foreground"
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
        <Plus size={14} />
      </button>
    </>
  );
}

export function RightDrawerFileSection({ file }: { file: FileAttachment }) {
  const fileIcon = getFileIcon(file.name);
  const Icon = fileIcon.Icon;
  // Claude-style viewer: zoom applies to the image/iframe canvas.
  const [zoom, setZoom] = useState(1);
  // ⤢ expands the preview into a full-window overlay (Esc / ⤡ exits).
  const [fullscreen, setFullscreen] = useState(false);
  // Preview-vs-source choice, lifted here so the header toggle and the
  // canvas (drawer + fullscreen) share one state.
  const { hasText, isHtml } = describePreview(file);
  const [showSource, setShowSource] = useState(false);
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

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-background" data-testid="right-drawer-file-preview">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-card/70 px-4">
          <Icon size={17} color={fileIcon.color} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">{file.name}</div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
              {extensionLabel(file.name)} · {file.size || 'Attached file'}
            </div>
          </div>
          {file.truncated && (
            <span className="rounded border border-warning/30 bg-warning/10 px-2 py-1 text-[10px] text-warning">
              Truncated
            </span>
          )}
          {hasText && (
            <ViewModeToggle file={file} isHtml={isHtml} showSource={showSource} setShowSource={setShowSource} />
          )}
          <ZoomControls zoom={zoom} setZoom={setZoom} />
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            title="Fullscreen preview"
            aria-label="Fullscreen preview"
            data-testid="file-preview-fullscreen"
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
          >
            <Maximize2 size={14} />
          </button>
          <button
            type="button"
            onClick={closeRightDrawer}
            title="Close preview"
            data-testid="file-preview-close"
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <PreviewCanvas file={file} zoom={zoom} showSource={showSource} />
        </div>
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
            <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-card/70 px-4">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">{file.name}</div>
                <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
                  {extensionLabel(file.name)} · Fullscreen
                </div>
              </div>
              {hasText && (
                <ViewModeToggle file={file} isHtml={isHtml} showSource={showSource} setShowSource={setShowSource} />
              )}
              <ZoomControls zoom={zoom} setZoom={setZoom} />
              <button
                type="button"
                onClick={() => setFullscreen(false)}
                title="Exit fullscreen (Esc)"
                aria-label="Exit fullscreen"
                data-testid="file-preview-fullscreen-exit"
                className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
              >
                <Minimize2 size={14} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <PreviewCanvas file={file} zoom={zoom} showSource={showSource} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
