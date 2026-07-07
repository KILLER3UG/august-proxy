import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Search, ZoomIn, ZoomOut, Maximize2, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface GraphEntity {
  id: string;
  type: string;
  name: string;
  confidence?: number;
  score?: number;
}

interface GraphRelation {
  id: string;
  from: string;
  to: string;
  type: string;
  fromName?: string;
  toName?: string;
  score?: number;
}

interface GraphSearchResult {
  stats: { counts: { entities: number; relations: number; observations: number }; entityTypes: Record<string, number> };
  search: { entities: GraphEntity[]; relations: GraphRelation[] };
}

const TYPE_COLORS: Record<string, string> = {
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
};

function getColor(type: string): string {
  return TYPE_COLORS[type] || '#6b7280';
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

interface Edge {
  source: string;
  target: string;
  label: string;
}

export function KnowledgeGraph({ className }: { className?: string }) {
  const [query, setQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const nodesRef = useRef<Map<string, Node>>(new Map());

  const { data, isLoading } = useQuery<GraphSearchResult>({
    queryKey: ['brain-graph-search', query],
    queryFn: () => api.get<GraphSearchResult>(`/api/brain/graph?q=${encodeURIComponent(query)}&limit=50`),
    enabled: query.trim().length > 0,
  });

  const nodes = useMemo(() => {
    if (!data?.search?.entities) return [];
    return data.search.entities.map(e => {
      const existing = nodesRef.current.get(e.id);
      return {
        id: e.id,
        label: e.name.replace(/_/g, ' ').replace(/^ent_/, '').substring(0, 30),
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
    return data.search.relations.map(r => ({
      source: r.from,
      target: r.to,
      label: r.type.replace(/_/g, ' '),
    }));
  }, [data?.search?.relations]);

  // Force simulation
  useEffect(() => {
    if (nodes.length === 0) return;

    const nodeMap = new Map(nodes.map(n => [n.id, { ...n }]));
    nodesRef.current = nodeMap;

    let animId: number;
    const tick = () => {
      const ns = Array.from(nodeMap.values());

      // Repulsion between nodes
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

      // Attraction along edges
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

      // Center gravity
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
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [nodes.length, edges.length]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(z => Math.max(0.3, Math.min(3, z - e.deltaY * 0.001)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target === svgRef.current) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
    }
  }, [offset]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) {
      setOffset({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    }
  }, [isDragging, dragStart]);

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const resetView = () => { setZoom(1); setOffset({ x: 0, y: 0 }); };

  const selectedEntity = data?.search?.entities?.find(e => e.id === selectedNode);

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Search bar */}
      <div className="p-3 border-b border-border/30">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search entities (e.g. 'project', 'user', 'tool')..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted/30 rounded-md border-none outline-none text-foreground placeholder:text-muted-foreground/50"
          />
        </div>
      </div>

      {/* Graph area */}
      <div className="flex-1 relative overflow-hidden bg-[#0a0a0f]">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-4 rounded bg-white/5 animate-pulse" style={{ width: 100 + i * 40 }} />
              ))}
            </div>
          </div>
        )}

        {!query.trim() && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/40 text-sm">
            Type a search query to visualize the knowledge graph
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
            {/* Edges */}
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
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth={1}
                  />
                  <text
                    x={(sourceNode.x + targetNode.x) / 2}
                    y={(sourceNode.y + targetNode.y) / 2 - 4}
                    textAnchor="middle"
                    fill="rgba(255,255,255,0.2)"
                    fontSize={8}
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}

            {/* Nodes */}
            {Array.from(nodesRef.current.values()).map(node => {
              const isSelected = selectedNode === node.id;
              const size = 4 + Math.min(node.score, 10) * 1.5;
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
                    opacity={isSelected ? 1 : 0.7}
                    stroke={isSelected ? '#fff' : 'none'}
                    strokeWidth={isSelected ? 1.5 : 0}
                  />
                  <text
                    x={node.x}
                    y={node.y + size + 10}
                    textAnchor="middle"
                    fill="rgba(255,255,255,0.5)"
                    fontSize={8}
                    className="pointer-events-none"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Controls */}
        <div className="absolute bottom-3 right-3 flex items-center gap-1">
          <button onClick={() => setZoom(z => Math.min(3, z * 1.3))} className="p-1.5 bg-background/80 rounded hover:bg-background text-muted-foreground hover:text-foreground transition">
            <ZoomIn className="size-3.5" />
          </button>
          <button onClick={() => setZoom(z => Math.max(0.3, z / 1.3))} className="p-1.5 bg-background/80 rounded hover:bg-background text-muted-foreground hover:text-foreground transition">
            <ZoomOut className="size-3.5" />
          </button>
          <button onClick={resetView} className="p-1.5 bg-background/80 rounded hover:bg-background text-muted-foreground hover:text-foreground transition">
            <RotateCcw className="size-3.5" />
          </button>
        </div>

        {/* Legend */}
        <div className="absolute top-3 right-3 bg-background/80 rounded-lg p-2 text-[9px] space-y-1">
          {Object.entries(TYPE_COLORS).slice(0, 8).map(([type, color]) => (
            <div key={type} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
              <span className="text-muted-foreground">{type.replace(/_/g, ' ')}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Selected node detail */}
      {selectedEntity && (
        <div className="p-3 border-t border-border/30 bg-muted/20">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium">{selectedEntity.name.replace(/_/g, ' ')}</span>
            <span className="text-[9px] font-mono text-muted-foreground">{selectedEntity.type}</span>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            {selectedEntity.confidence && <span>confidence: {Math.round(selectedEntity.confidence * 100)}%</span>}
            {selectedEntity.score && <span>score: {selectedEntity.score}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
