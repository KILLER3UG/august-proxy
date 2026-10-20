/* ── ArtifactCard — the reference's artifact card ─────────────────────────── */
/* The reference draws a file the agent produced as ONE compact card in the  */
/* transcript: a tinted icon tile, a bold name, a muted kind line, and on   */
/* the right a filled Download button and a small chevron. The card NEVER   */
/* renders the payload — clicking it opens the artifact's CONTENT in the    */
/* side panel, which is where August's version of the reference's floating  */
/* preview lives.                                                           */
/*                                                                          */
/* ONE grammar for the whole artifact surface: the circuit card (a          */
/* schematic, a netlist, a board render) renders through this component     */
/* too, so the transcript has one card shape and the circuit kinds keep      */
/* working.                                                                  */
/*                                                                          */
/* The tile is a tinted glyph on a soft fill, NOT a bordered box (the        */
/* capture's bar: borders are hairlines, icons are borderless). The brand    */
/* colour comes from lib/file-icon.ts, which paints an image glyph the same  */
/* purple the reference's own image tile uses.                               */

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Copy, Download, FolderOpen, PanelRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FileIcon } from '@/components/ui/FileIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { classifyFileKind, openFileInDrawer } from '@/lib/file-kind';
import { collectProducedFiles, producedFileLabel } from '@/lib/produced-files';
import { circuitArtifactPathKeys, type CircuitToolEntry } from '@/lib/circuit-artifacts';
import { copyFilesToDir, revealInFolder, selectDirectory } from '@/lib/tauri-shell';
import { isTauri } from '@/lib/tauri-detect';
import type { MessageBlock } from '@/types/chat';

/** A file the agent produced, in the terms the card shows. */
interface Artifact {
  path: string;
  /** Basename — the card's bold line. */
  name: string;
  /** The muted kind line: "Image · SVG", "Document · MD". */
  kind: string;
}

/**
 * The deliverables a turn produced.
 *
 * `collectProducedFiles` is the app's one collector for "a file a tool
 * wrote", so this card and the turn's changes card can never disagree about
 * what a turn produced.
 *
 * Two filters, each for a reason:
 *
 *  - A SOURCE FILE IS NOT AN ARTIFACT. A `.ts` file the agent edited is a
 *    DIFF, and the turn's changes card already shows it with its ± counts; a
 *    second card for the same file would say the same thing twice. What the
 *    reference's card is for is the file you OPEN — the picture, the
 *    drawing, the document — so only non-code kinds get a card.
 *
 *  - CIRCUIT FILES BELONG TO THE CIRCUIT CARD. The circuit family has its
 *    own collector (it reads the tool RESULT, which is where a render tool
 *    says what it saved) and its own kinds; a schematic rendered by both
 *    cards would be two cards for one file.
 */
function collectDeliverables(
  blocks?: MessageBlock[] | null,
  tools?: CircuitToolEntry[] | null,
): Artifact[] {
  const circuit = circuitArtifactPathKeys(tools);
  const out: Artifact[] = [];
  const seen = new Set<string>();
  for (const path of collectProducedFiles(blocks)) {
    const key = path.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key) || circuit.has(key)) continue;
    seen.add(key);
    const info = classifyFileKind(path);
    if (info.kind === 'code') continue;
    out.push({ path, name: producedFileLabel(path), kind: info.label });
  }
  return out;
}

export function ArtifactCard({
  path,
  name,
  subline,
  icon,
  sessionId,
  onOpen,
  testId,
}: {
  /** On-disk path — what the preview and the download read. */
  path: string;
  /** The card's bold line. */
  name: string;
  /** The muted line under it: "Image · SVG", "Native schematic". */
  subline: string;
  /** A kind-specific glyph; the file's own icon when absent. */
  icon?: ReactNode;
  /** Owning session — the backend read door for a file outside the shell. */
  sessionId?: string | null;
  /** Replaces the default "open the side panel" behaviour. */
  onOpen?: () => void | Promise<void>;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (onOpen) {
      await onOpen();
      return;
    }
    setBusy(true);
    try {
      await openFileInDrawer(path, sessionId ?? undefined);
    } finally {
      setBusy(false);
    }
  };

  /* The download is the app's own file door: the bytes never cross the
     webview — a Rust copy puts the file in a folder the user picks, exactly
     what the drawer's "Save a copy" and the gallery's "Download all" do. */
  const download = async () => {
    if (!isTauri) {
      toast.message(
        'Downloading needs the desktop build — open August to copy this file into a folder.',
      );
      return;
    }
    const dest = await selectDirectory();
    if (!dest) return; // the picker was dismissed; silence is the answer
    const report = await copyFilesToDir(dest, [path]);
    if (!report || report.copied === 0) {
      toast.error(`Could not download ${name}`);
      return;
    }
    toast.success(`Downloaded ${name}`);
    await revealInFolder(dest);
  };

  const reveal = async () => {
    try {
      await revealInFolder(path);
    } catch {
      toast.error('Could not reveal the file');
    }
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success('Path copied');
    } catch {
      toast.error('Could not copy the path');
    }
  };

  return (
    <div
      className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card/40 p-2"
      data-slot="artifact-card"
      data-testid={testId}
    >
      {/* The name area opens the preview — the reference's behaviour: click
          the artifact, see the artifact. */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => { void open(); }}
        title={`Open ${name} in the side panel`}
        className="h-auto min-w-0 flex-1 shrink justify-start gap-2.5 p-0 text-left font-normal hover:bg-transparent hover:text-foreground"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted/60">
          {icon ?? <FileIcon name={path} size={16} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">{name}</span>
          <span className="block truncate text-2xs text-muted-foreground">{subline}</span>
        </span>
      </Button>

      <Button
        type="button"
        variant="default"
        size="sm"
        onClick={() => { void download(); }}
        title="Copy the file into a folder you pick"
        className="shrink-0"
      >
        <Download />
        Download
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            aria-label={`More actions for ${name}`}
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem className="gap-2" onSelect={() => { void open(); }}>
            <PanelRight className="size-3.5" />
            Open preview
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-2" onSelect={() => { void reveal(); }}>
            <FolderOpen className="size-3.5" />
            Reveal in folder
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-2" onSelect={() => { void copyPath(); }}>
            <Copy className="size-3.5" />
            Copy path
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The turn's artifacts, one card each.
 *
 * Mounted under the answer, in the reference's position. The reference's
 * "row of borderless action icons and the timestamp" below its card is
 * August's own message-actions row, which already renders under the message
 * body — the card inherits it by sitting at the end of the body.
 */
export function ArtifactCards({
  blocks,
  tools,
  sessionId,
}: {
  blocks?: MessageBlock[] | null;
  tools?: CircuitToolEntry[] | null;
  sessionId?: string | null;
}) {
  const artifacts = useMemo(() => collectDeliverables(blocks, tools), [blocks, tools]);
  if (artifacts.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5" data-slot="artifact-cards">
      {artifacts.map((a) => (
        <ArtifactCard
          key={a.path}
          path={a.path}
          name={a.name}
          subline={a.kind}
          sessionId={sessionId}
        />
      ))}
    </div>
  );
}
