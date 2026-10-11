/* ── RightDrawerArtifactsSection ─ session gallery ──────────────── */
/* A produced-files row, lifted to a drawer   */
/* section that is searchable and grouped by kind. Reuses                   */
/* collectArtifacts so it stays in sync with the inline ChangesCard.      */

import { useEffect, useMemo, useState } from 'react';
import { Search, Image as ImageIcon, FileText, Link2, FolderOpen, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FileIcon } from '@/components/ui/FileIcon';
import { DocumentBadge } from '@/components/chat/DocumentBadge';
import { openRightDrawerFile } from '@/components/shell/RightDrawerState';
import { revealInFolder, openExternal, selectDirectory, copyFilesToDir } from '@/lib/tauri-shell';
import { isTauri } from '@/lib/tauri-detect';
import { collectArtifacts, type ArtifactKind, type SessionArtifact } from '@/lib/artifacts';
import { classifyFileKind, openFileInDrawer } from '@/lib/file-kind';
import { useSessionStream } from '@/sections/chat/hooks/useSessionStream';
import { timeAgo } from '@/lib/utils';

function kindIcon(kind: ArtifactKind) {
  switch (kind) {
    case 'image': return ImageIcon;
    case 'link': return Link2;
    default: return FileText;
  }
}

function KindIcon({ kind, href }: { kind: ArtifactKind; href: string }) {
  if (kind === 'file') return <FileIcon name={href} size={14} className="shrink-0" />;
  const Icon = kindIcon(kind);
  return <Icon className="size-3 shrink-0 text-muted-foreground/70" />;
}

/** Thumbnail for a card. Images show themselves; everything else falls back to
 *  a DocumentBadge square sized to match. A failed image load also degrades to
 *  the badge rather than a broken-image icon. */
function ArtifactThumb({ a }: { a: SessionArtifact }) {
  const [broken, setBroken] = useState(false);
  const isFileImage = a.kind === 'file' && /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(a.href);
  if ((a.kind === 'image' || isFileImage) && !broken) {
    return (
      <img
        src={a.href}
        alt={a.label}
        loading="lazy"
        onError={() => setBroken(true)}
        className="size-10 shrink-0 rounded-lg border border-white/[0.06] object-cover"
      />
    );
  }
  if (a.kind === 'file') {
    const info = classifyFileKind(a.href);
    return <DocumentBadge text={info.badgeText} tone={info.badgeTone} size={40} />;
  }
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-white/[0.06] bg-muted/30">
      <KindIcon kind={a.kind} href={a.href} />
    </span>
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
  const [activeKind, setActiveKind] = useState<ArtifactKind | 'all'>('all');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    return artifacts.filter((a) => {
      if (activeKind !== 'all' && a.kind !== activeKind) return false;
      if (!q) return true;
      return a.label.toLowerCase().includes(q) || a.href.toLowerCase().includes(q) || (a.snippet ?? '').toLowerCase().includes(q);
    });
  }, [artifacts, debouncedQuery, activeKind]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: artifacts.length, file: 0, image: 0, link: 0 };
    for (const a of artifacts) c[a.kind] = (c[a.kind] ?? 0) + 1;
    return c;
  }, [artifacts]);

  const jumpTo = (a: SessionArtifact) => {
    const el = document.querySelector(`[data-artifact-source="${a.sourceMessageId}"]`) ?? document.querySelector(`#msg-${a.sourceMessageId}`);
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

  /** Single-file save. On the desktop shell this will route through the bulk
   *  copy helper once increment 7 lands; for now it is the browser anchor
   *  pattern, which is also the documented non-desktop behaviour. */
  const download = (a: SessionArtifact) => {
    try {
      const link = document.createElement('a');
      link.href = a.href;
      link.download = a.label || a.href.split(/[\\/]/).pop() || 'download';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      console.warn('[Artifacts] download failed', e);
      toast.error('Could not download file');
    }
  };

  const openArtifact = async (a: SessionArtifact) => {
    try {
      if (a.kind === 'link') {
        await openExternal(a.href);
        return;
      }
      if (a.kind === 'image' && a.href.startsWith('data:')) {
        // data-url images — open as preview in drawer file viewer
        openRightDrawerFile({ name: a.label, size: '', path: a.href, dataUrl: a.href, type: 'image', status: 'ready' } as never);
        return;
      }
      // files — shared open flow: drawer preview with a backend-path fallback
      // for dev/backend-only runs (the local copy only tried fromPath, so a
      // file the drawer could have shown fell through to reveal-in-folder),
      // then reveal-in-folder if neither loads.
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
      // Non-desktop: sequential anchor downloads.
      for (const a of downloadable) download(a);
      toast.message(`Downloading ${downloadable.length} file${downloadable.length === 1 ? '' : 's'} — your browser will save them one at a time.`);
      return;
    }
    const report = await copyFilesToDir(dest, downloadable.map((a) => a.href));
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
      <div className="p-6 text-center text-sm text-muted-foreground">
        Open a chat to see artifacts.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 p-3 border-b border-border/40 space-y-2">
        <div className="flex items-center justify-end gap-2">
          {/* Label tracks the visible set: "Download all" only when nothing is
              filtered, else "Download N shown" — the button does exactly what
              it says. */}
          {downloadable.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void downloadAll()}
              data-testid="download-all-artifacts"
              className="h-6 gap-1 px-2 text-2xs"
              title="Copy the shown files into a folder you pick"
            >
              <Download className="size-3" />
              {filtered.length === artifacts.length ? 'Download all' : `Download ${downloadable.length} shown`}
            </Button>
          )}
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered.length > 0) {
                const first = filtered[0];
                const el = document.querySelector(`[data-artifact-source="${first.sourceMessageId}"]`) ?? document.querySelector(`#msg-${first.sourceMessageId}`);
                el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }}
            placeholder="Search files, images, links…"
            className="w-full rounded-md border border-border/60 bg-background pl-7 pr-2 py-1.5 text-xs outline-none focus:border-primary/40 placeholder:text-muted-foreground/40"
          />
        </div>
        <div className="flex gap-1">
          {(['all', 'file', 'image', 'link'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setActiveKind(k)}
              className={`flex-1 rounded-md px-2 py-1 text-2xs font-medium capitalize transition ${activeKind === k ? 'bg-primary text-primary-foreground' : 'bg-muted/40 text-muted-foreground hover:bg-muted'}`}
            >
              {k === 'all' ? 'All' : k === 'file' ? 'Files' : k === 'image' ? 'Images' : 'Links'} <span className="opacity-60">· {counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-xs font-medium text-muted-foreground/70">
              {artifacts.length === 0 ? 'No artifacts yet' : 'No matches'}
            </p>
            {artifacts.length > 0 ? (
              <p className="mt-1 text-2xs leading-snug text-muted-foreground/50 px-6">
                Try a different term or clear the kind filter.
              </p>
            ) : null}
          </div>
        ) : (
          /* One full-width row per artifact, the reference shape — NOT a 2-column
           * grid. A grid gave each card ~200px inside a 420px drawer, which is
           * wide enough for an icon tile and nothing else: filenames truncated to
           * about a dozen characters. The reference runs a single column of
           * ~470px rows, and the name is the thing you are scanning for.
           *
           * Two more differences, both measured against the same screenshot:
           * the reference has NO metadata row under the name (August carried a
           * `timeAgo · jump` line, which is two pieces of text per artifact that
           * nobody asked for), and its folder action is permanently visible
           * rather than hover-only — it is the primary action on the row, not a
           * secret. The timestamp survives as a `title` on the row, so it is
           * still reachable without costing a line of text. */
          <div className="flex flex-col gap-1.5">
            {filtered.map((a) => (
              <div
                key={a.id}
                className="group flex items-center gap-2.5 rounded-lg border border-border/40 bg-card/40 p-2 transition hover:border-border/60 hover:bg-card"
              >
                <button
                  type="button"
                  onClick={() => void openArtifact(a)}
                  title={a.href}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <ArtifactThumb a={a} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.78125rem] font-medium leading-tight text-foreground/90">
                      {a.label}
                    </span>
                    <span className="mt-0.5 block truncate text-2xs leading-tight text-muted-foreground/70">
                      {a.kind === 'file' ? classifyFileKind(a.href).label : a.kind === 'link' ? a.meta : a.snippet}
                    </span>
                  </span>
                </button>
                {/* Reveal/download only for real files. A `link`'s href is a
                    URL and an `image`'s may be a data: or http: URL, neither
                    of which has anything to reveal on disk. Always visible —
                    see the note above. */}
                {a.kind === 'file' && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground/60 hover:text-foreground"
                      onClick={() => void reveal(a)}
                      title={`Reveal in folder · ${timeAgo(a.timestamp)}`}
                      aria-label={`Reveal ${a.label} in folder`}
                    >
                      <FolderOpen className="size-3" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground/60 hover:text-foreground"
                      onClick={() => download(a)}
                      title="Download"
                      aria-label={`Download ${a.label}`}
                    >
                      <Download className="size-3" />
                    </Button>
                  </div>
                )}
                {/* Jump is a text link in the old card and is still a real
                    action, so it moves into the row's tooltip surface rather
                    than being deleted: the footer button that survived. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-1.5 text-2xs text-muted-foreground/60 hover:text-foreground"
                  onClick={() => jumpTo(a)}
                  title={`Jump to ${a.label} in the transcript`}
                >
                  jump
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}