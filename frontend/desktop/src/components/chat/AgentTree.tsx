/* ── AgentTree ─────────────────────────────────────────────────────────── */
/* Hierarchical view of sub-agent jobs for a session. Driven by the        */
/* /api/agents/tree endpoint.                                               */

import { useState } from 'react';
import { ChevronRight, ChevronDown, Bot, Loader2, Check, AlertTriangle, StopCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { useAgentTree } from '@/hooks/useAgentTree';
import type { AgentNode } from '@/hooks/useAgentTree';

export type { AgentNode } from '@/hooks/useAgentTree';

type Subtree = { root: AgentNode; children: Record<string, Subtree> };

type Props = {
  rootId: string | null;
  maxDepth?: number;
  onSelect?: (node: AgentNode) => void;
};

const STATUS_BADGE: Record<AgentNode['status'], { label: string; Icon: typeof Loader2; cls: string }> = {
  running:   { label: 'running',   Icon: Loader2,     cls: 'border-info/40 text-info' },
  completed: { label: 'completed', Icon: Check,       cls: 'border-success/40 text-success' },
  failed:    { label: 'failed',    Icon: AlertTriangle, cls: 'border-danger/40 text-danger' },
  blocked:   { label: 'blocked',   Icon: StopCircle,  cls: 'border-warning/40 text-warning' },
};

export function AgentTree({ rootId, maxDepth = 4, onSelect }: Props) {
  const { data: tree, isLoading } = useAgentTree(rootId, maxDepth);

  if (!rootId) return null;
  if (isLoading && !tree) return <div className="text-xs text-muted-foreground p-3">Loading agent tree…</div>;
  if (!tree) return <div className="text-xs text-muted-foreground p-3">No agent tree available.</div>;

  return (
    <div className="text-xs" data-testid="agent-tree">
      <TreeNode node={tree.root} childrenMap={tree.children} depth={0} onSelect={onSelect} defaultOpen />
    </div>
  );
}

function TreeNode({
  node,
  childrenMap,
  depth,
  onSelect,
  defaultOpen = false,
}: {
  node: AgentNode;
  childrenMap: Record<string, Subtree>;
  depth: number;
  onSelect?: (n: AgentNode) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const childIds = Object.keys(childrenMap);
  const hasChildren = childIds.length > 0;
  const badge = STATUS_BADGE[node.status] || STATUS_BADGE.running;
  const Icon = badge.Icon;

  return (
    <div className="space-y-0.5">
      <div
        className={cn(
          'group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/30 cursor-pointer',
          depth === 0 && 'bg-accent/10'
        )}
        onClick={() => onSelect?.(node)}
        data-status={node.status}
      >
        <button
          type="button"
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {hasChildren ? (
            open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <span className="inline-block w-3.5" />
          )}
        </button>
        <Bot className="mt-0.5 h-3.5 w-3.5 text-muted-foreground flex-none" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{node.agentId}</span>
            <Badge variant="outline" className={cn('text-[9px]', badge.cls)}>
              {badge.label}
            </Badge>
            <span className="text-[9px] text-muted-foreground/60">d{node.depth}</span>
            {node.scope && <span className="text-[9px] text-muted-foreground/60">· {node.scope}</span>}
          </div>
          <p className="text-[10px] text-muted-foreground/80 line-clamp-2">{node.task}</p>
        </div>
        <Icon className={cn('h-3.5 w-3.5 flex-none', node.status === 'running' && 'animate-spin')} />
      </div>
      {open && hasChildren && (
        <div className="ml-3 chat-rail pl-2 space-y-0.5">
          {childIds.map((cid) => (
            <TreeNode
              key={cid}
              node={childrenMap[cid].root}
              childrenMap={childrenMap[cid].children}
              depth={depth + 1}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default AgentTree;