/* ── RightDrawerFileSection ─ focused attachment/document preview ───── */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileWarning,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  X,
} from 'lucide-react';
import { getFileIcon } from '@/lib/file-icon';
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

/** The zoom-scaled preview body — rendered identically in the drawer pane
 *  and in the fullscreen overlay so both views always agree. */
function PreviewCanvas({ file, zoom }: { file: FileAttachment; zoom: number }) {
  const imageSrc = file.dataUrl || file.previewUrl;
  const isImage = file.type === 'image' && !!imageSrc;
  const hasText = file.type === 'text' && typeof file.content === 'string';
  const hasInlineSource = !isImage && !hasText && !!(file.dataUrl || file.previewUrl);

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
      ) : hasText ? (
        <TextPreview content={file.content ?? ''} />
      ) : hasInlineSource ? (
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
          <PreviewCanvas file={file} zoom={zoom} />
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
              <PreviewCanvas file={file} zoom={zoom} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
