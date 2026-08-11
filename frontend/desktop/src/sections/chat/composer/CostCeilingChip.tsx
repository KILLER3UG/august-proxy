/* ── CostCeilingChip — per-session spend ceiling in the composer extras ── */
/* Shows the estimated session cost; click "cap" (or the ceiling value) to
 * set/raise/clear the ceiling. New turns are blocked once the cost reaches
 * the ceiling (backend-enforced). */

import { useState } from 'react';
import { toast } from 'sonner';
import { Wallet } from 'lucide-react';
import { setWorkbenchCostCeiling } from '@/api/workbench';

export function CostCeilingChip({
  sessionId,
  cost,
  initialCeiling,
}: {
  sessionId: string;
  /** Estimated cumulative session cost in USD (from the usage endpoint). */
  cost: number;
  initialCeiling: number;
}) {
  const [ceiling, setCeiling] = useState(initialCeiling > 0 ? initialCeiling : 0);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialCeiling > 0 ? String(initialCeiling) : '');

  const commit = async () => {
    setEditing(false);
    const n = parseFloat(value);
    const next = Number.isFinite(n) && n > 0 ? n : 0;
    if (next === ceiling) {
      if (next === 0) setValue('');
      return;
    }
    try {
      await setWorkbenchCostCeiling(sessionId, next);
      setCeiling(next);
      if (next === 0) setValue('');
      toast.success(next > 0 ? `Cost ceiling set to $${next.toFixed(2)}` : 'Cost ceiling cleared');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to set ceiling');
    }
  };

  const pct = ceiling > 0 ? cost / ceiling : 0;
  const over = ceiling > 0 && cost >= ceiling;

  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] font-mono tabular-nums"
      title={
        ceiling > 0
          ? `Per-session spend ceiling: $${cost.toFixed(3)} of $${ceiling.toFixed(2)} used`
          : 'Estimated session spend — click "cap" to set a per-session ceiling'
      }
      data-testid="cost-ceiling-chip"
    >
      <Wallet className="size-3 text-muted-foreground" />
      <span className={over ? 'text-amber-500' : 'text-muted-foreground'}>${cost.toFixed(3)}</span>
      {ceiling > 0 && (
        <>
          <span className="text-muted-foreground/50">/</span>
          <button
            type="button"
            onClick={() => {
              setValue(String(ceiling));
              setEditing(true);
            }}
            className={pct >= 0.8 ? 'text-amber-500 hover:text-amber-400' : 'text-muted-foreground hover:text-foreground'}
          >
            ${ceiling.toFixed(2)}
          </button>
        </>
      )}
      {ceiling === 0 && !editing && (
        <button
          type="button"
          onClick={() => {
            setValue('');
            setEditing(true);
          }}
          className="text-muted-foreground/70 hover:text-foreground"
        >
          cap
        </button>
      )}
      {editing && (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          placeholder="0.00"
          inputMode="decimal"
          className="w-14 rounded border border-primary/40 bg-background px-1 py-0 text-[10px] font-mono outline-none"
          aria-label="Cost ceiling in USD"
        />
      )}
    </span>
  );
}
