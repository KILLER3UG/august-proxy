import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextBreakdown } from './context-breakdown';

/* ── Context usage ring — compact, details on hover ─────────────────── */
/* A ~20px donut next to the model chip. Hovering/clicking reveals the
 * "Context windows" card: header + usage bar, one row per context slice,
 * and the average cache hit rate after a divider — matching the Z.ai-style
 * reference (same geometry; August's own palette). */

export function ContextRing({
  pct,
  estTokens,
  maxContext,
  breakdown,
  promptCache,
  size = 22,
  stroke = 3,
}: {
  pct: number;
  estTokens: number;
  maxContext: number;
  /** When provided, the hover popup shows a per-category breakdown. */
  breakdown?: ContextBreakdown;
  /** Universal prompt-cache split for this session (hit rate display). */
  promptCache?: { hitTokens: number; missTokens: number; hitRate?: number } | null;
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
      const TOOLTIP_W = 380;
      const TOOLTIP_H = 340;
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
        // MCP tools are a SUBSET of system tools — shown as an indented sub-row
        // (share of *used* context; the indent keeps the sum from reading >100%).
        const mcpTokens = breakdown.mcpTools ?? 0;
        const items: Array<{
          label: string;
          tokens: number;
          pct: number;
          opacity: number;
          indent?: boolean;
          sub?: boolean;
        }> = [
          { label: 'Messages',      tokens: breakdown.messages,     pct: (breakdown.messages / total) * 100,     opacity: 1    },
          { label: 'Thinking',      tokens: breakdown.thinking,     pct: (breakdown.thinking / total) * 100,     opacity: 0.80 },
          { label: 'System tools',  tokens: breakdown.systemTools,  pct: (breakdown.systemTools / total) * 100,  opacity: 0.65 },
        ];
        if (mcpTokens > 0) {
          items.push({
            label: 'MCP tools',
            tokens: mcpTokens,
            pct: (mcpTokens / total) * 100,
            opacity: 0.55,
            indent: true,
            sub: true,
          });
        }
        items.push(
          { label: 'System prompt', tokens: breakdown.systemPrompt, pct: (breakdown.systemPrompt / total) * 100, opacity: 0.45 },
          { label: 'Skills',        tokens: breakdown.skills,       pct: (breakdown.skills / total) * 100,       opacity: 0.30 },
          { label: 'Meta context',  tokens: breakdown.meta,         pct: (breakdown.meta / total) * 100,         opacity: 0    },
        );
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
        aria-label={`${clamped}% of context used${cacheTotal > 0 ? `, ${Math.round(cacheRate * 100)}% avg cache hit` : ''}. Click for breakdown.`}
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
          className="fixed z-50 w-[380px] rounded-xl shadow-2xl p-4 text-left animate-in fade-in slide-in-from-bottom-1 duration-100 max-h-[min(72vh,420px)] overflow-y-auto overscroll-contain"
          style={{
            top: tooltipPos.top,
            left: tooltipPos.left,
            backgroundColor: 'var(--dt-popover)',
            border: '0.5px solid var(--dt-border)',
            color: 'var(--dt-popover-foreground)',
          }}
          data-composer-popover=""
        >
          {/* Header — bold title left, mono used/limit (%) right. */}
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold" style={{ color: 'var(--dt-popover-foreground)' }}>
              Context windows
            </span>
            <span className="font-mono tabular-nums text-[12px]" style={{ color: 'var(--dt-muted-foreground)' }}>
              {formatTokens(estTokens)}/{formatTokens(maxContext)} ({clamped}%)
            </span>
          </div>
          {/* Usage bar — full inner width, 4px, rounded. */}
          <div
            className="mt-2.5 h-1 rounded-full overflow-hidden"
            style={{ backgroundColor: 'var(--dt-border)' }}
            data-testid="context-window-bar"
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${clamped}%`, backgroundColor: tone, transition: 'width 0.3s ease, background-color 0.3s ease' }}
            />
          </div>
          {rows && (
            <div className="mt-2.5">
              {rows.map((r) => (
                <div
                  key={r.label}
                  className={'flex items-center gap-2.5 py-[5px] text-[13px]' + (r.indent ? ' pl-3.5' : '')}
                >
                  <span
                    className="w-[7px] h-[7px] rounded-full shrink-0"
                    style={{
                      backgroundColor: r.opacity === 0 ? 'var(--dt-muted-foreground)' : 'var(--dt-primary)',
                      opacity: r.opacity === 0 ? 1 : r.opacity,
                    }}
                  />
                  <span style={{ color: 'var(--dt-muted-foreground)' }}>
                    {r.label}
                    {r.sub && <span className="opacity-60"> ↳</span>}
                  </span>
                  <span className="ml-auto font-mono tabular-nums text-[12px]" style={{ color: 'var(--dt-muted-foreground)' }}>
                    {r.pct.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          )}
          {promptCache && (
            <div className="mt-2 pt-3 border-t flex items-center justify-between" style={{ borderColor: 'var(--dt-border)' }}>
              <span className="text-[13px]" style={{ color: 'var(--dt-muted-foreground)' }}>
                Average cache hit rate
              </span>
              <span className="font-mono tabular-nums text-[12px]" style={{ color: tone }}>
                {Math.round(cacheRate * 100)}%
              </span>
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
