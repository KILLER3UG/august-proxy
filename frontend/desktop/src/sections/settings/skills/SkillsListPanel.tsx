/* Catalog list: stat tiles, hub install panel, search, card grid, curator controls. */

import {
  Archive,
  BookOpen,
  CheckCircle,
  Clock,
  Info,
  RefreshCw,
  Search,
} from 'lucide-react';
import { SkillsHubPanel } from '../SkillsHubPanel';
import { SkillCard } from './SkillCard';
import { StatTile } from './StatTile';
import type { CuratorReport, SkillRow, SkillSummary } from './types';

export function SkillsListPanel({
  filteredRows,
  search,
  skills,
  activeCount,
  staleCount,
  archivedCount,
  trackedCount,
  running,
  report,
  onSearch,
  onOpen,
  onTogglePin,
  onArchive,
  onRestore,
  onRunCurator,
  onInstalled,
}: {
  filteredRows: SkillRow[];
  search: string;
  skills: SkillSummary[];
  activeCount: number;
  staleCount: number;
  archivedCount: number;
  trackedCount: number;
  running: boolean;
  report: CuratorReport | null;
  onSearch: (q: string) => void;
  onOpen: (name: string) => void;
  onTogglePin: (name: string, pinned: boolean) => void;
  onArchive: (name: string) => void;
  onRestore: (name: string) => void;
  onRunCurator: (dryRun: boolean) => void;
  onInstalled: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto space-y-6">
      {report && (
        <div className="rounded-lg border border-border/60 bg-card p-4 text-sm space-y-1">
          <p className="font-medium">Curation run complete</p>
          <p className="text-muted-foreground">
            {report.staled.length > 0 ? `Staled: ${report.staled.join(', ')}. ` : 'No skills staled. '}
            {report.archived.length > 0
              ? `Archived: ${report.archived.join(', ')}. `
              : 'No skills archived. '}
            {report.errors.length > 0 && `Errors: ${report.errors.join(', ')}.`}
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile icon={<CheckCircle className="size-4" />} label="Active" value={activeCount} />
        <StatTile
          icon={<Clock className="size-4" />}
          label="Stale"
          value={staleCount}
          tone={staleCount > 0 ? 'warn' : 'muted'}
        />
        <StatTile icon={<Archive className="size-4" />} label="Archived" value={archivedCount} />
        <StatTile icon={<BookOpen className="size-4" />} label="Tracked" value={trackedCount} />
      </div>

      <SkillsHubPanel
        installedNames={new Set(skills.map((s) => s.name))}
        onInstalled={onInstalled}
      />

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search skills…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="w-full rounded-lg border border-white/[0.08] bg-white/[0.06] pl-10 pr-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30 shadow-none"
        />
      </div>

      {filteredRows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-6 py-12 text-center">
          <BookOpen className="mb-3 size-10 p-1 rounded-full bg-muted/40 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            {search ? 'No skills match your search.' : 'No skills yet.'}
          </p>
          <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
            Click <span className="font-medium">New</span> to author your first skill.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="skills-card-grid">
          {filteredRows.map((r) => (
            <SkillCard
              key={r.name}
              row={r}
              onOpen={() => onOpen(r.name)}
              onTogglePin={() => onTogglePin(r.name, r.pinned)}
              onArchive={() => onArchive(r.name)}
              onRestore={() => onRestore(r.name)}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border/60 bg-card px-5 py-4">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Lifecycle</p>
            <p>Skills auto-archive after 60 days of no use. Pin to keep.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onRunCurator(false)}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-sm text-foreground hover:bg-muted/50 disabled:opacity-50"
          >
            <RefreshCw className={`size-4 ${running ? 'animate-spin' : ''}`} />
            Run
          </button>
          <button
            onClick={() => onRunCurator(true)}
            disabled={running}
            className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-sm text-foreground hover:bg-muted/50 disabled:opacity-50"
          >
            Dry run
          </button>
        </div>
      </div>
    </div>
  );
}
