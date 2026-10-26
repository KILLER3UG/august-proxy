/* ── Canvas — the session's visual output, in the right drawer ─────────
 *
 * Canvas is the mockup's Chart / Data / Notes panel. It is derived from the
 * same `collectArtifacts` + `loadMessagesForSession` stream the drawer and
 * Artifacts page use; no second artifact model. The chart preview is the
 * newest produced image in this chat, read through ChatAttachmentService so a
 * Tauri path and a backend-only dev path both work.
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Download, FileText, Image as ImageIcon, LineChart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { collectArtifacts, type SessionArtifact } from '@/lib/artifacts';
import { useSessionStream } from '@/sections/chat/hooks/useSessionStream';
import { ChatAttachmentService } from '@/sections/chat/services/ChatAttachmentService';
import { openFileInDrawer } from '@/lib/file-kind';
import { closeRightDrawer } from './RightDrawerState';
import { RightDrawerNotesSection } from './RightDrawerNotesSection';
import { dispatchInsertComposerText } from '@/api/ui-events';
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-1">
        <div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5" role="tablist" aria-label="Canvas view">
          {TABS.map((item) => (
            <Button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              variant="ghost"
              size="sm"
              onClick={() => setTab(item.key)}
              className={`h-6 rounded px-2 text-[0.68rem] font-normal ${
                tab === item.key ? 'bg-muted text-foreground' : 'text-muted-foreground/60'
              }`}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[0.58rem] uppercase tracking-[0.1em] text-muted-foreground/40">
          {sessionId ? 'Session canvas' : 'Canvas'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {tab === 'chart' && (
          <div>
            {loading ? (
              <div className="flex h-40 items-center justify-center text-xs text-muted-foreground/60">
                Loading chart…
              </div>
            ) : preview?.dataUrl || preview?.previewUrl ? (
              <div className="rounded-xl border border-border/55 bg-card/35 p-2">
                <img
                  src={preview.dataUrl || preview.previewUrl}
                  alt={chartArtifact?.label || 'Chart'}
                  className="max-h-[420px] w-full rounded-lg bg-muted/20 object-contain"
                />
                <div className="flex items-start gap-2 px-1 pt-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.78rem] font-medium text-foreground/90">
                      {chartArtifact?.label || preview.name}
                    </p>
                    <p className="mt-0.5 font-mono text-[0.6rem] text-muted-foreground/50">
                      {preview.size || preview.mimeType || 'Image'} · {chartArtifact ? timeAgo(chartArtifact.timestamp) : 'just now'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground/60"
                    onClick={() => chartArtifact && openArtifact(chartArtifact)}
                    title="Open the original file"
                    aria-label="Open the original chart file"
                  >
                    <ArrowUpRight className="size-3.5" />
                  </Button>
                  {preview.dataUrl && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-muted-foreground/60"
                      onClick={() => downloadAttachment(preview)}
                      title="Download the chart"
                      aria-label="Download the chart"
                    >
                      <Download className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ) : chartArtifact ? (
              <div className="rounded-xl border border-border/55 bg-card/35 p-4">
                <div className="flex items-center gap-2 text-sm text-foreground">
                  <ImageIcon className="size-4 text-muted-foreground/60" />
                  <span className="min-w-0 flex-1 truncate">{chartArtifact.label}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  The chart file could not be previewed here. Open the original to inspect it.
                </p>
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => openArtifact(chartArtifact)}>
                  Open file
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 px-5 py-12 text-center">
                <LineChart className="size-6 text-muted-foreground/35" />
                <p className="mt-3 text-[0.8rem] font-medium text-foreground/80">No chart in this thread yet</p>
                <p className="mt-1 max-w-[240px] text-[0.7rem] leading-relaxed text-muted-foreground/50">
                  Ask August for a chart and it will land here, beside the conversation that made it.
                </p>
                <Button type="button" size="sm" className="mt-4" onClick={askForChart}>
                  Ask August for a chart
                </Button>
              </div>
            )}
          </div>
        )}

        {tab === 'data' && (
          <div>
            {produced.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 px-5 py-10 text-center text-xs text-muted-foreground/60">
                Files August produces in this chat appear here.
              </div>
            ) : (
              <div className="divide-y divide-border/40 rounded-xl border border-border/55 bg-card/25">
                {produced.map((artifact) => (
                  <Button
                    key={artifact.id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openArtifact(artifact)}
                    className="h-auto w-full items-center justify-start gap-2.5 rounded-none px-3 py-2.5 text-left font-normal"
                  >
                    <FileText className="size-3.5 shrink-0 text-muted-foreground/55" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.75rem] text-foreground/85">{artifact.label}</span>
                      <span className="mt-0.5 block font-mono text-[0.58rem] text-muted-foreground/45">
                        {artifact.kind} · {timeAgo(artifact.timestamp)}
                      </span>
                    </span>
                    <ArrowUpRight className="size-3 shrink-0 text-muted-foreground/35" />
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'notes' && (
          <div className="h-[calc(100%-0.25rem)] min-h-[320px]">
            <RightDrawerNotesSection sessionId={sessionId} />
          </div>
        )}
      </div>
    </div>
  );
}
