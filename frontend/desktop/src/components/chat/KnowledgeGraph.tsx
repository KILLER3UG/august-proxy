import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Search, ZoomIn, ZoomOut, RotateCcw, Network } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

interface GraphEntity {
  id: string;
  type: string;
  typeLabel?: string;
  name: string;
  /** Beginner-friendly title from the API (preferred over raw `name`). */
  label?: string;
  description?: string;
  confidence?: number;
  score?: number;
}

interface GraphRelation {
  id: string;
  from: string;
  to: string;
  type: string;
  /** Friendly edge caption (e.g. "includes"). */
  label?: string;
  fromName?: string;
  toName?: string;
  score?: number;
}

interface GraphSearchResult {
  stats: {
    counts: { entities: number; relations: number; observations: number };
    entityTypes: Record<string, number>;
  };
  search: { entities: GraphEntity[]; relations: GraphRelation[] };
}

const TYPE_COLORS: Record<string, string> = {
  conversation: '#38bdf8',
  project: '#3b82f6',
  projectInfo: '#60a5fa',
  concept: '#8b5cf6',
  tool: '#f59e0b',
  integration: '#10b981',
  userPreference: '#ec4899',
  userDetail: '#f472b6',
  workflowRule: '#ef4444',
  checkpointTopic: '#06b6d4',
  sessionTemp: '#6366f1',
  path: '#78716c',
  memory: '#f97316',
  category: '#94a3b8',
  general: '#6b7280',
  test: '#a78bfa',
};

const TYPE_LEGEND_LABELS: Record<string, string> = {
  conversation: 'Chat memory',
  project: 'Project',
  projectInfo: 'Project info',
  concept: 'Concept',
  tool: 'Tool',
  integration: 'Integration',
  userPreference: 'Preference',
  userDetail: 'User detail',
  workflowRule: 'Workflow rule',
  memory: 'Memory',
  category: 'Category',
  general: 'General',
};

function getColor(type: string): string {
  return TYPE_COLORS[type] || '#6b7280';
}

/** Client fallback when an older API omits `label`. */
function formatEntityLabel(name: string, apiLabel?: string): string {
  if (apiLabel?.trim()) return apiLabel.trim().slice(0, 42);
  const raw = (name || '').trim();
  if (!raw) return 'Unknown';
  if (raw === 'conversation') return 'Conversations';
  if (raw.startsWith('conv_summary_')) {
    const m = raw.match(/(20\d{6})_(\d{4,6})/);
    if (m) {
      const y = m[1].slice(0, 4);
      const mo = m[1].slice(4, 6);
      const d = m[1].slice(6, 8);
      const hh = m[2].padEnd(6, '0').slice(0, 2);
      const mm = m[2].padEnd(6, '0').slice(2, 4);
      const dt = new Date(`${y}-${mo}-${d}T${hh}:${mm}:00`);
      if (!Number.isNaN(dt.getTime())) {
        return `Chat summary · ${dt.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })}`;
      }
    }
    return 'Chat summary';
  }
  return raw.replace(/_/g, ' ').replace(/^ent /, '').slice(0, 30);
}

interface Node {
  id: string;
  label: string;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  score: number;
}

export function KnowledgeGraph({ className }: { className?: string }) {
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [tick, setTick] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const nodesRef = useRef<Map<string, Node>>(new Map());

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isLoading, isFetching } = useQuery<GraphSearchResult>({
    queryKey: ['brain-graph-search', debouncedQ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedQ) params.set('q', debouncedQ);
      params.set('limit', '50');
      return api.get<GraphSearchResult>(`/api/brain/graph?${params.toString()}`);
    },
    refetchInterval: 30_000,
  });

  const nodes = useMemo(() => {
    if (!data?.search?.entities) return [];
    return data.search.entities.map((e) => {
      const existing = nodesRef.current.get(e.id);
      return {
        id: e.id,
        label: formatEntityLabel(e.name, e.label),
        type: e.type,
        x: existing?.x ?? Math.random() * 600 + 100,
        y: existing?.y ?? Math.random() * 400 + 100,
        vx: 0,
        vy: 0,
        score: e.score || 1,
      };
    });
  }, [data?.search?.entities]);

  const edges = useMemo(() => {
    if (!data?.search?.relations) return [];
    return data.search.relations.map((r) => ({
      source: r.from,
      target: r.to,
      label: (r.label || r.type || 'related').replace(/_/g, ' '),
    }));
  }, [data?.search?.relations]);

  // Force simulation
  useEffect(() => {
    if (nodes.length === 0) return;

    const nodeMap = new Map(nodes.map((n) => [n.id, { ...n }]));
    nodesRef.current = nodeMap;

    let animId: number;
    let frames = 0;
    const tickFn = () => {
      const ns = Array.from(nodeMap.values());

      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const dx = ns[j].x - ns[i].x;
          const dy = ns[j].y - ns[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 800 / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          ns[i].vx -= fx;
          ns[i].vy -= fy;
          ns[j].vx += fx;
          ns[j].vy += fy;
        }
      }

      for (const edge of edges) {
        const s = nodeMap.get(edge.source);
        const t = nodeMap.get(edge.target);
        if (!s || !t) continue;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - 120) * 0.01;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        s.vx += fx;
        s.vy += fy;
        t.vx -= fx;
        t.vy -= fy;
      }

      for (const n of ns) {
        n.vx += (400 - n.x) * 0.001;
        n.vy += (300 - n.y) * 0.001;
        n.vx *= 0.85;
        n.vy *= 0.85;
        n.x += n.vx;
        n.y += n.vy;
        n.x = Math.max(20, Math.min(780, n.x));
        n.y = Math.max(20, Math.min(580, n.y));
      }

      nodesRef.current = nodeMap;
      frames += 1;
      // Re-render ~10fps so SVG tracks simulation without thrashing React
      if (frames % 6 === 0) setTick((t) => t + 1);
      animId = requestAnimationFrame(tickFn);
    };

    animId = requestAnimationFrame(tickFn);
    return () => cancelAnimationFrame(animId);
  }, [nodes, edges]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.3, Math.min(3, z - e.deltaY * 0.001)));
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === svgRef.current) {
        setIsDragging(true);
        setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
      }
    },
    [offset],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) {
        setOffset({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
      }
    },
    [isDragging, dragStart],
  );

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const resetView = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  const selectedEntity = data?.search?.entities?.find((e) => e.id === selectedNode);
  const hasNodes = nodes.length > 0;
  // suppress unused tick lint by reading it (drives re-render of SVG)
  void tick;

  return (
    <div className={cn('flex flex-col h-full min-h-[420px]', className)} data-testid="knowledge-graph">
      {/* Search bar */}
      <div className="p-3 border-b border-border/30">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter entities (optional)…"
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted/30 rounded-md border-none outline-none text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
        {data?.stats?.counts && (
          <p className="mt-1.5 text-[10px] text-muted-foreground font-mono">
            {data.stats.counts.entities} entities · {data.stats.counts.relations} relations ·{' '}
            {data.stats.counts.observations} obs
            {isFetching && !isLoading ? ' · updating…' : ''}
          </p>
        )}
      </div>

      {/* Graph area */}
      <div className="flex-1 relative overflow-hidden bg-[#0a0a0f] min-h-[360px]">
        {isLoading && (
          <div className="absolute inset-0 z-10 flex flex-col gap-3 p-6">
            <div className="flex gap-2">
              <Skeleton className="h-3 w-20 bg-white/5" />
              <Skeleton className="h-3 w-16 bg-white/5" />
              <Skeleton className="h-3 w-24 bg-white/5" />
            </div>
            <div className="relative flex-1 rounded-lg border border-white/[0.04] bg-white/[0.02]">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton
                  key={i}
                  className="absolute size-3 rounded-full bg-white/10"
                  style={{
                    left: `${12 + (i % 4) * 22}%`,
                    top: `${18 + Math.floor(i / 4) * 40}%`,
                  }}
                />
              ))}
              <Skeleton className="absolute left-[20%] top-[35%] h-px w-[30%] bg-white/10" />
              <Skeleton className="absolute left-[45%] top-[55%] h-px w-[25%] bg-white/10" />
            </div>
          </div>
        )}

        {!isLoading && !hasNodes && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground/50 text-sm px-6 text-center">
            <Network className="size-8 opacity-40" />
            <p>No graph entities yet</p>
            <p className="text-xs text-muted-foreground/40 max-w-xs">
              Entities and relations appear as August learns from conversations and tools. Seed data
              loads automatically when available.
            </p>
          </div>
        )}

        <svg
          ref={svgRef}
          className="w-full h-full"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <g transform={`translate(${offset.x},${offset.y}) scale(${zoom})`}>
            {edges.map((edge, i) => {
              const sourceNode = nodesRef.current.get(edge.source);
              const targetNode = nodesRef.current.get(edge.target);
              if (!sourceNode || !targetNode) return null;
              return (
                <g key={i}>
                  <line
                    x1={sourceNode.x}
                    y1={sourceNode.y}
                    x2={targetNode.x}
                    y2={targetNode.y}
                    stroke="rgba(255,255,255,0.12)"
                    strokeWidth={1.25}
                  />
                  <text
                    x={(sourceNode.x + targetNode.x) / 2}
                    y={(sourceNode.y + targetNode.y) / 2 - 4}
                    textAnchor="middle"
                    fill="rgba(255,255,255,0.28)"
                    fontSize={8}
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}

            {Array.from(nodesRef.current.values()).map((node) => {
              const isSelected = selectedNode === node.id;
              const size = 5 + Math.min(node.score, 10) * 1.5;
              return (
                <g
                  key={node.id}
                  onClick={() => setSelectedNode(isSelected ? null : node.id)}
                  className="cursor-pointer"
                >
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={isSelected ? size + 2 : size}
                    fill={getColor(node.type)}
                    opacity={isSelected ? 1 : 0.85}
                    stroke={isSelected ? '#fff' : 'rgba(255,255,255,0.15)'}
                    strokeWidth={isSelected ? 1.5 : 0.5}
                  />
                  <text
                    x={node.x}
                    y={node.y + size + 11}
                    textAnchor="middle"
                    fill="rgba(255,255,255,0.65)"
                    fontSize={9}
                    className="pointer-events-none"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        <div className="absolute bottom-3 right-3 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(3, z * 1.3))}
            className="p-1.5 bg-background/80 rounded hover:bg-background text-muted-foreground hover:text-foreground transition"
          >
            <ZoomIn className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.3, z / 1.3))}
            className="p-1.5 bg-background/80 rounded hover:bg-background text-muted-foreground hover:text-foreground transition"
          >
            <ZoomOut className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={resetView}
            className="p-1.5 bg-background/80 rounded hover:bg-background text-muted-foreground hover:text-foreground transition"
          >
            <RotateCcw className="size-3.5" />
          </button>
        </div>

        <div className="absolute top-3 right-3 bg-background/80 rounded-lg p-2 text-[9px] space-y-1">
          {(
            [
              'conversation',
              'project',
              'concept',
              'tool',
              'integration',
              'userPreference',
              'memory',
              'workflowRule',
            ] as const
          ).map((type) => (
            <div key={type} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] }} />
              <span className="text-muted-foreground">
                {TYPE_LEGEND_LABELS[type] || type.replace(/_/g, ' ')}
              </span>
            </div>
          ))}
        </div>
      </div>

      {selectedEntity && (
        <div className="p-3 border-t border-border/30 bg-muted/20 space-y-1.5">
          <div className="flex items-start justify-between gap-3">
            <span className="text-xs font-medium leading-snug">
              {formatEntityLabel(selectedEntity.name, selectedEntity.label)}
            </span>
            <span className="text-[9px] text-muted-foreground shrink-0">
              {selectedEntity.typeLabel ||
                TYPE_LEGEND_LABELS[selectedEntity.type] ||
                selectedEntity.type.replace(/_/g, ' ')}
            </span>
          </div>
          {selectedEntity.description ? (
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {selectedEntity.description}
            </p>
          ) : null}
          <p className="text-[9px] font-mono text-muted-foreground/70 truncate" title={selectedEntity.name}>
            id: {selectedEntity.name}
          </p>
        </div>
      )}
    </div>
  );
}
