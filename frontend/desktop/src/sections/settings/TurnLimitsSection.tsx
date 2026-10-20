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
import { AlertTriangle, Gauge, Loader2, RotateCcw, Shuffle } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { SettingsToggle } from '@/components/settings/SettingsToggle';

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
 * the backstop for a turn that never trips either, then the ceiling on Bot
 * work that keeps going with no human in the loop.
 *
 * This table is the ONE place these are described. It is hand-written because
 * the label and hint are product copy, not metadata the backend can supply.
 *
 * The KEYS are pinned to what the backend actually accepts by
 * `npm run check:brain-config` — a gate that ASKS the backend (it imports
 * `brain_config_service.py` and reads each key's range out of the
 * validator's own error message, so it cannot disagree with the validator
 * about what the range is) and fails when a key in this table is missing
 * from `numKeys`, or has no fieldTable entry, or has no explicit range
 * branch, or when the range below is wider than the backend's. It replaced
 * `tests/test_turn_limits_fields.py`, which was deleted with the rest of the
 * suite on 2026-10-17; a key renamed or removed server-side now fails that
 * gate instead of rendering a control that silently 400s.
 *
 * The RANGES below are the panel's own bounds and must match the backend's:
 * `maxWorkbenchToolLoops` accepts 0 (uncapped) through 500, and the runaway
 * and unattended keys accept 0 (off) so a bound can always be disarmed. */
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
    hint: 'Warn the model when a turn has run this long without changing anything. Only active once a hard stop is set below: left untouched it warns at 25 rounds, setting 0 warns immediately (round 0).',
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
  {
    key: 'maxUnattendedTurns',
    label: 'Unattended Bot turns',
    hint: 'How long a Bot chat may keep running on teammate messages before a human has to speak again. Once a chat has taken this many Bot-authored turns with no reply from you, its Bot can no longer message a teammate — it has to report where things stand and ask. Your reply resets it. 0 (the default) means no ceiling: a Bot team can then pass one ask around indefinitely, because every individual turn ends cleanly and the runaway stop above only sees one turn at a time.',
    min: 0,
    max: 500,
    unit: 'turns',
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
  const [saveError, setSaveError] = useState<string | null>(null);

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
      setSaveError(null);
      void qc.invalidateQueries({ queryKey: ['brain-config'] });
    },
    onError: (err: Error) => {
      setSaved(false);
      // An inline, announced error — not a native dialog. A modal alert over a
      // settings form is the only window.alert left in this surface, and it
      // put the failure in a separate window the user had to dismiss before
      // they could see which input was rejected.
      setSaveError(err.message);
    },
  });

  /* The context-relief route is a SWITCH, not a number, so it cannot ride
   * the field table above: it has its own mutation and its own card, and it
   * saves the moment it is flipped (a toggle with a Save button two inches
   * away is a toggle nobody flips).
   *
   * `contextReliefRotate` is a BOOL brain-config key, already accepted by the
   * backend (`brain_config_service.boolKeys` + a fieldTable entry), and it
   * had NO door at all: the only way to arm it was to hand-edit config.json.
   * `npm run check:brain-config` reads the keys this panel writes and asks
   * the backend whether it accepts them, so this control cannot drift from
   * the backend's accepted set without the gate failing.
   */
  const reliefMut = useMutation({
    mutationFn: (next: Record<string, boolean>) =>
      api.put<{ ok: boolean }>('/api/brain/config', next),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['brain-config'] });
    },
    onError: (err: Error) => {
      setSaveError(err.message);
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

  // aria-invalid belongs to the field the BACKEND rejected, not to every
  // field on the panel. A save that failed because the network dropped did
  // not reject any input, and marking all seven of them invalid tells the
  // user seven things are wrong when none is.
  //
  // The validator's message names the key it refused ("maxWorkbenchToolLoops
  // must be between 0 and 500"), so the rejected fields are read out of it.
  const rejectedKeys = useMemo(() => {
    if (!saveError) return new Set<string>();
    const named = new Set<string>();
    for (const spec of TURN_FIELDS) {
      if (saveError.includes(spec.key)) named.add(spec.key);
    }
    return named;
  }, [saveError]);

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
        <p role="alert" className="text-sm text-danger-fg" data-testid="turn-limits-error">
          Could not read the current turn limits. Nothing has been changed.
        </p>
      </div>
    );
  }

  return (
    <div className="px-8 py-6 max-w-2xl">
      <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
        <Gauge className="size-6 text-primary" /> Turn Limits
      </h2>
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
                    aria-invalid={rejectedKeys.has(spec.key) ? true : undefined}
                    aria-describedby={
                      rejectedKeys.has(spec.key) ? 'turn-limits-save-error' : undefined
                    }
                    data-testid={`turn-limit-input-${spec.key}`}
                    value={draft[spec.key] ?? String(shown)}
                    onChange={(e) => {
                      setSaved(false);
                      setSaveError(null);
                      setDraft((d) => ({ ...d, [spec.key]: e.target.value }));
                    }}
                    className="w-28 rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-right text-xs text-foreground outline-none focus:border-primary/40 aria-[invalid=true]:border-danger/60"
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
        {saveError ? (
          <p
            id="turn-limits-save-error"
            role="alert"
            className="mt-3 text-2xs text-danger-fg"
            data-testid="turn-limits-save-error"
          >
            Could not save the turn limits: {saveError}
          </p>
        ) : null}
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

      {/* Context relief — the SECOND route, and the only one that is a choice.
          Everything above is a bound; this is a different way to make room.
          Off (the default) a long chat is compacted in place: the first few
          messages stay verbatim forever and everything after them is folded
          into a running summary, so from the second relief onward the
          summary describes a follow-up rather than the original ask. On, a
          relief that already has a note RE-ANCHORS the chat onto that note
          instead of stacking another one — the opening is claimed back
          verbatim and the newest turns keep the room. */}
      <div className="mt-6 rounded-xl border border-white/[0.06] bg-card/60 p-5">
        <div className="flex items-center gap-2">
          <Shuffle className="size-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Context relief</h3>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          How August makes room when a conversation outgrows the model&rsquo;s context
          window. Off is the shipped behaviour and nothing changes unless you turn it on.
        </p>
        <div className="mt-3">
          <SettingsToggle
            checked={Boolean(config.contextReliefRotate)}
            onCheckedChange={(next) => reliefMut.mutate({ contextReliefRotate: next })}
            label="Rotate onto a handoff note"
            description="After the first summary exists, a long chat re-anchors onto that note instead of stacking a new summary on top of it. The original ask is claimed back verbatim, and the newest turns keep the room. Your chat keeps its history either way."
            disabled={configQ.isLoading || reliefMut.isPending}
            data-testid="context-relief-rotate-toggle"
          />
        </div>
        {reliefMut.isError ? (
          <p role="alert" className="mt-2 text-2xs text-danger-fg" data-testid="context-relief-error">
            Could not save the context-relief setting: {reliefMut.error?.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
