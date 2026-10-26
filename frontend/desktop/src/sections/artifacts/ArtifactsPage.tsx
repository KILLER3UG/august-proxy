/* ── Artifacts — the Signal Desk gallery ───────────────────────────────
 *
 * Derivation, not storage: artifacts are collected from each chat's messages
 * by the SAME `collectArtifacts` the drawer and launchpad use, over the SAME
 * `loadMessagesForSession` the chat hydrates from. A second implementation
 * would guarantee a disagreement about what an artifact is.
 *
 * The mockup's filter vocabulary (Charts / Docs / Images / Code) is applied to
 * the derived rows; origin (made by August vs attached) stays visible in the
 * tile's meta line instead of taking a whole tab.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  Download,
  FileText,
  Folder,
  Image as ImageIcon,
  Link2,
  Plus,
  Search,
} from 'lucide-react';
import { collectArtifacts, type SessionArtifact } from '@/lib/artifacts';
import { loadMessagesForSession } from '@/sections/chat/chat-stream-manager';
import { useSessionsStore, createSession } from '@/store/sessions';
import { SectionHeader } from '@/components/SectionHeader';
import { Button } from '@/components/ui/button';
import { openRightDrawerFile } from '@/components/shell/RightDrawerState';
import { openExternal } from '@/lib/tauri-shell';
import { openFileInDrawer } from '@/lib/file-kind';
import { dispatchInsertComposerText } from '@/api/ui-events';
import { cn } from '@/lib/utils';

const MAX_CHATS = 40;

type ArtifactFilter = 'all' | 'charts' | 'docs' | 'images' | 'code';

const FILTERS: Array<{ key: ArtifactFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'charts', label: 'Charts' },
  { key: 'docs', label: 'Docs' },
  { key: 'images', label: 'Images' },
  { key: 'code', label: 'Code' },
];

interface ArtifactRow extends SessionArtifact {
  sessionId: string;
  sessionTitle: string;
}

interface ChatGroup {
  sessionId: string;
  title: string;
  rows: ArtifactRow[];
  lastEdited: string;
}

const DOC_EXT = new Set(['pdf', 'md', 'markdown', 'doc', 'docx', 'txt', 'rtf', 'html', 'htm']);
const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'css', 'scss', 'json', 'yml', 'yaml', 'sh', 'ps1']);

function extensionOf(label: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(label.trim());
  return match ? match[1].toLowerCase() : '';
}

function inFilter(row: ArtifactRow, filter: ArtifactFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'images') return row.kind === 'image';
  if (filter === 'charts') {
    return row.kind === 'image' && (
      row.origin === 'produced' ||
      /chart|plot|graph|burn|token|cost|latency/i.test(`${row.label} ${row.snippet ?? ''}`)
    );
  }
  const ext = extensionOf(row.label);
  if (filter === 'docs') return row.kind === 'file' && DOC_EXT.has(ext);
  return row.kind === 'file' && CODE_EXT.has(ext);
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `Edited ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function KindIcon({ kind }: { kind: SessionArtifact['kind'] }) {
  if (kind === 'image') return <ImageIcon className="size-6" />;
  if (kind === 'link') return <Link2 className="size-6" />;
  return <FileText className="size-6" />;
}

function exportRows(rows: ArtifactRow[]): void {
  const payload = {
    exportedAt: new Date().toISOString(),
    artifacts: rows.map(({ id, label, kind, origin, href, sessionId, sessionTitle, timestamp }) => ({
      id,
      label,
      kind,
      origin,
      href,
      sessionId,
      sessionTitle,
      timestamp,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'august-artifacts.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function ArtifactsPage() {
  const navigate = useNavigate();
  const sessions = useSessionsStore((state) => state.sessions);
  const [filter, setFilter] = useState<ArtifactFilter>('all');
  const [query, setQuery] = useState('');

  const groups = useMemo<ChatGroup[]>(() => {
    const sorted = [...sessions]
      .sort((a, b) => (b.updatedAt ?? b.startedAt).localeCompare(a.updatedAt ?? a.startedAt))
      .slice(0, MAX_CHATS);
    const out: ChatGroup[] = [];
    for (const session of sorted) {
      let messages;
      try {
        messages = loadMessagesForSession(session.id);
      } catch {
        continue;
      }
      const rows: ArtifactRow[] = collectArtifacts(messages).map((artifact) => ({
        ...artifact,
        sessionId: session.id,
        sessionTitle: session.title || 'Untitled chat',
      }));
      if (!rows.length) continue;
      const newest = rows.reduce((acc, row) => (row.timestamp > acc ? row.timestamp : acc), rows[0].timestamp);
      out.push({ sessionId: session.id, title: session.title || 'Untitled chat', rows, lastEdited: newest });
    }
    return out;
  }, [sessions]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .flatMap((group) => group.rows)
      .filter((row) => inFilter(row, filter))
      .filter((row) => !q || row.label.toLowerCase().includes(q) || row.sessionTitle.toLowerCase().includes(q))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [groups, filter, query]);

  const chatCount = new Set(rows.map((row) => row.sessionId)).size;
  const capped = sessions.length > MAX_CHATS;

  const openArtifact = async (row: ArtifactRow) => {
    void navigate(`/c/${row.sessionId}`);
    if (row.origin === 'link') {
      await openExternal(row.href);
      return;
    }
    if (row.kind === 'image' && row.href.startsWith('data:')) {
      openRightDrawerFile({
        name: row.label,
        size: '',
        path: row.href,
        dataUrl: row.href,
        thumbnailUrl: row.thumbnailUrl,
        type: 'image',
        status: 'ready',
      } as never);
      return;
    }
    await openFileInDrawer(row.href, row.sessionId);
  };

  const addFile = () => {
    const session = createSession(null);
    void navigate(`/c/${session.id}`);
    window.setTimeout(
      () => dispatchInsertComposerText('Analyze this dataset. I will attach the file next.', { replace: true }),
      220,
    );
  };

  return (
    <div className="mx-auto h-full w-full max-w-6xl overflow-y-auto px-8 py-8" data-testid="artifacts-page">
      <SectionHeader
        title="Artifacts"
        subtitle="Files, charts, images, and documents grouped by the thread that made them."
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => exportRows(rows)}
              disabled={rows.length === 0}
            >
              <Download className="size-3.5" />
              Export
            </Button>
            <Button type="button" size="sm" onClick={addFile}>
              <Plus className="size-3.5" />
              Add file
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-0.5 rounded-lg border border-border/60 p-0.5" role="tablist" aria-label="Artifact kind">
          {FILTERS.map((item) => (
            <Button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={filter === item.key}
              variant="ghost"
              size="sm"
              onClick={() => setFilter(item.key)}
              className={cn(
                'h-7 rounded-md px-2.5 text-[0.72rem] font-normal',
                filter === item.key ? 'bg-muted text-foreground' : 'text-muted-foreground/60',
              )}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border/60 bg-card/40 px-2.5 py-1.5 focus-within:border-primary/40">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search artifacts or chats"
            aria-label="Search artifacts"
            className="w-56 bg-transparent text-[0.8125rem] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      <p className="mt-3 text-2xs text-muted-foreground/70" data-testid="artifacts-count">
        {rows.length} artifact{rows.length === 1 ? '' : 's'} across {chatCount} chat{chatCount === 1 ? '' : 's'}
        {capped ? ` · derived from your ${MAX_CHATS} most recent chats` : ''}
      </p>

      {rows.length === 0 ? (
        <div className="mt-16 text-center text-sm text-muted-foreground/70">
          Nothing here yet. Ask August to make a file, and it lands on this page.
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map((row) => {
            const preview = row.thumbnailUrl || (row.kind === 'image' && row.href.startsWith('data:') ? row.href : null);
            const extension = extensionOf(row.label);
            return (
              <Button
                key={`${row.sessionId}:${row.id}`}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void openArtifact(row)}
                title={`${row.label} — made in “${row.sessionTitle}”`}
                className="group h-auto w-full flex-col items-stretch justify-start gap-0 overflow-hidden rounded-xl border border-border/50 bg-card/30 p-0 text-left font-normal whitespace-normal transition-colors hover:border-border hover:bg-card/60"
              >
                <span className="relative flex h-28 items-center justify-center overflow-hidden border-b border-border/40 bg-muted/15">
                  {preview ? (
                    <img src={preview} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="flex flex-col items-center gap-2 text-muted-foreground/40">
                      <KindIcon kind={row.kind} />
                      <span className="font-mono text-[0.58rem] uppercase tracking-[0.12em]">
                        {row.kind === 'file' && extension ? extension : row.kind}
                      </span>
                    </span>
                  )}
                  <span className="absolute right-2 top-2 rounded bg-background/70 p-1 text-muted-foreground/45 opacity-0 transition-opacity group-hover:opacity-100">
                    <ArrowUpRight className="size-3" />
                  </span>
                </span>
                <span className="block p-3">
                  <span className="block truncate text-[0.8125rem] font-medium text-foreground/90">{row.label}</span>
                  <span className="mt-0.5 block truncate text-2xs text-muted-foreground/65">
                    {row.snippet || row.meta || (row.origin === 'produced' ? 'Made by August' : 'Attached')}
                  </span>
                  <span className="mt-2 flex items-center gap-1.5 text-2xs text-muted-foreground/50">
                    <Folder className="size-3 shrink-0" />
                    <span className="min-w-0 truncate">{row.sessionTitle}</span>
                    <span className="ml-auto shrink-0 font-mono text-[0.58rem] uppercase tracking-[0.08em]">
                      {row.kind === 'file' ? extension || 'file' : row.kind}
                    </span>
                  </span>
                  <span className="mt-1 block text-2xs text-muted-foreground/35">{formatWhen(row.timestamp)}</span>
                </span>
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
