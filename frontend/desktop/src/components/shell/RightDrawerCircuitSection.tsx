/* ── RightDrawerCircuitSection ─ /circuit workbench panel ─────────────── */
/* Shows the session's circuit artifacts (netlists, schematics, 3D board    *
 * renders) read off the turn's tool RESULTS via lib/circuit-artifacts —   *
 * the same derived-files pattern the ChangesCard uses, lifted into a       *
 * dedicated drawer section. Images open in the file viewer; netlists and   *
 * bitstreams reveal in folder.                                             */

import { useMemo, useState } from 'react';
import { Cpu, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { FileIcon } from '@/components/ui/FileIcon';
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
  const messages = stream?.messages ?? [];
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
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Cpu className="size-3.5 text-muted-foreground/70" />
        <span className="truncate text-xs font-semibold text-foreground">Circuit workbench</span>
        <span className="ml-auto rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {artifacts.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 chat-scroll">
        {netlists.length > 0 ? (
          <>
            {netlists.length > 1 ? (
              <select
                value={activeNetlist}
                onChange={(e) => setSelectedNetlist(e.target.value)}
                className="mb-2 w-full rounded-md border border-border/60 bg-card/60 px-2 py-1 text-[11px] text-foreground"
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
              className="mb-3"
            />
          </>
        ) : null}
        <CircuitInstruments messages={messages} />
        <CircuitWaveformViewer messages={messages} sessionId={sessionId} />
        {artifacts.length === 0 ? (
          <p className="px-1 py-6 text-center text-[11px] leading-relaxed text-muted-foreground/70">
            No circuit artifacts yet.
            <br />
            Ask August to build a netlist, simulate it, or render the 3D board —
            everything it produces lands here.
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
                    <span className="block truncate text-[12px] font-medium text-foreground">
                      {a.label}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
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
