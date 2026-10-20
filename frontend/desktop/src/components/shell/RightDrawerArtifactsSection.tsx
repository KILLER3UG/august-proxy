/* ── RightDrawerArtifactsSection — session gallery ─────────────────── */
/* Two groups, in the reference's shape: what this session produced, and  */
/* under a "Content" heading what the user brought in. Reuses             */
/* collectArtifacts so it stays in sync with the inline ChangesCard.      */

import { useEffect, useMemo, useState } from 'react';
import { Search, Image as ImageIcon, Link2, FolderOpen, Download, CornerUpLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FileIcon } from '@/components/ui/FileIcon';
import { openRightDrawerFile } from '@/components/shell/RightDrawerState';
import { revealInFolder, openExternal, selectDirectory, copyFilesToDir } from '@/lib/tauri-shell';
import { isTauri } from '@/lib/tauri-detect';
import { collectArtifacts, type SessionArtifact } from '@/lib/artifacts';
import { classifyFileKind, openFileInDrawer } from '@/lib/file-kind';
import { useSessionStream } from '@/sections/chat/hooks/useSessionStream';
import { FileAttachmentCard } from '@/sections/chat/message/FileAttachmentCard';
import { timeAgo } from '@/lib/utils';

/** `Document · PDF`, `Image · PNG`, or the domain for a link. Classified on
 *  the human label, not `href`: a data-URL href has no usable extension, and
 *  classifying one answered "File" for every image. */
function subtitleFor(a: SessionArtifact): string {
  if (a.origin === 'link') return a.meta || a.href;
  return classifyFileKind(a.label).label;
}

function Tile({ a }: { a: SessionArtifact }) {
  const cls = 'grid size-11 shrink-0 place-items-center rounded-xl bg-muted/50';
  if (a.kind === 'image') {
    const src = a.thumbnailUrl || a.href;
    if (src) {
      return (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="size-11 shrink-0 rounded-xl border border-border/60 bg-muted/50 object-cover"
        />
      );
    }
    return (
      <span className={cls}>
        <ImageIcon className="size-4 text-muted-foreground/70" />
      </span>
    );
  }
  if (a.origin === 'link') {
    return (
      <span className={cls}>
        <Link2 className="size-4 text-muted-foreground/70" />
      </span>
    );
  }
  return (
    <span className={cls}>
      <FileIcon name={a.label} size={20} />
    </span>
  );
}

/** One produced file or cited link. The reference's row is a tile, a name,
 *  a `Kind · EXT` line and icon-only actions — no text buttons, because a
 *  word per row costs the line the filename needs. */
function ArtifactRow({
  a,
  onOpen,
  onReveal,
  onDownload,
  onJump,
}: {
  a: SessionArtifact;
  onOpen: () => void;
  onReveal?: () => void;
  onDownload?: () => void;
  onJump: () => void;
}) {
  return (
    <div
      className="group flex items-center gap-3 rounded-xl bg-card/50 p-2.5 transition hover:bg-card"
      title={a.href}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <Tile a={a} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-medium leading-tight text-foreground/90">
            {a.label}
          </span>
          <span className="mt-0.5 block truncate text-2xs leading-tight text-muted-foreground/70">
            {subtitleFor(a)}
          </span>
        </span>
      </button>
      {onReveal && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground/60 hover:text-foreground"
          onClick={onReveal}
          title={`Reveal in folder · ${timeAgo(a.timestamp)}`}
          aria-label={`Reveal ${a.label} in folder`}
        >
          <FolderOpen className="size-3.5" />
        </Button>
      )}
      {onDownload && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground/60 hover:text-foreground"
          onClick={onDownload}
          title={`Download ${a.label}`}
          aria-label={`Download ${a.label}`}
          data-testid="artifact-row-download"
        >
          <Download className="size-3.5" />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground/60 hover:text-foreground"
        onClick={onJump}
        title={`Jump to ${a.label} in the transcript · ${timeAgo(a.timestamp)}`}
        aria-label={`Jump to ${a.label} in the transcript`}
      >
        <CornerUpLeft className="size-3.5" />
      </Button>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 className="px-1 pb-1.5 pt-4 text-[0.8125rem] font-semibold text-foreground/90">
      {children}
    </h3>
  );
}

export function RightDrawerArtifactsSection({ sessionId }: { sessionId: string | null }) {
  const stream = useSessionStream(sessionId);
  // Memoized so the artifacts useMemo below has a stable dependency; a bare
  // `stream?.messages ?? []` allocates a new array each render and would
  // re-run collectArtifacts every time.
  const messages = useMemo(() => stream?.messages ?? [], [stream?.messages]);
  const artifacts = useMemo(() => collectArtifacts(messages), [messages]);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return artifacts;
    return artifacts.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.href.toLowerCase().includes(q) ||
        (a.snippet ?? '').toLowerCase().includes(q),
    );
  }, [artifacts, debouncedQuery]);

  const produced = useMemo(() => filtered.filter((a) => a.origin === 'produced'), [filtered]);
  const uploaded = useMemo(() => filtered.filter((a) => a.origin === 'uploaded'), [filtered]);
  const links = useMemo(() => filtered.filter((a) => a.origin === 'link'), [filtered]);

  const jumpTo = (a: SessionArtifact) => {
    const el =
      document.querySelector(`[data-artifact-source="${a.sourceMessageId}"]`) ??
      document.querySelector(`#msg-${a.sourceMessageId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-1', 'ring-primary/40', 'rounded-lg');
      setTimeout(() => el.classList.remove('ring-1', 'ring-primary/40', 'rounded-lg'), 1400);
    }
  };

  const reveal = async (a: SessionArtifact) => {
    try {
      await revealInFolder(a.href);
    } catch (e) {
      console.warn('[Artifacts] reveal failed', e);
      toast.error('Could not reveal file');
    }
  };

  /* One file, the card's own verb: the bytes never cross the webview — a
     Rust copy puts the file in a folder the user picks. The same door the
     transcript's artifact card uses. */
  const download = async (a: SessionArtifact) => {
    try {
      if (!isTauri) {
        toast.message(
          'Downloading needs the desktop build — open August to copy this file into a folder.',
        );
        return;
      }
      const dest = await selectDirectory();
      if (!dest) return; // the picker was dismissed; silence is the answer
      const report = await copyFilesToDir(dest, [a.href]);
      if (!report || report.copied === 0) {
        toast.error(`Could not download ${a.label}`);
        return;
      }
      toast.success(`Downloaded ${a.label}`);
      await revealInFolder(dest);
    } catch (e) {
      console.warn('[Artifacts] download failed', e);
      toast.error('Could not download the file');
    }
  };

  const openArtifact = async (a: SessionArtifact) => {
    try {
      if (a.origin === 'link') {
        await openExternal(a.href);
        return;
      }
      if (a.kind === 'image' && a.href.startsWith('data:')) {
        openRightDrawerFile({
          name: a.label,
          size: '',
          path: a.href,
          dataUrl: a.href,
          thumbnailUrl: a.thumbnailUrl,
          type: 'image',
          status: 'ready',
        } as never);
        return;
      }
      await openFileInDrawer(a.href, sessionId ?? undefined);
    } catch (e) {
      console.warn('[Artifacts] open failed', e);
      toast.error('Could not open artifact');
    }
  };

  // Download the visible set of FILE artifacts (links have no file on disk).
  // Desktop: one folder pick + a Rust bulk copy (bytes never touch the webview).
  // Browser/dev: no picker or FS write, so fall back to sequential anchor
  // downloads — the documented non-desktop behaviour, said so plainly.
  const downloadable = filtered.filter((a) => a.kind === 'file');
  const downloadAll = async () => {
    if (downloadable.length === 0) {
      toast.message('No files to download');
      return;
    }
    const dest = await selectDirectory();
    if (!dest) {
      if (isTauri) return; // user cancelled the picker
      toast.message(
        'Downloading in the browser needs a desktop build — open August to copy these into a folder.',
      );
      return;
    }
    const report = await copyFilesToDir(
      dest,
      downloadable.map((a) => a.href),
    );
    if (!report) {
      toast.error('Could not copy files');
      return;
    }
    const parts = [`Copied ${report.copied} of ${downloadable.length}`];
    if (report.failed > 0) parts.push(`${report.failed} failed`);
    if (report.skipped > 0) parts.push(`${report.skipped} skipped (name already taken)`);
    if (report.copied > 0) toast.success(parts.join(' · '));
    else toast.error(parts.join(' · '));
    // Reveal the destination folder so the user lands on what just happened.
    if (report.copied > 0) await revealInFolder(dest);
  };

  if (!sessionId) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">Open a chat to see artifacts.</div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header — no title here. The drawer's own tab strip already reads
          "Artifacts" (RightDrawer.tsx:313), so a heading in the section body
          rendered the word twice, twenty pixels apart. The reference gets a
          title because it has no tab strip; August already has one. */}
      <div className="shrink-0 px-3 pt-3">
        <div className="flex items-center justify-end gap-2">
          {downloadable.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void downloadAll()}
              data-testid="download-all-artifacts"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
              title="Copy the shown files into a folder you pick"
            >
              <Download className="size-3.5" />
              {filtered.length === artifacts.length
                ? 'Download all'
                : `Download ${downloadable.length} shown`}
            </Button>
          )}
        </div>
        <div className="relative mt-2.5">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered.length > 0) {
                const first = filtered[0];
                const el =
                  document.querySelector(`[data-artifact-source="${first.sourceMessageId}"]`) ??
                  document.querySelector(`#msg-${first.sourceMessageId}`);
                el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }}
            placeholder="Search files, images, links…"
            className="w-full rounded-lg bg-muted/40 py-1.5 pl-8 pr-2.5 text-xs outline-none placeholder:text-muted-foreground/45 focus:bg-muted/60"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 pt-2">
        {filtered.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-xs font-medium text-muted-foreground/70">
              {artifacts.length === 0 ? 'No artifacts yet' : 'No matches'}
            </p>
            {artifacts.length > 0 ? (
              <p className="mt-1 px-6 text-2xs leading-snug text-muted-foreground/50">
                Clear the search to see everything this session touched.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            {produced.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {produced.map((a) => (
                  <ArtifactRow
                    key={a.id}
                    a={a}
                    onOpen={() => void openArtifact(a)}
                    onReveal={a.kind === 'file' ? () => void reveal(a) : undefined}
                    onDownload={a.kind === 'file' ? () => void download(a) : undefined}
                    onJump={() => jumpTo(a)}
                  />
                ))}
              </div>
            )}

            {uploaded.length > 0 && (
              <>
                <SectionTitle>Content</SectionTitle>
                {/* The reference's Content group is a thumbnail grid, not rows:
                    these are the files the user handed over, and what you want
                    from them is the page, not the name. Reuses the transcript's
                    card so both surfaces crop and badge identically. */}
                <div className="grid grid-cols-2 gap-2">
                  {uploaded.map((a) => (
                    <FileAttachmentCard
                      key={a.id}
                      className="w-full"
                      file={{
                        id: a.id,
                        name: a.label,
                        size: '',
                        type: a.kind === 'image' ? 'image' : 'text',
                        status: 'ready',
                        dataUrl: a.kind === 'image' ? a.href : undefined,
                        path: a.kind === 'image' ? undefined : a.href,
                        thumbnailUrl: a.thumbnailUrl,
                        mimeType: a.meta,
                      }}
                    />
                  ))}
                </div>
              </>
            )}

            {links.length > 0 && (
              <>
                <SectionTitle>Links</SectionTitle>
                <div className="flex flex-col gap-1.5">
                  {links.map((a) => (
                    <ArtifactRow
                      key={a.id}
                      a={a}
                      onOpen={() => void openArtifact(a)}
                      onJump={() => jumpTo(a)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
