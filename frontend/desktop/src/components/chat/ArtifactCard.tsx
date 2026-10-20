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
import {
  ChevronDown,
  Copy,
  Download,
  FileCode,
  FileText,
  FileVideo,
  FolderOpen,
  Image as ImageIcon,
  PanelRight,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { classifyFileKind, openFileInDrawer, type FileKind } from '@/lib/file-kind';
import { collectProducedFiles, producedFileLabel } from '@/lib/produced-files';
import {
  collectResultArtifacts,
  producedFilePath,
  proseFromResult,
} from '@/lib/produced-artifacts';
import {
  artifactPathKey,
  circuitArtifactPathKeys,
  type CircuitToolEntry,
} from '@/lib/circuit-artifacts';
import { setRightDrawerArtifactCaption } from '@/components/shell/RightDrawerState';
import { copyFilesToDir, revealInFolder, selectDirectory } from '@/lib/tauri-shell';
import { isTauri } from '@/lib/tauri-detect';
import { cn } from '@/lib/utils';
import type { MessageBlock } from '@/types/chat';

/**
 * The tile's accent and its glyph, by the file's kind.
 *
 * The reference's tile is a FILLED accent square with a WHITE glyph on it —
 * a filled purple square for an image, a filled blue one for a document. A
 * filled tile is not a bordered box, so the bar's "icons are borderless"
 * still holds; what changed is that the accent is the FILL, not the glyph.
 */
const TILE_ACCENT: Record<FileKind, string> = {
  image: 'bg-violet-600',
  document: 'bg-blue-600',
  pdf: 'bg-blue-600',
  video: 'bg-blue-600',
  code: 'bg-blue-600',
};

const TILE_GLYPH: Record<FileKind, LucideIcon> = {
  image: ImageIcon,
  document: FileText,
  pdf: FileText,
  video: FileVideo,
  code: FileCode,
};

/** A file the agent produced, in the terms the card shows. */
interface Artifact {
  path: string;
  /** Basename — the card's bold line. */
  name: string;
  /** The muted kind line: "Image · SVG", "Document · MD". */
  kind: string;
  /** The producing tool's own words about the file, when it wrote any. */
  caption?: string;
}

/**
 * The deliverables a turn produced.
 *
 * TWO collectors feed ONE list, because a file can be produced two ways:
 *
 *  - the RESULT side (`collectResultArtifacts`): a tool that says in its
 *    RESULT what it made — `create_html_artifact`, a pptx deck, a tool of
 *    someone's own. Reading the result is what keeps a `read_file` out: it
 *    carries a path ARGUMENT and produces nothing.
 *  - the ARGUMENT side (`collectProducedFiles`): an edit-classified call
 *    that wrote a file. Its result is often the bare word "ok", so the path
 *    is only in the arguments — and the call's CLASS is what says the file
 *    was written.
 *
 * Both are de-duplicated by path, so a tool whose result names the file its
 * arguments named is ONE card.
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
  const out = new Map<string, Artifact>();
  /* `reported` is the difference between the two sides.
   *
   * The RESULT side: a tool that says "I saved decoder_3to8.v" is
   * DELIVERING that file, whatever the app's extension list knows about
   * .v. The kind still chooses the tile and the kind line; it does not
   * decide whether the file is shown.
   *
   * The ARGUMENT side: a path in an edit-classified call's input. That is
   * a diff as often as it is a deliverable - a .ts the agent edited is
   * the changes card's row - so only a non-code kind gets a card here. */
  const add = (path: string, caption?: string, reported = false) => {
    const key = artifactPathKey(path);
    if (out.has(key) || circuit.has(key)) return;
    const info = classifyFileKind(path);
    if (!reported && info.kind === 'code') return;
    out.set(key, { path, name: producedFileLabel(path), kind: info.label, caption });
  };
  // The result side first: it is the side that knows the tool's prose.
  for (const produced of collectResultArtifacts(tools)) {
    add(produced.path, produced.caption, true);
  }
  /* The argument side: the path is in the call's input, so the caption —
     the tool's own sentence about what it made — has to come from the SAME
     call. The rule for "this call wrote a file" is the collector's own, so
     the phrase, the cards and this caption cannot disagree. */
  const prose = new Map<string, string>();
  for (const t of tools ?? []) {
    const written = producedFilePath(t.name ?? '', t.context);
    if (!written) continue;
    const line = proseFromResult(t.result);
    if (line) prose.set(artifactPathKey(written), line);
  }
  for (const path of collectProducedFiles(blocks)) {
    add(path, prose.get(artifactPathKey(path)));
  }
  return [...out.values()];
}

export function ArtifactCard({
  path,
  name,
  subline,
  caption,
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
  /** The producing tool's own words about the file, when it wrote any. */
  caption?: string;
  /** A kind-specific glyph; the file's own icon when absent. */
  icon?: ReactNode;
  /** Owning session — the backend read door for a file outside the shell. */
  sessionId?: string | null;
  /** Replaces the default "open the side panel" behaviour. */
  onOpen?: () => void | Promise<void>;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const kind = classifyFileKind(path).kind;
  const Glyph = TILE_GLYPH[kind];

  const open = async () => {
    if (onOpen) {
      await onOpen();
      return;
    }
    setBusy(true);
    try {
      await openFileInDrawer(path, sessionId ?? undefined);
      /* The reference's panel carries a muted line of prose under the
         content — the producing tool's own words about what it made. A tool
         that wrote none has no caption, and none is invented. */
      if (caption) setRightDrawerArtifactCaption(caption);
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
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-lg text-white',
            TILE_ACCENT[kind],
          )}
        >
          {icon ?? <Glyph className="size-4" />}
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

  /* The reference puts "Download all" ABOVE the cards when a turn produced
     more than one file. It is the same door the per-card button and the
     drawer's gallery use: a folder the user picks, and a Rust copy — the
     bytes never cross the webview. */
  const downloadAll = async () => {
    if (!isTauri) {
      toast.message(
        'Downloading needs the desktop build — open August to copy these files into a folder.',
      );
      return;
    }
    const dest = await selectDirectory();
    if (!dest) return; // the picker was dismissed; silence is the answer
    const report = await copyFilesToDir(dest, artifacts.map((a) => a.path));
    if (!report || report.copied === 0) {
      toast.error('Could not download the files');
      return;
    }
    const parts = [`Copied ${report.copied} of ${artifacts.length}`];
    if (report.failed > 0) parts.push(`${report.failed} failed`);
    if (report.skipped > 0) parts.push(`${report.skipped} skipped (name already taken)`);
    toast.success(parts.join(' · '));
    await revealInFolder(dest);
  };

  if (artifacts.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5" data-slot="artifact-cards">
      {artifacts.length > 1 ? (
        <div className="flex items-center justify-start">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { void downloadAll(); }}
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            title="Copy the shown files into a folder you pick"
            data-testid="artifact-download-all"
          >
            <Download className="size-3.5" />
            Download all
          </Button>
        </div>
      ) : null}
      {artifacts.map((a) => (
        <ArtifactCard
          key={a.path}
          path={a.path}
          name={a.name}
          subline={a.kind}
          caption={a.caption}
          sessionId={sessionId}
        />
      ))}
    </div>
  );
}
