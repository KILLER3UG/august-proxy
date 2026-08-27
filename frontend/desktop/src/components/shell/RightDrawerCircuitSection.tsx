/* ── RightDrawerCircuitSection ─ /circuit workbench panel ─────────────── */
/* Shows the session's circuit artifacts (netlists, schematics, 3D board  *
 * renders) pulled from the turn's tool-call blocks — the same derived-   *
 * files pattern the ChangesCard uses, lifted into a dedicated drawer     *
 * section. Images open in the file viewer; netlists reveal in folder.    */

import { useMemo } from 'react';
import { Cpu, FolderOpen, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { FileIcon } from '@/components/ui/FileIcon';
import {
  openRightDrawerFile,
} from '@/components/shell/RightDrawerState';
import { ChatAttachmentService } from '@/sections/chat/services/ChatAttachmentService';
import { revealInFolder } from '@/lib/tauri-shell';
import { useSessionStream } from '@/sections/chat/hooks/useSessionStream';
import type { MessageBlock } from '@/types/chat';

const CIRCUIT_TOOLS = /^circuit_/i;
const NETLIST_EXT = /\.(cir|net|ckt|sp)$/i;

interface CircuitArtifact {
  path: string;
  label: string;
  kind: 'netlist' | 'image' | 'other';
  tool: string;
}

function collectCircuitArtifacts(blocks?: MessageBlock[] | null): CircuitArtifact[] {
  if (!blocks) return [];
  const seen = new Set<string>();
  const out: CircuitArtifact[] = [];
  for (const block of blocks) {
    if (block.type !== 'toolCall' || !block.tool) continue;
    const name = block.tool.name || '';
    if (!CIRCUIT_TOOLS.test(name)) continue;
    let path: string | null = null;
    try {
      const parsed = JSON.parse(block.tool.context || '{}') as Record<string, unknown>;
      for (const key of ['path', 'filePath', 'savedTo']) {
        const v = parsed[key];
        if (typeof v === 'string' && v.length > 0) {
          path = v;
          break;
        }
      }
    } catch {
      /* context not JSON */
    }
    if (!path) continue;
    const key = path.replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    const kind: CircuitArtifact['kind'] = NETLIST_EXT.test(key)
      ? 'netlist'
      : /\.png$/i.test(key)
        ? 'image'
        : 'other';
    out.push({
      path,
      label: key.split('/').pop() || path,
      kind,
      tool: name,
    });
  }
  return out;
}

export function RightDrawerCircuitSection({ sessionId }: { sessionId: string | null }) {
  const stream = useSessionStream(sessionId);
  const messages = stream?.messages ?? [];
  const artifacts = useMemo(
    () => messages.flatMap((m) => collectCircuitArtifacts(m.blocks)),
    [messages],
  );
  const busy = false;

  const open = async (path: string) => {
    try {
      if (NETLIST_EXT.test(path)) {
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
                  disabled={busy}
                  title={`Open — ${a.path}`}
                  className="group flex w-full items-center gap-2 rounded-lg border border-border/50 bg-card/60 px-2.5 py-2 text-left transition hover:border-primary/40 hover:bg-card"
                >
                  {busy ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/50">
                      <FileIcon name={a.path} size={14} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-foreground">
                      {a.label}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {a.kind === 'netlist'
                        ? 'SPICE netlist'
                        : a.kind === 'image'
                          ? 'render'
                          : a.tool.replace(/^circuit_/, '')}
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
