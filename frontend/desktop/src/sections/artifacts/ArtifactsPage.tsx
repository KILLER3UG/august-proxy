/* ── Artifacts — the Signal Desk gallery ───────────────────────────────
 *
 * Derivation, not storage: artifacts are collected from each chat's messages
 * by the SAME `collectArtifacts` the drawer and launchpad use, over the SAME
 * `loadMessagesForSession` the chat hydrates from. A second implementation
 * would guarantee a disagreement about what an artifact is.
 *
 * The DOM is the mockup's own (`.filter-row` / `.filter-chip` /
 * `.search-field` / `.artifact-card` with its `.gallery-*` parts), styled by
 * styles/signal-desk.css. The mockup's filter vocabulary (Charts /
 * Documents / Images / Code) is applied to the derived rows; origin (made by
 * August vs attached) stays visible in the tile — the footer dot's colour —
 * with the full detail on the tile's tooltip.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collectArtifacts, type SessionArtifact } from '@/lib/artifacts';
import { loadMessagesForSession } from '@/sections/chat/chat-stream-manager';
import { useSessionsStore, createSession } from '@/store/sessions';
import { SectionHeader } from '@/components/SectionHeader';
import { Button } from '@/components/ui/button';
import { SignalIcon } from '@/components/ui/SignalIcon';
import { openRightDrawerFile } from '@/components/shell/RightDrawerState';
import { openExternal } from '@/lib/tauri-shell';
import { openFileInDrawer } from '@/lib/file-kind';
import { dispatchInsertComposerText } from '@/api/ui-events';

const MAX_CHATS = 40;

type ArtifactFilter = 'all' | 'charts' | 'docs' | 'images' | 'code';

const FILTERS: Array<{ key: ArtifactFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'charts', label: 'Charts' },
  { key: 'docs', label: 'Documents' },
  { key: 'images', label: 'Images' },
  { key: 'code', label: 'Code' },
];

interface ArtifactRow extends SessionArtifact {
  sessionId: string;
  sessionTitle: string;
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

/** The mockup's meta line reads "DOCUMENT · MD · 1H AGO" — kind, extension,
 *  age. Minutes/hours/days, like the mockup's own stamps. */
function relAge(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function kindLabel(row: ArtifactRow): string {
  if (row.origin === 'link') return 'LINK';
  if (row.origin === 'produced' && row.kind === 'image') return 'CHART';
  if (row.kind === 'image') return 'IMAGE';
  const ext = extensionOf(row.label);
  if (row.kind === 'file' && CODE_EXT.has(ext)) return 'CODE';
  return 'DOCUMENT';
}

/** The mockup draws its file kinds as two glyphs: a folded-corner document
 *  and a panel with accent text lines. Both are copied from the spec. */
function DocGlyph() {
  return (
    <svg width="54" height="68" viewBox="0 0 54 68" aria-hidden="true">
      <path d="M4 4h32l14 14v46H4V4z" fill="var(--dt-card)" stroke="var(--dt-line-strong)" />
      <path d="M36 4v14h14" fill="none" stroke="var(--dt-line-strong)" />
      <path d="M12 26h28M12 34h28M12 42h20" stroke="var(--dt-fg-3)" strokeWidth="1.2" />
    </svg>
  );
}

function CodeGlyph() {
  return (
    <svg viewBox="0 0 240 132" aria-hidden="true">
      <path d="M28 24h184v84H28z" fill="var(--dt-stage)" stroke="var(--dt-line)" />
      <path d="M44 40h38v8H44zM44 56h68v3H44zM44 65h52v3H44zM44 74h74v3H44zM44 83h60v3H44z" fill="var(--dt-chart-1)" opacity=".65" />
    </svg>
  );
}

function DocSheetGlyph() {
  return (
    <svg width="54" height="68" viewBox="0 0 54 68" aria-hidden="true">
      <path d="M4 4h32l14 14v46H4V4z" fill="var(--dt-card)" stroke="var(--dt-line-strong)" />
      <path d="M36 4v14h14" fill="none" stroke="var(--dt-line-strong)" />
      <path d="M12 26h28M12 34h20" stroke="var(--dt-fg-3)" strokeWidth="1.2" />
      <path d="M12 44h28v10H12z" fill="var(--dt-chart-2)" opacity=".2" />
    </svg>
  );
}

function ArtifactVisualClass({ row }: { row: ArtifactRow }): string | undefined {
  if (row.thumbnailUrl || (row.kind === 'image' && row.href.startsWith('data:'))) return undefined;
  const ext = extensionOf(row.label);
  if (row.kind === 'image') return 'photo';
  if (row.kind === 'file' && DOC_EXT.has(ext)) return 'doc';
  return undefined;
}

function ArtifactVisual({ row }: { row: ArtifactRow }) {
  const preview = row.thumbnailUrl || (row.kind === 'image' && row.href.startsWith('data:') ? row.href : null);
  if (preview) {
    return (
      <img
        src={preview}
        alt=""
        loading="lazy"
        className="max-h-full max-w-full object-contain"
      />
    );
  }
  const ext = extensionOf(row.label);
  if (row.kind === 'file' && CODE_EXT.has(ext)) return <CodeGlyph />;
  if (row.kind === 'file' && DOC_EXT.has(ext)) return <DocGlyph />;
  if (row.kind === 'link') return <DocSheetGlyph />;
  return <DocSheetGlyph />;
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

  const groups = useMemo(() => {
    const sorted = [...sessions]
      .sort((a, b) => (b.updatedAt ?? b.startedAt).localeCompare(a.updatedAt ?? a.startedAt))
      .slice(0, MAX_CHATS);
    const out: Array<{ sessionId: string; title: string; rows: ArtifactRow[] }> = [];
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
      out.push({ sessionId: session.id, title: session.title || 'Untitled chat', rows });
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
    <div className="page-screen" data-testid="artifacts-page">
      <div className="page-inner">
        <SectionHeader
          eyebrow="Library / everything"
          title="Artifacts"
          subtitle="Files, charts, images, and documents — grouped by the thread that made them."
          actions={
            <>
              <Button
                type="button"
                variant="bare"
                className="ghost-button"
                onClick={() => exportRows(rows)}
                disabled={rows.length === 0}
              >
                <SignalIcon name="download" /> Export
              </Button>
              <Button type="button" variant="bare" className="solid-button" onClick={addFile}>
                <SignalIcon name="plus" /> Add file
              </Button>
            </>
          }
        />

        <div className="filter-row">
          {FILTERS.map((item) => (
            <Button
              key={item.key}
              type="button"
              variant="bare"
              className="filter-chip"
              role="tab"
              aria-selected={filter === item.key}
              data-active={filter === item.key}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </Button>
          ))}
          <label className="search-field">
            <SignalIcon name="search" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search artifacts…"
              aria-label="Search artifacts"
            />
          </label>
        </div>

        <p className="mt-3 font-mono text-[0.58rem] uppercase tracking-[0.1em] text-muted-foreground/60" data-testid="artifacts-count">
          {rows.length} artifact{rows.length === 1 ? '' : 's'} across {chatCount} chat{chatCount === 1 ? '' : 's'}
          {capped ? ` · derived from your ${MAX_CHATS} most recent chats` : ''}
        </p>

        {rows.length === 0 ? (
          <div className="mt-16 text-center text-sm text-muted-foreground/70">
            Nothing here yet. Ask August to make a file, and it lands on this page.
          </div>
        ) : (
          <div className="artifact-grid">
            {rows.map((row) => {
              const ext = extensionOf(row.label);
              const extLabel = ext ? ext.toUpperCase() : row.kind === 'image' ? 'PNG' : 'FILE';
              const kindLine = [kindLabel(row), extLabel, relAge(row.timestamp)].filter(Boolean).join(' · ');
              return (
                <Button
                  key={`${row.sessionId}:${row.id}`}
                  type="button"
                  variant="bare"
                  className="artifact-card"
                  onClick={() => void openArtifact(row)}
                  title={`${row.label} — ${row.origin === 'produced' ? 'made by August' : row.origin === 'link' ? 'a link' : 'attached'} in “${row.sessionTitle}”`}
                >
                  <span className={`gallery-visual ${ArtifactVisualClass({ row }) ?? ''}`.trimEnd()}>
                    <ArtifactVisual row={row} />
                  </span>
                  <span className="gallery-meta block">
                    <span className="gallery-name block">{row.label}</span>
                    <span className="gallery-kind block">{kindLine}</span>
                    <span className="gallery-footer">
                      <span className="dot" data-origin={row.origin} />
                      {row.sessionTitle}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
