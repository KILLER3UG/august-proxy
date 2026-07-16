import { useQuery } from '@tanstack/react-query';
import { ExternalLink, GitCommitHorizontal, Package, RefreshCw, X } from 'lucide-react';
import { api } from '@/api/client';
import { Backdrop } from '@/components/overlays/Backdrop';
import { formatTimeAgo } from '@/lib/utils';
import { openExternal } from '@/lib/tauri-shell';

export interface WhatsNewCommit {
  sha: string;
  fullSha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface WhatsNewRelease {
  tag: string;
  name: string;
  body: string;
  date: string;
  url: string;
  prerelease: boolean;
}

export interface WhatsNewResponse {
  repo: string;
  hours: number;
  since: string;
  commits: WhatsNewCommit[];
  releases: WhatsNewRelease[];
  repoUrl: string;
  errors: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function WhatsNewModal({ open, onClose }: Props) {
  const query = useQuery({
    queryKey: ['whats-new', 48],
    queryFn: () => api.get<WhatsNewResponse>('/api/whats-new?hours=48'),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  if (!open) return null;

  const data = query.data;
  const empty =
    !query.isLoading &&
    !query.isError &&
    (data?.commits.length ?? 0) === 0 &&
    (data?.releases.length ?? 0) === 0;

  return (
    <Backdrop onClose={onClose}>
      <div
        className="relative flex max-h-[min(80vh,640px)] w-[min(92vw,440px)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="What's new"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              What&apos;s new
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Updates from GitHub in the last 48 hours
              {data?.repo ? ` · ${data.repo}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className={`size-3.5 ${query.isFetching ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition"
              title="Close"
              aria-label="Close"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {query.isLoading && (
            <p className="text-sm text-muted-foreground">Loading recent updates…</p>
          )}
          {query.isError && (
            <p className="text-sm text-destructive">
              Couldn&apos;t load updates. Check your network and try again.
            </p>
          )}
          {empty && (
            <p className="text-sm text-muted-foreground">
              No commits or releases in the last 48 hours.
            </p>
          )}

          {(data?.releases.length ?? 0) > 0 && (
            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Releases
              </h3>
              <ul className="space-y-2">
                {data!.releases.map((rel) => (
                  <li
                    key={rel.tag}
                    className="rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5"
                  >
                    <div className="flex items-start gap-2">
                      <Package className="mt-0.5 size-3.5 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {rel.name}
                          </span>
                          {rel.prerelease && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                              pre
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {rel.tag}
                          {rel.date ? ` · ${formatTimeAgo(rel.date)}` : ''}
                        </p>
                        {rel.body && (
                          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground/90">
                            {rel.body}
                          </p>
                        )}
                        {rel.url && (
                          <button
                            type="button"
                            className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                            onClick={() => void openExternal(rel.url)}
                          >
                            View release <ExternalLink className="size-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(data?.commits.length ?? 0) > 0 && (
            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Commits
              </h3>
              <ul className="space-y-1.5">
                {data!.commits.map((c) => (
                  <li key={c.fullSha || c.sha}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-accent/60 transition"
                      onClick={() => c.url && void openExternal(c.url)}
                    >
                      <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">{c.message || '(no message)'}</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          <span className="font-mono">{c.sha}</span>
                          {c.author ? ` · ${c.author}` : ''}
                          {c.date ? ` · ${formatTimeAgo(c.date)}` : ''}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(data?.errors?.length ?? 0) > 0 && (
            <p className="text-[11px] text-muted-foreground/70">
              Partial load: {data!.errors.join('; ')}
            </p>
          )}
        </div>

        {data?.repoUrl && (
          <footer className="border-t border-border/60 px-5 py-3">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition"
              onClick={() => void openExternal(data.repoUrl)}
            >
              Open repository on GitHub <ExternalLink className="size-3" />
            </button>
          </footer>
        )}
      </div>
    </Backdrop>
  );
}
