/* ── Turn Limits ─────────────────────────────────────────────────────────
 * Optional bounds on a single agent turn.
 *
 * Every control here was already accepted by `PUT /api/brain/config` and read
 * by the loop — and none of them had any UI. AGENTS.md tells the user to set
 * them, the backend honours them, and the app shipped no door: `maxWorkbenchToolLoops`
 * existed in the TypeScript client as a *type* only, and the runaway backstop's
 * two keys weren't even in the backend's fieldTable, so a PUT naming them was
 * rejected and a hand-edited config.json value was dropped before the guard
 * could read it. The backstop is now settable (brain_config_service.numKeys).
 *
 * Rendered from a FIELD TABLE rather than hand-written per key, so a knob added
 * server-side appears here with its label and hint instead of needing a second
 * edit — the same schema-driven approach the reference harnesses use for their
 * own agent settings.
 *
 * 0 = off everywhere, and that is the shipped default on purpose: this project
 * treats any rule that ends a turn early as opt-in, the way `verifierEnforced`
 * was opt-in before it was removed. The hints say so rather than implying a
 * limit is recommended.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Gauge, Loader2, RotateCcw } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';

interface BrainConfigResponse {
  source: string;
  config: Record<string, unknown>;
  defaults: Record<string, unknown>;
  sessionId?: string | null;
}

type FieldSpec = {
  key: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  unit?: string;
};

/* Order is the reading order: the hard cap, then the soft budget ladder, then
 * the backstop for a turn that never trips either.
 *
 * This table is the ONE place these are described. It is hand-written because
 * the label and hint are product copy, not metadata the backend can supply —
 * but the KEYS are pinned to what the backend actually accepts by
 * `tests/test_turn_limits_fields.py`, so a key renamed or removed server-side
 * fails that test instead of rendering a control that silently 400s. */
const TURN_FIELDS: FieldSpec[] = [
  {
    key: 'maxWorkbenchToolLoops',
    label: 'Tool-round cap',
    hint: 'Stop a turn after this many tool calls. 0 (the default) means unlimited — stall detection still stops a genuinely stuck turn.',
    min: 0,
    max: 500,
    unit: 'rounds',
  },
  {
    key: 'budgetSoftUsd',
    label: 'Soft cost budget',
    hint: "Degrade the turn when this turn's estimated cost passes the mark — it drops to a bare tool surface, then compacts, then answers without tools. 0 = off.",
    min: 0,
    max: 10000,
    unit: 'USD',
  },
  {
    key: 'budgetSoftTokens',
    label: 'Soft token budget',
    hint: 'Same degradation ladder, counted in tokens. 0 = off.',
    min: 0,
    max: 50000000,
    unit: 'tokens',
  },
  {
    key: 'budgetWallClockSec',
    label: 'Soft time budget',
    hint: 'Same degradation ladder, measured on the wall clock. 0 = off.',
    min: 0,
    max: 86400,
    unit: 'seconds',
  },
  {
    key: 'runawayNudgeRounds',
    label: 'Runaway warning after',
    hint: 'Warn the model when a turn has run this long without changing anything. Leave at 0 to follow half the hard stop below.',
    min: 0,
    max: 100000,
    unit: 'rounds',
  },
  {
    key: 'runawayStopRounds',
    label: 'Runaway hard stop after',
    hint: 'The only backstop for a turn that calls something different every round: stall detection deliberately resets when the arguments change, so this one counts changes instead. Leave it at 0 (off) unless you want turns ended — leaving it unset warns first.',
    min: 0,
    max: 100000,
    unit: 'rounds',
  },
];

function formatValue(spec: FieldSpec, value: number): string {
  if (value === 0) return 'off';
  if (spec.unit === 'USD') return `$${value}`;
  if (spec.unit === 'seconds' && value >= 3600) {
    const h = Math.floor(value / 3600);
    const m = Math.round((value % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return value.toLocaleString();
}

export function TurnLimitsSection() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const configQ = useQuery<BrainConfigResponse>({
    queryKey: ['brain-config'],
    queryFn: () => api.get<BrainConfigResponse>('/api/brain/config'),
  });

  const mutate = useMutation({
    mutationFn: (next: Record<string, number>) =>
      api.put<{ ok: boolean }>('/api/brain/config', next),
    onSuccess: () => {
      setDraft({});
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['brain-config'] });
    },
    onError: (err: Error) => {
      setSaved(false);
      window.alert(`Could not save the turn limits: ${err.message}`);
    },
  });

  const config = configQ.data?.config ?? {};
  const defaults = configQ.data?.defaults ?? {};

  const rows = useMemo(
    () =>
      TURN_FIELDS.map((spec) => {
        const raw = config[spec.key];
        const current = typeof raw === 'number' ? raw : 0;
        const draftValue = draft[spec.key];
        const shown =
          draftValue !== undefined
            ? Number(draftValue)
            : current;
        const isDefault = current === (typeof defaults[spec.key] === 'number' ? defaults[spec.key] : 0);
        return { spec, current, shown, isDefault };
      }),
    [config, defaults, draft],
  );

  const pending = rows.some((r) => draft[r.spec.key] !== undefined);
  const atDefaults = rows.every((r) => r.isDefault);

  if (configQ.isLoading) {
    return (
      <div className="px-8 py-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (configQ.isError) {
    return (
      <div className="px-8 py-6">
        <p role="alert" className="text-sm text-rose-400/90" data-testid="turn-limits-error">
          Could not read the current turn limits. Nothing has been changed.
        </p>
      </div>
    );
  }

  return (
    <div className="px-8 py-6 max-w-2xl">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
        <Gauge className="size-6 text-primary" /> Turn Limits
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Optional bounds on a single turn. All of these are off by default — a limit that ends
        your work early is your call, not the default.
      </p>

      <div className="mt-5 rounded-xl border border-white/[0.06] bg-card/60 p-5">
        <div className="divide-y divide-white/[0.04]">
          {rows.map(({ spec, shown, isDefault }) => (
            <div key={spec.key} className="py-3" data-testid={`turn-limit-${spec.key}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm text-foreground">
                    {spec.label}
                    {!isDefault ? (
                      <span className="rounded-full border border-primary/30 px-1.5 py-0.5 text-2xs text-primary">
                        changed
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{spec.hint}</p>
                </div>
                <div className="shrink-0 text-right">
                  <input
                    type="number"
                    min={spec.min}
                    max={spec.max}
                    aria-label={spec.label}
                    data-testid={`turn-limit-input-${spec.key}`}
                    value={draft[spec.key] ?? String(shown)}
                    onChange={(e) => {
                      setSaved(false);
                      setDraft((d) => ({ ...d, [spec.key]: e.target.value }));
                    }}
                    className="w-28 rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-right text-xs text-foreground outline-none focus:border-primary/40"
                  />
                  <p className="mt-1 text-2xs text-muted-foreground">
                    {formatValue(spec, shown)}
                    {shown !== 0 && spec.unit ? ` ${spec.unit}` : ''}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <Button
            size="sm"
            disabled={!pending || mutate.isPending}
            onClick={() => {
              const next: Record<string, number> = {};
              for (const { spec, shown } of rows) {
                if (draft[spec.key] !== undefined) {
                  next[spec.key] = Math.max(spec.min, Math.min(spec.max, Math.round(shown)));
                }
              }
              mutate.mutate(next);
            }}
          >
            {mutate.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!pending || mutate.isPending}
            onClick={() => {
              setDraft({});
              setSaved(false);
            }}
          >
            Discard
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={atDefaults || mutate.isPending}
            onClick={() => {
              const next: Record<string, number> = {};
              for (const { spec, isDefault } of rows) {
                if (!isDefault) next[spec.key] = 0;
              }
              mutate.mutate(next);
            }}
          >
            <RotateCcw className="size-3" />
            Turn everything off
          </Button>
        </div>
        {saved ? (
          <p className="mt-3 text-2xs text-primary" data-testid="turn-limits-saved">
            Saved.
          </p>
        ) : null}
      </div>

      <div className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
        <p>
          A stopped turn is always explained in the transcript — expand the reason under the
          amber badge to see what to do next.
        </p>
      </div>
    </div>
  );
}
