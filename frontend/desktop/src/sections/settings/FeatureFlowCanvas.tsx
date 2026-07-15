/* ── 2D pipeline canvas for Feature Flow ───────────────────────────── */

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

const NODE_W = 88;
const NODE_H = 36;
const PAD_X = 28;
const PAD_Y = 48;
const GAP_X = 36;
const ROW_H = 88;

function stageTone(status: string | undefined): {
  border: string;
  bg: string;
  text: string;
  glow: string;
} {
  if (status === 'error')
    return {
      border: 'border-danger/60',
      bg: 'bg-danger/20',
      text: 'text-danger',
      glow: 'shadow-[0_0_16px_rgba(239,68,68,0.45)]',
    };
  if (status === 'running')
    return {
      border: 'border-sky-400/60',
      bg: 'bg-sky-500/20',
      text: 'text-sky-200',
      glow: 'shadow-[0_0_16px_rgba(56,189,248,0.45)]',
    };
  if (status === 'ok')
    return {
      border: 'border-success/50',
      bg: 'bg-success/15',
      text: 'text-success',
      glow: 'shadow-[0_0_12px_rgba(69,192,138,0.35)]',
    };
  return {
    border: 'border-white/[0.1]',
    bg: 'bg-white/[0.03]',
    text: 'text-muted-foreground',
    glow: '',
  };
}

function layoutNodes(stages: string[]) {
  const perRow = Math.min(4, Math.max(1, stages.length));
  return stages.map((stage, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const x = PAD_X + col * (NODE_W + GAP_X);
    const y = PAD_Y + row * ROW_H;
    return { stage, x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2, i };
  });
}

interface Props {
  stages: string[];
  stageStatus: Record<string, string>;
  /** Bumps when a new event for this trace arrives — drives particle animation */
  pulseKey?: string;
}

export function FeatureFlowCanvas({ stages, stageStatus, pulseKey }: Props) {
  const nodes = useMemo(() => layoutNodes(stages), [stages]);
  const width = Math.max(
    320,
    PAD_X * 2 + Math.min(4, stages.length) * (NODE_W + GAP_X) - GAP_X,
  );
  const rows = Math.max(1, Math.ceil(stages.length / Math.min(4, Math.max(1, stages.length))));
  const height = PAD_Y * 2 + rows * ROW_H - (ROW_H - NODE_H);

  const [particles, setParticles] = useState<
    Array<{ id: string; from: number; to: number }>
  >([]);

  useEffect(() => {
    if (!pulseKey || stages.length < 2) return;
    // Find last stage that is running/ok/error and animate into it from previous
    let target = -1;
    for (let i = stages.length - 1; i >= 0; i--) {
      const st = stageStatus[stages[i]];
      if (st === 'running' || st === 'ok' || st === 'error') {
        target = i;
        break;
      }
    }
    if (target <= 0) return;
    const id = `${pulseKey}-${target}`;
    setParticles((prev) => [...prev.filter((p) => p.id !== id), { id, from: target - 1, to: target }]);
    const t = setTimeout(() => {
      setParticles((prev) => prev.filter((p) => p.id !== id));
    }, 900);
    return () => clearTimeout(t);
  }, [pulseKey, stageStatus, stages]);

  return (
    <div
      className="relative w-full overflow-x-auto rounded-xl border border-white/[0.06] bg-gradient-to-b from-black/40 to-black/20"
      data-testid="feature-flow-trace"
      role="img"
      aria-label="Feature pipeline 2D animation"
    >
      <svg width={width} height={height} className="block min-w-full">
        {/* Edges */}
        {nodes.slice(0, -1).map((n, i) => {
          const next = nodes[i + 1];
          if (!next) return null;
          const active =
            stageStatus[n.stage] === 'ok' ||
            stageStatus[n.stage] === 'running' ||
            stageStatus[next.stage] === 'running' ||
            stageStatus[next.stage] === 'ok' ||
            stageStatus[next.stage] === 'error';
          // Same-row vs wrap
          const sameRow = Math.floor(n.i / 4) === Math.floor(next.i / 4);
          const x1 = n.x + NODE_W;
          const y1 = n.cy;
          const x2 = next.x;
          const y2 = next.cy;
          const path = sameRow
            ? `M ${x1} ${y1} L ${x2} ${y2}`
            : `M ${n.cx} ${n.y + NODE_H} C ${n.cx} ${n.y + NODE_H + 20}, ${next.cx} ${next.y - 20}, ${next.cx} ${next.y}`;
          return (
            <path
              key={`e-${n.stage}`}
              d={path}
              fill="none"
              stroke={active ? 'rgba(111,155,255,0.55)' : 'rgba(255,255,255,0.08)'}
              strokeWidth={active ? 2 : 1.25}
              strokeDasharray={active ? undefined : '4 4'}
            />
          );
        })}

        {/* Particles */}
        {particles.map((p) => {
          const a = nodes[p.from];
          const b = nodes[p.to];
          if (!a || !b) return null;
          const sameRow = Math.floor(a.i / 4) === Math.floor(b.i / 4);
          return (
            <motion.circle
              key={p.id}
              r={4}
              fill="#6f9bff"
              initial={
                sameRow
                  ? { cx: a.x + NODE_W, cy: a.cy, opacity: 1 }
                  : { cx: a.cx, cy: a.y + NODE_H, opacity: 1 }
              }
              animate={
                sameRow
                  ? { cx: b.x, cy: b.cy, opacity: [1, 1, 0] }
                  : { cx: b.cx, cy: b.y, opacity: [1, 1, 0] }
              }
              transition={{ duration: 0.75, ease: 'easeInOut' }}
              style={{ filter: 'drop-shadow(0 0 6px rgba(111,155,255,0.9))' }}
            />
          );
        })}
      </svg>

      {/* HTML nodes overlaid for crisp labels */}
      <div className="pointer-events-none absolute inset-0" style={{ width, height }}>
        {nodes.map((n) => {
          const st = stageStatus[n.stage];
          const tone = stageTone(st);
          return (
            <div
              key={n.stage}
              className={cn(
                'absolute flex items-center justify-center rounded-md border text-[10px] uppercase tracking-wide font-mono transition-all duration-300',
                tone.border,
                tone.bg,
                tone.text,
                tone.glow,
                st === 'running' && 'animate-pulse',
              )}
              style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
              data-stage={n.stage}
              data-status={st || 'idle'}
            >
              {n.stage}
            </div>
          );
        })}
      </div>
    </div>
  );
}
