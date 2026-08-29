/* ── CircuitArtifactCard ─ Claude-style clickable artifact card ───────── */
/* Chat shows ONE compact card per circuit deliverable (schematic, 3D      */
/* board render, netlist, simulation report). Clicking opens the actual    */
/* content in the right-drawer viewer / Circuit panel — the chat area      */
/* never renders the payload itself, matching the Claude artifact pattern. */

import { useMemo } from 'react';
import { Cpu, FileText, Image as ImageIcon, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';
import { openRightDrawerFile, addRightDrawerSection } from '@/components/shell/RightDrawerState';
import { ChatAttachmentService } from '@/sections/chat/services/ChatAttachmentService';
import { revealInFolder } from '@/lib/tauri-shell';
import type { MessageBlock } from '@/types/chat';

interface CircuitDeliverable {
  path: string;
  label: string;
  kind: 'schematic' | 'board3d' | 'netlist' | 'simulation' | 'waveform' | 'firmware';
  detail: string;
}

const NETLIST_EXT = /\.(cir|net|ckt|sp)$/i;

function kindOf(path: string): CircuitDeliverable['kind'] {
  if (NETLIST_EXT.test(path)) return 'netlist';
  if (/\.vcd$/i.test(path)) return 'waveform';
  if (/\.hex$/i.test(path)) return 'firmware';
  if (/\.glb$|3d|board/i.test(path)) return 'board3d';
  if (/_sim\b|sim\.txt|\.csv$|\.xml$/i.test(path)) return 'simulation';
  return 'schematic';
}

const KIND_ICON = {
  schematic: ImageIcon,
  board3d: Cpu,
  netlist: FileText,
  simulation: Activity,
  waveform: Activity,
  firmware: Cpu,
} as const;

const CIRCUIT_TOOLS = /^(circuit_|firmware_|hdl_|vcd_parse|fpga_compile|kicad_)/i;
// Bitstreams and 3D models have no inline renderer (see RightDrawerCircuitSection).
const BINARY_ARTIFACT_EXT = /\.(sof|pof|glb|uf2)$/i;

/** Derive circuit deliverables from the turn's circuit-family tool blocks. */
export function collectCircuitDeliverables(blocks?: MessageBlock[] | null): CircuitDeliverable[] {
  if (!blocks) return [];
  const seen = new Set<string>();
  const out: CircuitDeliverable[] = [];
  for (const block of blocks) {
    if (block.type !== 'toolCall' || !block.tool) continue;
    const name = block.tool.name || '';
    if (!CIRCUIT_TOOLS.test(name)) continue;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(block.tool.context || '{}') as Record<string, unknown>;
    } catch {
      /* context not JSON — args may still carry path below */
    }
    const path =
      firstString(parsed.path) ??
      firstString(parsed.savedTo) ??
      firstString(parsed.hexFile) ??
      firstString(parsed.waveFile) ??
      firstString(parsed.sofFile) ??
      firstString(parsed.svgFile) ??
      firstString(parsed.junitFile) ??
      firstString(parsed.renderedFile) ??
      null;
    if (!path) continue;
    const key = path.replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = kindOf(key);
    out.push({
      path,
      label: key.split('/').pop() || path,
      kind,
      detail:
        kind === 'simulation'
          ? `${parsed.measureCount ?? Object.keys((parsed.measures as object) ?? {}).length} measures`
          : kind === 'board3d'
            ? `${parsed.componentCount ?? '?'} components`
            : kind === 'netlist'
              ? `${parsed.lines ?? '?'} lines · SPICE`
              : kind === 'waveform'
                ? `${parsed.durationSec != null ? `${parsed.durationSec} s · ` : ''}VCD capture`
                : kind === 'firmware'
                  ? 'AVR firmware · HEX'
                  : 'schemdraw render',
    });
  }
  return out;
}

function firstString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function CircuitArtifactCard({ blocks }: { blocks?: MessageBlock[] | null }) {
  const items = useMemo(() => collectCircuitDeliverables(blocks), [blocks]);
  if (items.length === 0) return null;

  const open = async (path: string) => {
    try {
      if (/\.vcd$/i.test(path)) {
        // Waveforms belong in the Circuit panel's embedded viewer.
        addRightDrawerSection('circuit');
        return;
      }
      if (BINARY_ARTIFACT_EXT.test(path)) {
        // Bitstreams/3D models have no inline renderer — show them in
        // the file manager instead of mojibake.
        await revealInFolder(path);
        return;
      }
      // Netlists, images, HEX, reports open the file viewer as text/preview;
      // the Circuit panel stays one click away via "Open workbench".
      const attachment = await ChatAttachmentService.fromPath(path);
      if (attachment) openRightDrawerFile(attachment);
      else addRightDrawerSection('circuit');
    } catch {
      /* viewer failure falls back silently — chip is non-critical UI */
    }
  };

  return (
    <div className="mt-2.5" data-slot="circuit-artifact-card">
      <span className="mb-1 block text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60">
        Circuit
      </span>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => {
          const Icon = KIND_ICON[item.kind];
          return (
            <button
              key={item.path}
              type="button"
              onClick={() => void open(item.path)}
              title={`Open in side panel — ${item.path}`}
              data-testid={`circuit-chip-${item.kind}`}
              className={cn(
                'group flex min-w-[200px] max-w-[280px] items-center gap-2.5 rounded-xl border border-border/60 bg-card/60 px-3 py-2 text-left transition',
                'hover:border-primary/40 hover:bg-card cursor-pointer',
              )}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-foreground">
                  {item.label}
                </span>
                <span className="block truncate text-[10.5px] text-muted-foreground">
                  {item.detail}
                </span>
              </span>
              <span
                className="shrink-0 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[10px] font-medium text-muted-foreground transition group-hover:border-primary/40 group-hover:text-primary"
                title="Open in the right side panel"
              >
                Open panel ↗
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => addRightDrawerSection('circuit')}
          className="self-center rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground"
          title="Open the Circuit workbench panel"
        >
          Open workbench
        </button>
      </div>
    </div>
  );
}
