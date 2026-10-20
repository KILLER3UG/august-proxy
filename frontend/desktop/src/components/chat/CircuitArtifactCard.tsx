/* ── CircuitArtifactCard ─ circuit deliverables, one card each ─────────── */
/* The circuit family (schematic, 3D board render, netlist, simulation,    */
/* waveform, firmware) has its own collector: it reads the tool RESULT,    */
/* which is where a render tool says what it saved.                         */
/*                                                                          */
/* The cards render through the shared ArtifactCard, so the transcript has   */
/* ONE artifact card shape — and the general artifact card skips these paths */
/* (circuitArtifactPathKeys), so a schematic is never drawn twice.           */
/*                                                                          */
/* Clicking a card opens the artifact's CONTENT in the side panel — never   */
/* inline in the chat, matching the Claude artifact pattern.                */

import { useMemo } from 'react';
import { Cpu, FileText, Image as ImageIcon, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openRightDrawerFile, addRightDrawerSection } from '@/components/shell/RightDrawerState';
import { ChatAttachmentService } from '@/sections/chat/services/ChatAttachmentService';
import { revealInFolder } from '@/lib/tauri-shell';
import {
  BINARY_ARTIFACT_EXT,
  NETLIST_EXT,
  collectArtifacts,
  type CircuitArtifact,
  type CircuitToolEntry,
} from '@/lib/circuit-artifacts';
import { ArtifactCard } from './ArtifactCard';

interface CircuitDeliverable {
  path: string;
  label: string;
  kind: 'schematic' | 'board3d' | 'netlist' | 'simulation' | 'waveform' | 'firmware';
  detail: string;
}

function kindOf(path: string): CircuitDeliverable['kind'] {
  if (NETLIST_EXT.test(path)) return 'netlist';
  if (/\.vcd$/i.test(path)) return 'waveform';
  if (/\.hex$/i.test(path)) return 'firmware';
  if (/\.glb$|3d|board/i.test(path)) return 'board3d';
  if (/_sim\b|sim\.txt|\.csv$|\.xml$/i.test(path)) return 'simulation';
  // 'schematic' is the catch-all, so an .svg lands here by default. The
  // per-tool copy under the label is what distinguishes them now.
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

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** What the card says under the filename. Every count here is a RESULT key
 *  (`lines`, `componentCount`, `measures`) — reading them off the tool's
 *  arguments is what made every card render "? lines" / "? components". */
function detailFor(kind: CircuitDeliverable['kind'], art: CircuitArtifact): string {
  const d = art.data;
  switch (kind) {
    case 'simulation': {
      const count =
        num(d.measureCount) ??
        (d.measures && typeof d.measures === 'object' ? Object.keys(d.measures).length : null);
      return count != null ? `${count} measure${count === 1 ? '' : 's'}` : 'Simulation run';
    }
    case 'board3d': {
      const count = num(d.componentCount);
      return count != null ? `${count} components` : 'Board render';
    }
    case 'netlist': {
      const lines = num(d.lines);
      return lines != null ? `${lines} lines · SPICE` : 'SPICE netlist';
    }
    case 'waveform':
      return num(d.durationSec) != null ? `${d.durationSec} s · VCD capture` : 'VCD capture';
    case 'firmware':
      return 'AVR firmware · HEX';
    default:
      if (art.tool === 'circuit_render_logic') {
        const gates = num(art.data.gates);
        return gates != null ? `${gates} gates` : 'Logic schematic';
      }
      return art.tool === 'circuit_render_schematic'
        ? 'Native schematic'
        : 'Schematic drawing';
  }
}

/** Derive circuit deliverables from the turn's circuit-family tool results. */
export function collectCircuitDeliverables(
  tools?: CircuitToolEntry[] | null,
): CircuitDeliverable[] {
  return collectArtifacts(tools).map((art) => {
    const kind = kindOf(art.path);
    return {
      path: art.path,
      label: art.label,
      kind,
      detail: detailFor(kind, art),
    };
  });
}

export function CircuitArtifactCard({ tools }: { tools?: CircuitToolEntry[] | null }) {
  const items = useMemo(() => collectCircuitDeliverables(tools), [tools]);
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
      {/* A group label, in sentence case — the capture's bar says section
          labels are small, muted and NOT uppercase. */}
      <span className="mb-1.5 block text-2xs font-semibold text-muted-foreground/70">
        Circuit
      </span>
      <div className="space-y-1.5">
        {items.map((item) => {
          const Icon = KIND_ICON[item.kind];
          return (
            <ArtifactCard
              key={item.path}
              path={item.path}
              name={item.label}
              subline={item.detail}
              icon={<Icon className="size-4 text-muted-foreground" />}
              onOpen={() => open(item.path)}
              testId={`circuit-chip-${item.kind}`}
            />
          );
        })}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => addRightDrawerSection('circuit')}
        className="mt-1.5 h-auto px-1.5 py-0.5 text-2xs font-normal text-muted-foreground/70 hover:text-foreground"
        title="Open the Circuit workbench panel"
      >
        Open workbench
      </Button>
    </div>
  );
}
