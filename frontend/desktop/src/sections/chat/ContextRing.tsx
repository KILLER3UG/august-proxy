import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextBreakdown } from './context-breakdown';

/* ── Context usage ring — compact, details on hover ─────────────────── */
/* A ~22px donut showing how full the context window is. Hovering reveals
 * a tooltip card with the exact token counts and the active model. Keeps the
 * composer calm for beginners while keeping every detail one hover away. */

export function ContextRing({
  pct,
  estTokens,
  maxContext,
  modelName,
  breakdown,
  serverTokens,
  promptCache,
  onCompact,
  compacting = false,
  size = 22,
  stroke = 3,
}: {
  pct: number;
  estTokens: number;
  maxContext: number;
  modelName?: string;
  /** When provided, the hover popup shows a per-category breakdown. */
  breakdown?: ContextBreakdown;
  /** Optional actual token consumption reported by the backend for this session. */
  serverTokens?: { total: number; input: number; output: number } | null;
  /** Universal prompt-cache split for this session (hit rate display). */
  promptCache?: { hitTokens: number; missTokens: number; hitRate?: number } | null;
  /** When provided, the popup gains a "Compact now" action. */
  onCompact?: () => void;
  compacting?: boolean;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * c;
  const tone = clamped > 90 ? 'var(--dt-danger)' : clamped > 70 ? 'var(--dt-warning)' : 'var(--dt-success)';
  const cacheTotal = (promptCache?.hitTokens ?? 0) + (promptCache?.missTokens ?? 0);
  const cacheRate =
    promptCache?.hitRate ??
    (cacheTotal > 0 ? (promptCache?.hitTokens ?? 0) / cacheTotal : 0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

  // Recompute tooltip position when opening or when viewport changes.
  // Position is computed synchronously (not via requestAnimationFrame) so the
  // portal renders in the same commit as `open` — rAF is not reliably flushed
  // in jsdom and left the tooltip absent.
  useEffect(() => {
    if (!open) {
      setTooltipPos(null);
      return;
    }
    const compute = () => {
      if (!rootRef.current) return;
      const r = rootRef.current.getBoundingClientRect();
      const TOOLTIP_W = 288; // w-72
      const TOOLTIP_H = 280; // full content may be 250+ with cache/compact rows
      const margin = 8;
      // Keep tooltip fully on-screen. Composer sits at the very bottom, so
      // the only safe placement is *above* the trigger; falling below would
      // be off-screen. Clamp to viewport with margin.
      let left = r.right - TOOLTIP_W;
      let top = r.top - TOOLTIP_H - margin;
      left = Math.max(margin, Math.min(left, window.innerWidth - TOOLTIP_W - margin));
      top = Math.max(margin, Math.min(top, window.innerHeight - TOOLTIP_H - margin));
      setTooltipPos({ top, left });
    };
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open]);

  // Close on click outside + Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Pre-compute breakdown rows (each row needs a label, a value, a color, and a percent)
  const rows = breakdown
    ? (() => {
        const total = Math.max(
          1,
          breakdown.messages + breakdown.thinking + breakdown.systemTools + breakdown.systemPrompt + breakdown.skills + breakdown.meta
        );
        const items: Array<{ label: string; tokens: number; pct: number; opacity: number }> = [
          { label: 'Messages',       tokens: breakdown.messages,     pct: (breakdown.messages / total) * 100,     opacity: 1    },
          { label: 'Thinking',       tokens: breakdown.thinking,     pct: (breakdown.thinking / total) * 100,     opacity: 0.80 },
          { label: 'Tool definitions', tokens: breakdown.systemTools,  pct: (breakdown.systemTools / total) * 100,  opacity: 0.65 },
          { label: 'System prompt',  tokens: breakdown.systemPrompt, pct: (breakdown.systemPrompt / total) * 100, opacity: 0.45 },
          { label: 'Skills',         tokens: breakdown.skills,       pct: (breakdown.skills / total) * 100,       opacity: 0.30 },
          { label: 'Meta context',   tokens: breakdown.meta,         pct: (breakdown.meta / total) * 100,         opacity: 0    },
        ];
        return items;
      })()
    : null;

  return (
    <div
      ref={rootRef}
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => !breakdown && setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center cursor-pointer"
        aria-label={`${clamped}% of context used. Click for breakdown.`}
      >
        <svg width={size} height={size} className="-rotate-90 shrink-0">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--dt-muted)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={tone}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c - dash}`}
            style={{ transition: 'stroke-dasharray 0.3s ease, stroke 0.3s ease' }}
          />
        </svg>
      </button>

      {tooltipPos && createPortal(
        <div
          className="fixed z-50 w-72 rounded-lg shadow-2xl p-3 text-left animate-in fade-in slide-in-from-bottom-1 duration-100 max-h-[min(72vh,420px)] overflow-y-auto overscroll-contain"
          style={{
            top: tooltipPos.top,
            left: tooltipPos.left,
            backgroundColor: 'var(--dt-popover)',
            border: '0.5px solid var(--dt-border)',
            color: 'var(--dt-popover-foreground)',
          }}
          data-composer-popover=""
        >
          <div className="flex items-center justify-between text-[12.5px] mb-1.5">
            <span className="font-medium" style={{ color: 'var(--dt-popover-foreground)' }}>Session Context</span>
            <span className="font-mono tabular-nums text-muted-foreground text-[11.5px]">
              {formatTokens(estTokens)} / {formatTokens(maxContext)} tokens used ({clamped}%)
            </span>
          </div>
          <div className="h-1 rounded-full overflow-hidden mb-2.5" style={{ backgroundColor: 'var(--dt-muted)' }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${clamped}%`, backgroundColor: 'var(--dt-primary)' }}
            />
          </div>
          {rows && (
            <div className="space-y-0.5">
              {rows.map((r) => (
                <div key={r.label} className="flex items-center gap-1.5 py-[2px] text-[11.5px]">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: r.opacity === 0 ? 'var(--dt-muted-foreground)' : 'var(--dt-primary)',
                      opacity: r.opacity === 0 ? 1 : r.opacity,
                    }}
                  />
                  <span style={{ color: 'var(--dt-muted-foreground)' }}>{r.label}</span>
                  <span className="ml-auto font-mono tabular-nums text-muted-foreground text-[11px]">
                    {r.pct.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          )}
          {modelName && (
            <div className="mt-2 pt-2 border-t text-[11px] text-muted-foreground truncate" style={{ borderColor: 'var(--dt-border)' }}>
              <span className="opacity-60">Model · </span>
              <span style={{ color: 'var(--dt-popover-foreground)' }}>{modelName}</span>
            </div>
          )}
          {promptCache && (
            <div className="mt-2 pt-2 border-t text-[11px] text-muted-foreground" style={{ borderColor: 'var(--dt-border)' }}>
              <div className="flex items-center justify-between">
                <span className="font-medium" style={{ color: 'var(--dt-muted-foreground)' }}>Prompt cache</span>
                <span
                  className="font-mono tabular-nums"
                  style={{ color: cacheRate >= 0.6 ? 'var(--dt-success)' : cacheRate >= 0.3 ? 'var(--dt-warning)' : 'var(--dt-danger)' }}
                >
                  {Math.round(cacheRate * 100)}% hit
                </span>
              </div>
              <div className="flex justify-between mt-0.5">
                <span className="opacity-60">Cached / total input</span>
                <span className="font-mono tabular-nums" style={{ color: 'var(--dt-popover-foreground)' }}>
                  {formatTokens(promptCache?.hitTokens ?? 0)} / {formatTokens(cacheTotal)}
                </span>
              </div>
            </div>
          )}
          {serverTokens && (
            <div className="mt-2 pt-2 border-t text-[11px] text-muted-foreground" style={{ borderColor: 'var(--dt-border)' }}>
              <div className="font-medium" style={{ color: 'var(--dt-muted-foreground)' }}>Server‑reported usage</div>
              <div className="flex justify-between">
                <span className="opacity-60">Total</span>
                <span className="font-mono tabular-nums" style={{ color: 'var(--dt-popover-foreground)' }}>{formatTokens(serverTokens.total)}</span>
              </div>
              <div className="flex justify-between">
                <span className="opacity-60">Input</span>
                <span className="font-mono tabular-nums" style={{ color: 'var(--dt-popover-foreground)' }}>{formatTokens(serverTokens.input)}</span>
              </div>
              <div className="flex justify-between">
                <span className="opacity-60">Output</span>
                <span className="font-mono tabular-nums" style={{ color: 'var(--dt-popover-foreground)' }}>{formatTokens(serverTokens.output)}</span>
              </div>
            </div>
          )}
          {onCompact && (
            <div
              className="mt-2 pt-2 border-t flex items-center justify-between gap-2"
              style={{ borderColor: 'var(--dt-border)' }}
            >
              <span className="text-[11px] text-muted-foreground">Context getting full?</span>
              <button
                type="button"
                onClick={onCompact}
                disabled={compacting}
                className="rounded-md px-2 py-1 text-[11px] font-medium transition-opacity disabled:opacity-60"
                style={{
                  backgroundColor: 'var(--dt-primary)',
                  color: 'var(--dt-primary-foreground)',
                }}
                data-testid="context-compact"
              >
                {compacting ? 'Compacting…' : 'Compact now'}
              </button>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

function formatTokens(n: number | undefined | null): string {
  if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}
