/* ── Feature Flow — office floor with department rooms ─────────────── */
/* Clean work-environment animation: rooms (proxy, tools, gateway, …),
 * employees walk their jobs. Job legend is separate — no labels above heads. */

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';

/** Department palette + layout for each feature inventory id */
const DEPT: Record<
  string,
  { name: string; floor: string; accent: string; desk: string }
> = {
  proxy: {
    name: 'Proxy Dept',
    floor: '#1a1f2e',
    accent: '#6f9bff',
    desk: '#2a3348',
  },
  memory: {
    name: 'Memory Archive',
    floor: '#1c1a24',
    accent: '#c084fc',
    desk: '#2e2840',
  },
  tools: {
    name: 'Tools Workshop',
    floor: '#1a221c',
    accent: '#fbbf24',
    desk: '#2a3228',
  },
  cognitive: {
    name: 'Cognitive Lab',
    floor: '#1a2028',
    accent: '#38bdf8',
    desk: '#243040',
  },
  gateway: {
    name: 'Gateway Lobby',
    floor: '#221a1c',
    accent: '#f472b6',
    desk: '#322428',
  },
  skills: {
    name: 'Skills Studio',
    floor: '#1a241e',
    accent: '#4ade80',
    desk: '#243028',
  },
  security: {
    name: 'Security Desk',
    floor: '#241a1a',
    accent: '#f87171',
    desk: '#322424',
  },
  workbench: {
    name: 'Workbench Bay',
    floor: '#1c1e24',
    accent: '#a78bfa',
    desk: '#2a2c38',
  },
};

const JOB_META: Record<string, { title: string; hue: number; glyph: string }> = {
  start: { title: 'Intake', hue: 210, glyph: 'I' },
  route: { title: 'Router', hue: 260, glyph: 'R' },
  translate: { title: 'Translator', hue: 190, glyph: 'T' },
  upstream: { title: 'Courier', hue: 160, glyph: 'C' },
  stream: { title: 'Streamer', hue: 280, glyph: 'S' },
  end: { title: 'Closer', hue: 140, glyph: '✓' },
  read: { title: 'Librarian', hue: 45, glyph: 'L' },
  write: { title: 'Scribe', hue: 25, glyph: 'W' },
  index: { title: 'Indexer', hue: 320, glyph: '#' },
  dispatch: { title: 'Foreman', hue: 200, glyph: 'F' },
  exec: { title: 'Operator', hue: 12, glyph: 'O' },
  result: { title: 'QA', hue: 90, glyph: 'Q' },
  plan: { title: 'Architect', hue: 230, glyph: 'A' },
  delegate: { title: 'Captain', hue: 300, glyph: 'P' },
  verify: { title: 'Verifier', hue: 100, glyph: 'V' },
  inbound: { title: 'Reception', hue: 180, glyph: '↓' },
  workbench: { title: 'Builder', hue: 35, glyph: 'B' },
  outbound: { title: 'Dispatcher', hue: 330, glyph: '↑' },
  load: { title: 'Loader', hue: 50, glyph: 'L' },
  apply: { title: 'Applier', hue: 70, glyph: '★' },
  check: { title: 'Guard', hue: 0, glyph: 'G' },
  allow: { title: 'Allow', hue: 140, glyph: 'Y' },
  deny: { title: 'Deny', hue: 0, glyph: 'N' },
  prompt: { title: 'Prompt', hue: 250, glyph: '💬' },
  llm: { title: 'Thinker', hue: 270, glyph: '◉' },
  tools: { title: 'Toolsmith', hue: 20, glyph: '⚙' },
  persist: { title: 'Archivist', hue: 170, glyph: 'A' },
  inject: { title: 'Injector', hue: 310, glyph: '+' },
  error: { title: 'Medic', hue: 0, glyph: '!' },
};

function jobFor(stage: string) {
  const k = stage.toLowerCase();
  if (JOB_META[k]) return JOB_META[k];
  let h = 0;
  for (let i = 0; i < stage.length; i++) h = (h + stage.charCodeAt(i) * 17) % 360;
  return { title: stage, hue: h, glyph: stage.slice(0, 1).toUpperCase() };
}

function stageTone(status: string | undefined) {
  if (status === 'error') return { lamp: 'bg-danger', ring: 'ring-danger/50', busy: true };
  if (status === 'running') return { lamp: 'bg-sky-400 animate-pulse', ring: 'ring-sky-400/40', busy: true };
  if (status === 'ok') return { lamp: 'bg-success', ring: 'ring-success/30', busy: false };
  return { lamp: 'bg-white/25', ring: 'ring-transparent', busy: false };
}

/** Desk positions in a room (percent of room) */
function deskLayout(n: number): Array<{ x: number; y: number }> {
  const cols = Math.min(4, Math.max(1, n));
  const rows = Math.ceil(n / cols);
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = 12 + (c + 0.5) * (76 / cols);
    const y = 28 + (r + 0.5) * (52 / rows);
    out.push({ x, y });
  }
  return out;
}

function PixelWorker({
  hue,
  glyph,
  running,
  error,
  size = 26,
}: {
  hue: number;
  glyph: string;
  running?: boolean;
  error?: boolean;
  size?: number;
}) {
  const body = `hsl(${hue} 65% ${error ? 42 : 52}%)`;
  const head = `hsl(${hue} 40% ${error ? 68 : 78}%)`;
  return (
    <motion.div
      className="relative select-none pointer-events-none"
      style={{ width: size, height: size + 6, imageRendering: 'pixelated' }}
      animate={
        running
          ? { y: [0, -3, 0, -2, 0], x: [0, 1, 0, -1, 0] }
          : { y: [0, -1, 0] }
      }
      transition={
        running
          ? { duration: 0.4, repeat: Infinity, ease: 'linear' }
          : { duration: 2, repeat: Infinity, ease: 'easeInOut' }
      }
    >
      <div
        className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded-full bg-black/35"
        style={{ width: size * 0.65, height: 3 }}
      />
      <div
        className="absolute left-1/2 -translate-x-1/2 rounded-[2px]"
        style={{
          top: 0,
          width: size * 0.4,
          height: size * 0.36,
          background: head,
          boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
        }}
      >
        <span className="absolute top-[38%] left-[20%] w-[3px] h-[3px] rounded-full bg-black/85" />
        <span className="absolute top-[38%] right-[20%] w-[3px] h-[3px] rounded-full bg-black/85" />
      </div>
      <div
        className="absolute left-1/2 -translate-x-1/2 rounded-[2px] flex items-center justify-center text-[8px] font-bold text-white/90"
        style={{
          top: size * 0.34,
          width: size * 0.52,
          height: size * 0.4,
          background: body,
          boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
        }}
      >
        {glyph.slice(0, 1)}
      </div>
      <motion.div
        className="absolute left-[30%] rounded-[1px]"
        style={{
          top: size * 0.72,
          width: size * 0.13,
          height: size * 0.2,
          background: `hsl(${hue} 35% 28%)`,
        }}
        animate={running ? { y: [0, 2, 0] } : {}}
        transition={running ? { duration: 0.28, repeat: Infinity } : undefined}
      />
      <motion.div
        className="absolute right-[30%] rounded-[1px]"
        style={{
          top: size * 0.72,
          width: size * 0.13,
          height: size * 0.2,
          background: `hsl(${hue} 35% 28%)`,
        }}
        animate={running ? { y: [0, -1, 2, 0] } : {}}
        transition={running ? { duration: 0.28, repeat: Infinity } : undefined}
      />
      {error && (
        <span className="absolute -top-0.5 -right-0.5 text-[9px] text-danger font-bold leading-none">
          !
        </span>
      )}
    </motion.div>
  );
}

interface Walker {
  id: string;
  from: number;
  to: number;
  hue: number;
  glyph: string;
  status: 'ok' | 'error' | 'running';
}

interface Props {
  stages: string[];
  stageStatus: Record<string, string>;
  pulseKey?: string;
  lastSummary?: string;
  /** Feature inventory id → picks department room theme */
  featureId?: string;
  featureName?: string;
}

export function FeatureFlowCanvas({
  stages,
  stageStatus,
  pulseKey,
  lastSummary,
  featureId = 'proxy',
  featureName,
}: Props) {
  const dept = DEPT[featureId] || DEPT.proxy;
  const desks = useMemo(() => deskLayout(stages.length), [stages.length]);
  const jobs = useMemo(() => stages.map((s) => ({ stage: s, ...jobFor(s) })), [stages]);

  const [walkers, setWalkers] = useState<Walker[]>([]);
  const [ticker, setTicker] = useState<string | null>(null);

  // Room size
  const width = Math.max(520, 120 + stages.length * 28);
  const height = 280;

  useEffect(() => {
    if (!pulseKey || stages.length < 1) return;
    let target = 0;
    for (let i = stages.length - 1; i >= 0; i--) {
      const st = stageStatus[stages[i]];
      if (st === 'running' || st === 'ok' || st === 'error') {
        target = i;
        break;
      }
    }
    const from = Math.max(0, target - 1);
    const job = jobFor(stages[target] || 'start');
    const st = (stageStatus[stages[target]] as Walker['status']) || 'running';
    const id = `${pulseKey}-${target}`;
    setWalkers((prev) => [...prev.filter((w) => w.id !== id), { id, from, to: target, hue: job.hue, glyph: job.glyph, status: st }].slice(-3));
    if (lastSummary) {
      setTicker(lastSummary.slice(0, 64));
      const t = setTimeout(() => setTicker(null), 2400);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setWalkers((prev) => prev.filter((w) => w.id !== id)), 1000);
    return () => clearTimeout(t);
  }, [pulseKey, stageStatus, stages, lastSummary]);

  const posAt = (i: number) => {
    const d = desks[i] || { x: 50, y: 50 };
    return {
      left: (d.x / 100) * width - 13,
      top: (d.y / 100) * height - 8,
    };
  };

  return (
    <div className="space-y-3" data-testid="feature-flow-trace">
      {/* Office room */}
      <div
        className="relative w-full overflow-hidden rounded-2xl border border-white/[0.08] shadow-inner"
        style={{
          minHeight: height,
          background: dept.floor,
          backgroundImage: `
            linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px),
            linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)
          `,
          backgroundSize: '24px 24px',
        }}
        role="img"
        aria-label={`${dept.name} office floor animation`}
      >
        {/* Ceiling lights */}
        <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/40 to-transparent pointer-events-none" />
        <div className="absolute top-2 left-1/4 size-2 rounded-full bg-amber-100/40 blur-[1px]" />
        <div className="absolute top-2 left-1/2 size-2 rounded-full bg-amber-100/40 blur-[1px]" />
        <div className="absolute top-2 left-3/4 size-2 rounded-full bg-amber-100/40 blur-[1px]" />

        {/* Dept nameplate (room label only — not on characters) */}
        <div
          className="absolute top-3 left-3 z-20 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-semibold backdrop-blur-sm"
          style={{
            borderColor: `${dept.accent}55`,
            background: 'rgba(0,0,0,0.45)',
            color: dept.accent,
          }}
        >
          <span className="size-1.5 rounded-full" style={{ background: dept.accent }} />
          {featureName || dept.name}
        </div>

        {/* Wall whiteboard / status ticker */}
        <div className="absolute top-3 right-3 z-20 max-w-[45%] rounded-md border border-white/10 bg-black/50 px-2 py-1 text-[10px] font-mono text-muted-foreground truncate">
          {ticker ? (
            <span className="text-sky-200">{ticker}</span>
          ) : (
            <span className="opacity-50">ops board · waiting for traffic…</span>
          )}
        </div>

        {/* Floor corridor */}
        <div
          className="absolute left-[6%] right-[6%] top-[48%] h-8 rounded-sm opacity-30"
          style={{ background: `linear-gradient(90deg, transparent, ${dept.accent}33, transparent)` }}
        />

        {/* Desks + workers */}
        <div className="relative" style={{ width: '100%', height, minWidth: width }}>
          {jobs.map((j, i) => {
            const d = desks[i];
            const st = stageStatus[j.stage];
            const tone = stageTone(st);
            const left = `${d.x}%`;
            const top = `${d.y}%`;
            return (
              <div
                key={j.stage}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left, top }}
                data-stage={j.stage}
                data-status={st || 'idle'}
              >
                {/* Desk */}
                <div
                  className={cn(
                    'relative rounded-md border border-black/40 shadow-md ring-2 transition-all duration-300',
                    tone.ring,
                  )}
                  style={{
                    width: 56,
                    height: 36,
                    background: dept.desk,
                    boxShadow: `0 4px 0 rgba(0,0,0,0.35), 0 0 12px ${dept.accent}22`,
                  }}
                >
                  {/* Monitor */}
                  <div
                    className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-sm border border-black/50"
                    style={{
                      width: 22,
                      height: 14,
                      background: st === 'running' ? '#0ea5e9' : st === 'error' ? '#ef4444' : st === 'ok' ? '#22c55e' : '#0f172a',
                      boxShadow: st === 'running' ? `0 0 8px ${dept.accent}` : undefined,
                    }}
                  />
                  {/* Desk lamp */}
                  <span
                    className={cn('absolute -top-1 right-1 size-1.5 rounded-full', tone.lamp)}
                  />
                </div>
                {/* Worker at desk — no floating title */}
                <div className="absolute left-1/2 top-[28px] -translate-x-1/2">
                  <PixelWorker
                    hue={j.hue}
                    glyph={j.glyph}
                    running={st === 'running'}
                    error={st === 'error'}
                  />
                </div>
              </div>
            );
          })}

          {/* Walkers between desks */}
          <AnimatePresence>
            {walkers.map((w) => {
              const a = posAt(w.from);
              const b = posAt(w.to);
              return (
                <motion.div
                  key={w.id}
                  className="absolute z-30"
                  initial={{ left: a.left, top: a.top, opacity: 0 }}
                  animate={{ left: b.left, top: b.top, opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.9, ease: 'easeInOut' }}
                >
                  <PixelWorker hue={w.hue} glyph={w.glyph} running error={w.status === 'error'} size={28} />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>

        {/* Floor baseboard */}
        <div className="absolute inset-x-0 bottom-0 h-3 bg-black/30 border-t border-white/5" />
      </div>

      {/* Legend — clean job list (not on characters) */}
      <div
        className="rounded-xl border border-white/[0.06] bg-card/50 px-3 py-2.5"
        data-testid="feature-flow-legend"
      >
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Team legend · {dept.name}
        </div>
        <div className="flex flex-wrap gap-2">
          {jobs.map((j) => {
            const st = stageStatus[j.stage];
            return (
              <div
                key={j.stage}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]',
                  st === 'running'
                    ? 'border-sky-400/40 bg-sky-500/10 text-sky-100'
                    : st === 'ok'
                      ? 'border-success/30 bg-success/10 text-success'
                      : st === 'error'
                        ? 'border-danger/40 bg-danger/10 text-danger'
                        : 'border-white/[0.06] bg-white/[0.02] text-muted-foreground',
                )}
              >
                <span
                  className="grid size-5 place-items-center rounded text-[9px] font-bold text-white"
                  style={{ background: `hsl(${j.hue} 60% 42%)` }}
                >
                  {j.glyph.slice(0, 1)}
                </span>
                <span className="font-medium text-foreground/90">{j.title}</span>
                <span className="font-mono text-[9px] opacity-60">{j.stage}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
