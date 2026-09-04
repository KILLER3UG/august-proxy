/* ── RightDrawerArtifactsSection ─ session gallery ──────────────── */
/* Hermes “Artifacts” + DeepSeek produced-files row, lifted to a drawer   */
/* section that is searchable and grouped by kind. Reuses                   */
/* collectArtifacts so it stays in sync with the inline ChangesCard.      */

import { useEffect, useMemo, useState } from 'react';
import { Search, ExternalLink, Image as ImageIcon, FileText, Link2, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { FileIcon } from '@/components/ui/FileIcon';
import { openRightDrawerFile } from '@/components/shell/RightDrawerState';
import { ChatAttachmentService } from '@/sections/chat/services/ChatAttachmentService';
import { revealInFolder } from '@/lib/tauri-shell';
import { openExternal } from '@/lib/tauri-shell';
import { collectArtifacts, type ArtifactKind, type SessionArtifact } from '@/lib/artifacts';
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
  return <Icon className="size-3.5 shrink-0 text-muted-foreground/70" />;
}

export function RightDrawerArtifactsSection({ sessionId }: { sessionId: string | null }) {
  const stream = useSessionStream(sessionId);
  const messages = (stream?.messages ?? []);
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
      // files — try to open in preview, fallback to show in folder
      try {
        const att = await ChatAttachmentService.fromPath(a.href);
        if (att) openRightDrawerFile(att);
        else await revealInFolder(a.href);
      } catch {
        await revealInFolder(a.href);
      }
    } catch (e) {
      console.warn('[Artifacts] open failed', e);
      toast.error('Could not open artifact');
    }
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
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">Artifacts</h3>
          <span className="text-[11px] tabular-nums text-muted-foreground/60">{artifacts.length} items</span>
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
              className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium capitalize transition ${activeKind === k ? 'bg-foreground text-background' : 'bg-muted/40 text-muted-foreground hover:bg-muted'}`}
            >
              {k === 'all' ? 'All' : k === 'file' ? 'Files' : k === 'image' ? 'Images' : 'Links'} <span className="opacity-60">· {counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filtered.length === 0 ? (
          <div className="py-12 text-center">
            <div className="mx-auto mb-2 flex size-8 items-center justify-center rounded-full bg-muted/40 text-muted-foreground/50">
              <Search className="size-3.5" />
            </div>
            <p className="text-xs font-medium text-muted-foreground/70">
              {artifacts.length === 0 ? 'No artifacts yet' : 'No matches'}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground/50 px-6">
              {artifacts.length === 0
                ? 'Files you edit and links the agent shares will appear here for quick jump-back.'
                : 'Try a different term or clear the kind filter.'}
            </p>
          </div>
        ) : (
          filtered.map((a) => (
            <div
              key={a.id}
              className="group flex items-start gap-2.5 rounded-lg border border-border/40 bg-card/40 px-2.5 py-2 hover:bg-card hover:border-border/60 transition"
            >
              <KindIcon kind={a.kind} href={a.href} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium leading-tight text-foreground/90" title={a.href}>
                  {a.label}
                </div>
                <div className="truncate text-[11px] leading-tight text-muted-foreground/70" title={a.href}>
                  {a.kind === 'link' ? a.meta : a.snippet}
                </div>
                <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/50">
                  <Clock className="size-2.5" />
                  <span>{timeAgo(a.timestamp)}</span>
                  <span className="opacity-40">·</span>
                  <button type="button" onClick={() => jumpTo(a)} className="underline decoration-dotted underline-offset-2 hover:text-foreground/70">
                    jump to message
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void openArtifact(a)}
                className="shrink-0 rounded-md p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground transition"
                title={a.kind === 'link' ? 'Open in browser' : 'Open'}
              >
                <ExternalLink className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}