/* ── NotificationsPanel — in-app notification list (menu-style modal) ─ */
/* Opens from Settings → Notifications. Same visual language as the model  */
/* / agent-mode panels: rounded popover card, staggered rows, no settings. */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bell,
  Download,
  ExternalLink,
  GitCommitHorizontal,
  Package,
  RefreshCw,
  X,
} from 'lucide-react';
import { api } from '@/api/client';
import { Backdrop } from '@/components/overlays/Backdrop';
import { PageLoader } from '@/components/PageLoader';
import { UpdateProgressBar } from '@/components/ui/UpdateProgressBar';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { menuItem, menuItemHover, menuItemStagger, menuPanel } from '@/lib/motion';
import { cn, formatTimeAgo } from '@/lib/utils';
import { openExternal } from '@/lib/tauri-shell';
import type {
  WhatsNewCommit,
  WhatsNewRelease,
  WhatsNewResponse,
} from '@/components/overlays/WhatsNewModal';

export interface NotificationsPanelProps {
  open: boolean;
  onClose: () => void;
}

type NotificationItem =
  | {
      id: string;
      kind: 'update';
      title: string;
      detail: string;
      when?: string;
    }
  | {
      id: string;
      kind: 'release';
      title: string;
      detail: string;
      when?: string;
      url?: string;
      prerelease?: boolean;
    }
  | {
      id: string;
      kind: 'commit';
      title: string;
      detail: string;
      when?: string;
      url?: string;
    };

export function NotificationsPanel({ open, onClose }: NotificationsPanelProps) {
  const {
    available: update,
    installing,
    progress,
    formatBytes,
    install,
  } = useAppUpdate();
  const query = useQuery({
    queryKey: ['whats-new', 48],
    queryFn: () => api.get<WhatsNewResponse>('/api/whats-new?hours=48'),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const items = useMemo((): NotificationItem[] => {
    const list: NotificationItem[] = [];
    if (update) {
      list.push({
        id: `update-${update.version}`,
        kind: 'update',
        title: `August ${update.version} is available`,
        detail: update.body?.trim() || 'A new desktop build is ready to install.',
        when: update.date,
      });
    }
    const data = query.data;
    for (const rel of data?.releases ?? []) {
      list.push(releaseToItem(rel));
    }
    for (const commit of data?.commits ?? []) {
      list.push(commitToItem(commit));
    }
    return list;
  }, [update, query.data]);

  if (!open) return null;

  const empty =
    !query.isLoading &&
    !query.isError &&
    items.length === 0;

  return (
    <Backdrop onClose={onClose}>
      <AnimatePresence>
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Notifications"
          {...menuPanel}
          className="relative flex max-h-[min(80vh,560px)] w-[min(92vw,380px)] flex-col overflow-hidden rounded-xl border border-border/60 bg-popover shadow-2xl"
        >
          <header className="flex items-center justify-between gap-3 border-b border-border/50 px-3.5 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Bell className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
                <p className="text-[11px] text-muted-foreground">
                  Updates and recent activity
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition"
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshCw className={cn('size-3.5', query.isFetching && 'animate-spin')} />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition"
                title="Close"
                aria-label="Close"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {installing && (
              <div className="mx-2 mb-2 rounded-lg border border-border/50 bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-foreground">
                    {progress.phase === 'installing'
                      ? 'Installing update…'
                      : 'Downloading update…'}
                  </p>
                  <span className="text-xs font-semibold tabular-nums text-foreground">
                    {progress.phase === 'installing'
                      ? '100%'
                      : progress.percent != null
                        ? `${progress.percent}%`
                        : '…'}
                  </span>
                </div>
                <UpdateProgressBar progress={progress} />
                <p className="text-[10px] tabular-nums text-muted-foreground">
                  {progress.totalBytes != null && progress.totalBytes > 0
                    ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
                    : progress.downloadedBytes > 0
                      ? `${formatBytes(progress.downloadedBytes)} downloaded`
                      : 'Starting download…'}
                </p>
              </div>
            )}

            {query.isLoading && (
              <PageLoader label="Loading notifications…" className="px-3 py-6" />
            )}
            {query.isError && !update && (
              <p className="px-3.5 py-4 text-sm text-destructive">
                Couldn&apos;t load notifications. Check your network and try again.
              </p>
            )}
            {empty && (
              <div className="px-3.5 py-8 text-center">
                <Bell className="mx-auto mb-2 size-5 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">You&apos;re all caught up</p>
                <p className="mt-1 text-[11px] text-muted-foreground/70">
                  App updates and recent repo activity will show up here.
                </p>
              </div>
            )}

            {!query.isLoading && items.length > 0 && (
              <motion.div
                variants={menuItemStagger}
                initial="initial"
                animate="animate"
                className="py-0.5"
              >
                {items.map((item) => (
                  <NotificationRow
                    key={item.id}
                    item={item}
                    installing={installing}
                    progressPercent={progress.percent}
                    onInstall={() => {
                      void install();
                    }}
                    onOpenUrl={(url) => {
                      void openExternal(url);
                    }}
                  />
                ))}
              </motion.div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </Backdrop>
  );
}

function releaseToItem(rel: WhatsNewRelease): NotificationItem {
  return {
    id: `release-${rel.tag}`,
    kind: 'release',
    title: rel.name || rel.tag,
    detail: rel.body?.trim() || `Release ${rel.tag}`,
    when: rel.date,
    url: rel.url,
    prerelease: rel.prerelease,
  };
}

function commitToItem(c: WhatsNewCommit): NotificationItem {
  return {
    id: `commit-${c.fullSha || c.sha}`,
    kind: 'commit',
    title: c.message || '(no message)',
    detail: [c.sha, c.author].filter(Boolean).join(' · '),
    when: c.date,
    url: c.url,
  };
}

function NotificationRow({
  item,
  installing,
  progressPercent,
  onInstall,
  onOpenUrl,
}: {
  item: NotificationItem;
  installing: boolean;
  progressPercent: number | null;
  onInstall: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const Icon =
    item.kind === 'update'
      ? Download
      : item.kind === 'release'
        ? Package
        : GitCommitHorizontal;

  const clickable = item.kind !== 'update' && Boolean(item.url);
  const updateBusy = item.kind === 'update' && installing;

  return (
    <motion.div
      variants={menuItem}
      className="px-1.5"
    >
      <motion.button
        type="button"
        {...menuItemHover}
        disabled={item.kind === 'update' ? installing : !clickable}
        onClick={() => {
          if (item.kind === 'update') onInstall();
          else if (item.url) onOpenUrl(item.url);
        }}
        className={cn(
          'w-full rounded-lg px-2.5 py-2.5 text-left transition',
          'hover:bg-muted/40 disabled:opacity-60',
          item.kind === 'update' && 'bg-amber-500/8 hover:bg-amber-500/12',
        )}
      >
        <div className="flex items-start gap-2.5">
          <Icon
            className={cn(
              'mt-0.5 size-3.5 shrink-0',
              item.kind === 'update' ? 'text-amber-500' : 'text-muted-foreground',
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">
                {item.title}
              </span>
              {item.kind === 'release' && item.prerelease && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  pre
                </span>
              )}
            </div>
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
              {item.detail}
            </p>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/70">
              {item.when ? <span>{formatTimeAgo(item.when)}</span> : null}
              {item.kind === 'update' && (
                <span className="font-medium text-amber-500">
                  {updateBusy
                    ? progressPercent != null
                      ? `Downloading ${progressPercent}%`
                      : 'Downloading…'
                    : 'Click to install'}
                </span>
              )}
              {clickable && (
                <span className="inline-flex items-center gap-0.5">
                  Open <ExternalLink className="size-2.5" />
                </span>
              )}
            </div>
          </div>
        </div>
      </motion.button>
    </motion.div>
  );
}
