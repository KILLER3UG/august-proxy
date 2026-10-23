/* ── RightDrawerCircuitSection ─ /circuit workbench panel ─────────────── */
/* Shows the session's circuit artifacts (netlists, schematics, 3D board    *
 * renders) read off the turn's tool RESULTS via lib/circuit-artifacts —   *
 * the same derived-files pattern the ChangesCard uses, lifted into a       *
 * dedicated drawer section. Images open in the file viewer; netlists and   *
 * bitstreams reveal in folder.                                             */

import { lazy, Suspense, useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { FileIcon } from '@/components/ui/FileIcon';
import type { SchematicGraph } from '@/api/circuit';
import {
  openRightDrawerFile,
} from '@/components/shell/RightDrawerState';
import { ChatAttachmentService } from '@/sections/chat/services/ChatAttachmentService';
import { revealInFolder } from '@/lib/tauri-shell';
import {
  BINARY_ARTIFACT_EXT,
  NETLIST_EXT,
  WAVEFORM_EXT,
  artifactsForMessages,
  type CircuitArtifact,
} from '@/lib/circuit-artifacts';
import { useSessionStream } from '@/sections/chat/hooks/useSessionStream';
import { CircuitInstruments } from '@/components/shell/CircuitInstruments';
import { CircuitWaveformViewer } from '@/components/shell/CircuitWaveformViewer';
import { CircuitSchematicEditor } from '@/components/shell/CircuitSchematicEditor';

// three.js is ~570 KB minified and this drawer is not open by default. A static
// import put it in the initial chat chunk for a panel most sessions never use.
const CircuitBreadboard3D = lazy(() =>
  import('@/components/shell/CircuitBreadboard3D').then((m) => ({ default: m.CircuitBreadboard3D })),
);

/** Row subtitle. A tool name is not something to show a user; the artifact's
 *  own kind is. */
function describeArtifact(art: CircuitArtifact): string {
  const p = art.path;
  if (NETLIST_EXT.test(p)) return 'SPICE netlist';
  if (WAVEFORM_EXT.test(p)) return 'Waveform capture';
  if (/\.png$/i.test(p)) return 'Board render';
  if (/\.svg$/i.test(p)) return 'Schematic drawing';
  if (BINARY_ARTIFACT_EXT.test(p)) return 'Compiled bitstream';
  if (/\.json$/i.test(p)) return 'Trace data';
  return 'Circuit artifact';
}

export function RightDrawerCircuitSection({ sessionId }: { sessionId: string | null }) {
  const stream = useSessionStream(sessionId);
  const streamMessages = stream?.messages;
  const messages = useMemo(() => streamMessages ?? [], [streamMessages]);
  const artifacts = useMemo(() => artifactsForMessages(messages), [messages]);
  // The schematic editor edits ONE netlist at a time — the newest by
  // default, switchable from the picker.
  const netlists = useMemo(
    () => artifacts.filter((a) => NETLIST_EXT.test(a.path)),
    [artifacts],
  );
  const [selectedNetlist, setSelectedNetlist] = useState<string>('');
  // Fall back to the newest deck, not the oldest, so the label above matches
  // the behaviour and a deck leaving the list degrades to a real selection.
  const activeNetlist =
    (netlists.find((n) => n.path === selectedNetlist) ?? netlists[netlists.length - 1])?.path ?? '';

  // The 3D stage draws the SAME graph object the schematic editor owns. The
  // editor is the one loader; a second fetch here used to be keyed only on the
  // netlist PATH, so an in-place edit (or a re-run that rewrote the file) left
  // the 3D view showing the previous deck.
  const [graph, setGraph] = useState<SchematicGraph | null>(null);
  const [selectedRef, setSelectedRef] = useState<string>('');
  // A circuit tool that starts or finishes is the moment the deck on disk may
  // have changed. The editor reloads on this signature and reports the graph
  // back up through onGraphChange.
  const graphRevision = useMemo(
    () =>
      messages
        .flatMap((m) => m.tools ?? [])
        .map(
          (t) =>
            `${t.name ?? ''}:${t.startedAt ?? 0}:${t.status ?? ''}:${(t.result ?? '').length}`,
        )
        .join('|'),
    [messages],
  );

  const open = async (path: string) => {
    try {
      if (NETLIST_EXT.test(path) || BINARY_ARTIFACT_EXT.test(path)) {
        await revealInFolder(path);
        return;
      }
      const attachment = await ChatAttachmentService.fromPath(path);
      if (attachment) {
        openRightDrawerFile(attachment);
      } else {
        await revealInFolder(path);
      }
    } catch {
      toast.error('Could not open artifact');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="circuit-panel">
      <div className="min-h-0 flex-1 overflow-y-auto p-2 chat-scroll">
        {netlists.length > 0 ? (
          <>
            {netlists.length > 1 ? (
              <select
                value={activeNetlist}
                onChange={(e) => setSelectedNetlist(e.target.value)}
                className="mb-2 w-full rounded-md border border-border/60 bg-card/60 px-2 py-1 text-2xs text-foreground"
                aria-label="Schematic netlist"
              >
                {netlists.map((n) => (
                  <option key={n.path} value={n.path}>
                    {n.label}
                  </option>
                ))}
              </select>
            ) : null}
            <CircuitSchematicEditor
              sessionId={sessionId}
              netlistPath={activeNetlist}
              revision={graphRevision}
              onGraphChange={setGraph}
              className="mb-3"
            />
            <Suspense
              fallback={
                <div
                  className="mb-3 h-64 animate-pulse rounded-lg border border-border/50 bg-card/40"
                  aria-label="Loading 3D board"
                />
              }
            >
              <CircuitBreadboard3D
                graph={graph}
                selectedRef={selectedRef}
                onSelect={setSelectedRef}
                className="mb-3"
              />
            </Suspense>
          </>
        ) : null}
        <CircuitInstruments messages={messages} />
        <CircuitWaveformViewer messages={messages} sessionId={sessionId} />
        {artifacts.length === 0 ? (
          <p className="px-1 py-6 text-center text-2xs leading-relaxed text-muted-foreground/70">
            No circuit artifacts yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {artifacts.map((a) => (
              <li key={a.path}>
                <button
                  type="button"
                  onClick={() => void open(a.path)}
                  title={`Open — ${a.path}`}
                  className="group flex w-full items-center gap-2 rounded-lg border border-border/50 bg-card/60 px-2.5 py-2 text-left transition hover:border-primary/40 hover:bg-card"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/50">
                    <FileIcon name={a.path} size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.75rem] font-medium text-foreground">
                      {a.label}
                    </span>
                    <span className="block truncate text-2xs text-muted-foreground">
                      {describeArtifact(a)}
                    </span>
                  </span>
                  <FolderOpen className="size-3 shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground/70" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
