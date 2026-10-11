import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Minus, Plus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { usageApi } from '@/api/usage';
import type { Session } from '@/store/sessions';
import { WorkspaceBranchChip } from '@/components/workspace/WorkspaceBranchChip';
import { folderNameFromPath } from '@/api/folder';
import { formatTokenCount } from '@/sections/chat/message/token-display';
import { cn } from '@/lib/utils';
import { useWorkspacesStore } from '@/store/workspaces';
import { Button } from '@/components/ui/button';

const COLLAPSED_KEY = 'august-statusbar-collapsed';

/** Quiet workspace and session readout inspired by Haze/KiloCode's footer bars. */
export function StatusBar({ session, agentMode }: { session: Session | null; agentMode?: string | null }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');
  const [effort, setEffort] = useState(() => localStorage.getItem('august_last_effort') || 'medium');
  const currentWorkspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId) ?? null);
  /* No `useContextLiveStore` subscription here any more. It existed only to feed
   * the context ring, and leaving it in place meant the status bar re-rendered on
   * every context-pressure SSE frame and threw the value away — a live store
   * subscription with no consumer. */
  const usage = useQuery({
    queryKey: ['usage', 'session', session?.workbenchSessionId || session?.id],
    queryFn: () => usageApi.session(session!.workbenchSessionId || session!.id),
    enabled: !!session,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  useEffect(() => {
    const onEffort = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) setEffort(detail);
    };
    window.addEventListener('august:effort-changed', onEffort);
    return () => window.removeEventListener('august:effort-changed', onEffort);
  }, []);

  const setOpen = () => setCollapsed((value) => !value);
  const workspacePath = session?.workspacePath || currentWorkspace?.path || null;
  const workspaceName = workspacePath ? folderNameFromPath(workspacePath) : null;

  return (
    <footer
      className={cn('shrink-0 border-t border-border/60 text-muted-foreground/70', collapsed ? 'h-5' : 'h-8')}
      data-testid="august-status-bar"
    >
      <div className="mx-auto flex h-full max-w-[1600px] items-center justify-between gap-3 px-3 text-2xs">
        <div className="flex min-w-0 items-center gap-3 overflow-hidden">
          {!collapsed ? (
            <>
              {workspaceName ? <span className="truncate" title={workspacePath ?? undefined}>{workspaceName}</span> : null}
              {workspacePath ? (
                <WorkspaceBranchChip
                  sessionId={session?.id}
                  repoPath={workspacePath}
                  className="shrink-0 [&_button]:px-1 [&_button]:py-0 [&_button]:text-2xs [&_button]:text-muted-foreground/65"
                  menuPlacement="up"
                />
              ) : null}
              {session?.model ? <span className="max-w-52 truncate" title={`${session.model} · ${effort}`}>{session.model} · {effort}</span> : null}
              {agentMode ? <span className="shrink-0 capitalize">{agentMode}</span> : null}
              {usage.data ? (
                <span className="inline-flex shrink-0 items-center gap-1 tabular-nums" title="Session input and output tokens">
                  <Plus className="size-2.5 text-success" aria-hidden="true" />{formatTokenCount(usage.data.totalInputTokens)}
                  <Minus className="ml-1 size-2.5 text-danger" aria-hidden="true" />{formatTokenCount(usage.data.totalOutputTokens)}
                </span>
              ) : null}
              {/* The context indicator was removed from this bar by request. It was a
              16px ring plus a tabular percentage, fed by `liveContext` and the
              usage query. `ContextRing` itself is untouched and still exported
              from `@/sections/chat/ChatComposer` — only this consumer is gone,
              so the component and its tests stay valid for any future use. */}
            </>
          ) : <span className="truncate">August</span>}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={setOpen}
          aria-label={collapsed ? 'Expand status bar' : 'Collapse status bar'}
          aria-expanded={!collapsed}
          className="shrink-0 p-0 text-muted-foreground/60 hover:bg-muted/50 hover:text-foreground"
          data-testid="status-bar-toggle"
        >
          {collapsed ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </Button>
      </div>
    </footer>
  );
}
