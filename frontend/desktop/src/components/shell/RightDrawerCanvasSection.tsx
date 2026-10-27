/* ── Canvas — the session's visual output, in the right drawer ─────────
 *
 * Canvas is the mockup's Chart / Data / Notes panel. It is derived from the
 * same `collectArtifacts` + `loadMessagesForSession` stream the drawer and
 * Artifacts page use; no second artifact model. The chart preview is the
 * newest produced image in this chat, read through ChatAttachmentService so a
 * Tauri path and a backend-only dev path both work.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SignalIcon } from '@/components/ui/SignalIcon';
import { collectArtifacts, type SessionArtifact } from '@/lib/artifacts';
import { useSessionStream } from '@/sections/chat/hooks/useSessionStream';
import { ChatAttachmentService } from '@/sections/chat/services/ChatAttachmentService';
import { openFileInDrawer } from '@/lib/file-kind';
import { closeRightDrawer } from './RightDrawerState';
import { RightDrawerNotesSection } from './RightDrawerNotesSection';
import { dispatchInsertComposerText } from '@/api/ui-events';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { timeAgo } from '@/lib/utils';
import type { FileAttachment } from '@/types/chat';

type CanvasTab = 'chart' | 'data' | 'notes';

const TABS: Array<{ key: CanvasTab; label: string }> = [
  { key: 'chart', label: 'Chart' },
  { key: 'data', label: 'Data' },
  { key: 'notes', label: 'Notes' },
];

function downloadAttachment(file: FileAttachment): void {
  if (!file.dataUrl) return;
  const link = document.createElement('a');
  link.href = file.dataUrl;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function RightDrawerCanvasSection({ sessionId }: { sessionId: string | null }) {
  const navigate = useNavigate();
  const stream = useSessionStream(sessionId);
  const messages = useMemo(() => stream?.messages ?? [], [stream?.messages]);
  const artifacts = useMemo(() => collectArtifacts(messages), [messages]);
  const produced = useMemo(
    () =>
      artifacts
        .filter((artifact) => artifact.origin === 'produced')
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [artifacts],
  );
  const chartArtifact = useMemo(
    () => produced.find((artifact) => artifact.kind === 'image') ?? null,
    [produced],
  );

  const [tab, setTab] = useState<CanvasTab>('chart');
  const [preview, setPreview] = useState<FileAttachment | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!chartArtifact) {
      setPreview(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      let attachment = await ChatAttachmentService.fromPath(chartArtifact.href);
      if (!attachment) {
        attachment = await ChatAttachmentService.fromBackendPath(chartArtifact.href, sessionId ?? undefined);
      }
      if (!cancelled) {
        setPreview(attachment);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chartArtifact, sessionId]);

  const askForChart = () => {
    dispatchInsertComposerText('Create a chart from this thread’s data. Start with the shape, the axes, and the source.', {
      replace: true,
    });
    closeRightDrawer();
  };

  const openArtifact = (artifact: SessionArtifact) => {
    void openFileInDrawer(artifact.href, sessionId ?? undefined);
  };

  const copyPath = () => {
    const path = preview?.path || chartArtifact?.href;
    if (!path) {
      toast.info('No chart file to copy yet.');
      return;
    }
    void navigator.clipboard.writeText(path).then(
      () => toast.success('Chart path copied.'),
      () => toast.error('Could not copy the path.'),
    );
  };

  return (
    <div className="canvas-panel">
      <div className="canvas-toolbar">
        <div className="segmented" role="tablist" aria-label="Canvas view">
          {TABS.map((item) => (
            <Button
              key={item.key}
              variant="bare"
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              data-active={tab === item.key}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <span className="canvas-toolbar-note">
          {sessionId ? 'Session canvas' : 'Canvas'}
        </span>
      </div>

      <div className="canvas-body">
        {tab === 'chart' && (
          <div className="canvas-tab-pane" data-active="true">
            {loading ? (
              <div className="canvas-empty">Loading chart…</div>
            ) : preview?.dataUrl || preview?.previewUrl ? (
              <>
                <div className="canvas-kicker">
                  <span className="live-dot" />
                  Rendered {chartArtifact ? timeAgo(chartArtifact.timestamp) : 'just now'}
                </div>
                <h2 className="canvas-h1">{chartArtifact?.label || preview.name}</h2>
                <p className="canvas-sub">
                  {preview.size || preview.mimeType || 'Image'} · produced by this thread
                </p>
                <div className="chart-stage">
                  <img
                    src={preview.dataUrl || preview.previewUrl}
                    alt={chartArtifact?.label || 'Chart'}
                  />
                </div>
                <div className="canvas-metrics">
                  <div className="metric">
                    <span className="metric-label">Kind</span>
                    <span className="metric-value">PNG</span>
                    <span className="metric-delta">{preview.mimeType || 'image'}</span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">Size</span>
                    <span className="metric-value">{preview.size || '—'}</span>
                    <span className="metric-delta">on disk</span>
                  </div>
                  <div className="metric">
                    <span className="metric-label">Made</span>
                    <span className="metric-value">
                      {chartArtifact ? timeAgo(chartArtifact.timestamp) : 'now'}
                    </span>
                    <span className="metric-delta">this thread</span>
                  </div>
                </div>
                <div className="canvas-section">
                  <div className="canvas-section-head">Readout</div>
                  <div className="insight">
                    The chart is the artifact this turn produced. Open the original to inspect it at
                    full size, or take the file into Charts with the rest of the library.
                  </div>
                </div>
              </>
            ) : chartArtifact ? (
              <>
                <div className="canvas-kicker">Source / {chartArtifact.href}</div>
                <h2 className="canvas-h1">{chartArtifact.label}</h2>
                <p className="canvas-sub">The chart file could not be previewed here.</p>
                <div className="canvas-empty">
                  <Button variant="bare" type="button" className="ghost-button" onClick={() => openArtifact(chartArtifact)}>
                    Open file
                  </Button>
                </div>
              </>
            ) : (
              <div className="canvas-empty canvas-empty--tall">
                <SignalIcon name="chart" size="lg" />
                <p className="canvas-empty-title">No chart in this thread yet</p>
                <p className="canvas-empty-copy">
                  Ask August for a chart and it will land here, beside the conversation that made it.
                </p>
                <Button variant="bare" type="button" className="solid-button" onClick={askForChart}>
                  Ask August for a chart
                </Button>
              </div>
            )}
          </div>
        )}

        {tab === 'data' && (
          <div className="canvas-tab-pane" data-active="true">
            <div className="canvas-kicker">Produced / this thread</div>
            <h2 className="canvas-h1">Files</h2>
            <p className="canvas-sub">{produced.length} file{produced.length === 1 ? '' : 's'} written by August here.</p>
            {produced.length === 0 ? (
              <div className="canvas-empty">Files August produces in this chat appear here.</div>
            ) : (
              <div className="canvas-list">
                {produced.map((artifact) => (
                  <Button
                    key={artifact.id}
                    variant="bare"
                    type="button"
                    onClick={() => openArtifact(artifact)}
                    className="canvas-list-row"
                  >
                    <SignalIcon name="file" />
                    <span className="canvas-list-copy">
                      <strong>{artifact.label}</strong>
                      <span>
                        {artifact.kind} · {timeAgo(artifact.timestamp)}
                      </span>
                    </span>
                    <SignalIcon name="chev-right" />
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'notes' && (
          <div className="canvas-tab-pane canvas-notes" data-active="true">
            <RightDrawerNotesSection sessionId={sessionId} />
          </div>
        )}
      </div>

      <div className="canvas-foot">
        <Button variant="bare" type="button" className="ghost-button" onClick={copyPath}>
          <SignalIcon name="copy" />
          Copy path
        </Button>
        <Button
          variant="bare"
          type="button"
          className="ghost-button"
          onClick={() => preview && downloadAttachment(preview)}
          disabled={!preview?.dataUrl}
        >
          <SignalIcon name="download" />
          Download
        </Button>
        <Button
          variant="bare"
          type="button"
          className="solid-button"
          onClick={() => void navigate('/charts')}
        >
          Open in Charts
          <SignalIcon name="chev-right" />
        </Button>
      </div>
    </div>
  );
}
