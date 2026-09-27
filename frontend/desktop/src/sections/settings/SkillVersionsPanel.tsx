/* ── SkillVersionsPanel — a skill's version history, read-only (audit #13) */
/* Lists the snapshots `skill_versions.snapshot_before_write` preserved beside
 * the file, and shows one of them as a unified diff against the CURRENT
 * SKILL.md.
 *
 * Why the diff hangs off the live file and not off the next-newer snapshot:
 * the question a reader actually has is "what did I lose when this was
 * replaced", and the file on disk now is the only honest other end of that
 * comparison. One consequence the UI leans on: an EMPTY diff means the
 * selected snapshot is byte-identical to what is live, which answers the
 * "is this the version in force?" question without hashing anything here.
 *
 * There is no revert / restore here, and that is a decision rather than a
 * gap. The backend exposes no such endpoint, so any button offering one would
 * be a second write path invented in the UI — inventing write paths is
 * exactly how a history stops agreeing with the file it versions. This
 * surface only reads.
 *
 * The list is fetched per skill and cached by React Query, so re-opening a
 * detail pane costs nothing and switching skills is instant.                  */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History, Loader2 } from 'lucide-react';
import {
  formatVersionStamp,
  getSkillVersionDiff,
  listSkillVersions,
  type SkillVersionEntry,
} from '@/api/api-client/skills-versions';
import { DiffView } from '@/components/chat/DiffView';
import { QueryErrorState } from '@/components/QueryErrorState';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SkillVersionsPanelProps {
  /** Skill name — also the path segment, encoded by the client. */
  name: string;
  /** Project scope path; '' / undefined means the global scope. */
  workspace?: string;
}

export function SkillVersionsPanel({ name, workspace }: SkillVersionsPanelProps) {
  const [selectedTs, setSelectedTs] = useState<string | null>(null);

  const versionsQ = useQuery({
    queryKey: ['skill-versions', name, workspace ?? ''],
    queryFn: () => listSkillVersions(name, workspace),
    // A version only appears when something overwrote the file, and a
    // snapshot is immutable once written — there is nothing to re-poll for.
    staleTime: 5 * 60_000,
  });

  const versions = versionsQ.data?.versions ?? [];
  const selected = versions.find((v) => v.ts === selectedTs) ?? null;

  // Only the SELECTED version is diffed: one request per click, and an
  // unselected history never costs anything.
  const diffQ = useQuery({
    queryKey: ['skill-version-diff', name, workspace ?? '', selectedTs],
    queryFn: () => getSkillVersionDiff(name, selectedTs as string, workspace),
    enabled: Boolean(selectedTs),
  });

  return (
    <section data-testid="skill-versions-panel">
      <h3 className="mb-2 flex items-center gap-1.5 text-[0.65625rem] font-semibold uppercase tracking-widest text-muted-foreground/55">
        <History className="size-3" aria-hidden />
        Version history
      </h3>

      {versionsQ.isLoading ? (
        <p className="flex items-center gap-2 text-2xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Loading versions…
        </p>
      ) : versionsQ.isError ? (
        <QueryErrorState
          compact
          error={versionsQ.error}
          onRetry={() => void versionsQ.refetch()}
          retrying={versionsQ.isRefetching}
          title="Couldn't load version history"
          note="This skill may still have earlier versions — the request failed, so this is not an empty history."
        />
      ) : versions.length === 0 ? (
        <p className="text-2xs leading-relaxed text-muted-foreground/70">
          No earlier version is retained. A snapshot is taken the moment this
          file is overwritten, so an untouched skill has nothing here.
        </p>
      ) : (
        <div className="space-y-3">
          <ul className="divide-y divide-white/[0.06] border-y border-white/[0.06]" data-testid="skill-version-list">
            {versions.map((v) => (
              <li key={v.ts}>
                <VersionRow
                  version={v}
                  selected={v.ts === selectedTs}
                  onSelect={() => setSelectedTs((cur) => (cur === v.ts ? null : v.ts))}
                />
              </li>
            ))}
          </ul>
          {selected && <VersionDiff version={selected} diffQ={diffQ} />}
        </div>
      )}
    </section>
  );
}

/** One snapshot: when, who replaced it and why, and the content hash. The
 *  hash is shown as a short fingerprint only — it is the server's way of
 *  saying "this is exactly the bytes that were saved", and the full value
 *  belongs in a bug report, not in a settings pane. */
function VersionRow({
  version,
  selected,
  onSelect,
}: {
  version: SkillVersionEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onSelect}
      aria-expanded={selected}
      data-testid={`skill-version-${version.ts}`}
      className={cn(
        'h-auto w-full justify-start gap-2 px-1 py-2 text-left',
        selected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-2xs font-medium text-foreground">
            {formatVersionStamp(version.ts)}
          </span>
          <span className="text-3xs text-muted-foreground">
            {version.actor || 'unknown writer'}
          </span>
          {version.sha && (
            <span
              className="font-mono text-3xs text-muted-foreground/60"
              title={`SHA-256 of this snapshot: ${version.sha}`}
            >
              {version.sha.slice(0, 7)}
            </span>
          )}
        </span>
        {version.rationale && (
          <span className="mt-0.5 block text-3xs leading-relaxed text-muted-foreground/80">
            {version.rationale}
          </span>
        )}
      </span>
      <span className="shrink-0 text-3xs text-muted-foreground/60">
        {selected ? 'Hide diff' : 'Show diff'}
      </span>
    </Button>
  );
}

/** The selected version's diff against the live file. */
function VersionDiff({
  version,
  diffQ,
}: {
  version: SkillVersionEntry;
  diffQ: {
    data?: { diff: string };
    isLoading: boolean;
    isError: boolean;
    isRefetching: boolean;
    error: unknown;
    refetch: () => Promise<unknown>;
  };
}) {
  const diff = diffQ.data?.diff;

  return (
    <div data-testid="skill-version-diff">
      <p className="mb-1.5 text-3xs text-muted-foreground/70">
        {formatVersionStamp(version.ts)} against the current{' '}
        <span className="font-mono">SKILL.md</span>
      </p>
      {diffQ.isLoading ? (
        <p className="flex items-center gap-2 text-2xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Loading diff…
        </p>
      ) : diffQ.isError ? (
        <QueryErrorState
          compact
          error={diffQ.error}
          onRetry={() => void diffQ.refetch()}
          retrying={diffQ.isRefetching}
          title="Couldn't load this diff"
          note="The version is still listed above — only its diff failed to load."
        />
      ) : diff === undefined || diff === '' ? (
        // The server returns '' for a snapshot identical to the live file.
        // Saying "no changes" here is the answer, not a blank panel.
        <p
          className="rounded-md border border-white/[0.06] bg-black/20 px-2.5 py-2 text-2xs leading-relaxed text-muted-foreground"
          data-testid="skill-version-identical"
        >
          No differences — this snapshot is exactly what the current file says.
        </p>
      ) : (
        <DiffView diff={diff} maxLines={60} />
      )}
    </div>
  );
}
