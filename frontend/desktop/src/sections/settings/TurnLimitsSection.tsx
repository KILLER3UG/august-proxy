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
 * 0 = off, and the value shown is the EFFECTIVE one: a key the backend never
 * received is reported by the backend's own defaults, not by a local 0. The
 * round cap and the budget ladder ship at 0 (opt-in); the runaway backstop
 * ships armed, because an install that never opened this panel had no bound on
 * a turn at all and a model that varies its arguments every round trips nothing
 * else. Writing 0 here still disarms it.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RotateCcw, Shuffle } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/SectionHeader';
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
    hint: 'Stop a turn after this many tool calls. 0 = unlimited.',
    min: 0,
    max: 500,
    unit: 'rounds',
  },
  {
    key: 'budgetSoftUsd',
    label: 'Soft cost budget (USD)',
    hint: 'Degrade the turn past this cost — bare tools, then compaction. 0 = off.',
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
    label: 'Soft time budget (seconds)',
    hint: 'Same degradation ladder, on the wall clock. 0 = off.',
    min: 0,
    max: 86400,
    unit: 'seconds',
  },
  {
    key: 'runawayNudgeRounds',
    label: 'Runaway warning after (rounds)',
    hint: 'Warn when a turn runs this long without touching anything new. 0 = warn never, just stop.',
    min: 0,
    max: 100000,
    unit: 'rounds',
  },
  {
    key: 'runawayStopRounds',
    label: 'Runaway hard stop after (rounds)',
    hint: 'Ends a turn that keeps calling different things without changing anything. Armed by default; 0 = off.',
    min: 0,
    max: 100000,
    unit: 'rounds',
  },
  {
    key: 'maxUnattendedTurns',
    label: 'Unattended Bot turns',
    hint: 'Bot-authored turns a chat may run before a human must reply. 0 = off.',
    min: 0,
    max: 500,
    unit: 'turns',
  },
];

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

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
        // Narrowing an index-signature read does not stick in TS, so the
        // backend's default goes through a helper rather than a typeof test.
        const fallback = asNumber(defaults[spec.key], 0);
        // An unconfigured key is NOT zero: the runaway backstop arms itself when
        // the key is absent, so reading absence as 0 rendered "off" under a loop
        // that was counting rounds. Ask the backend what the default is.
        const current = asNumber(raw, fallback);
        const draftValue = draft[spec.key];
        const shown =
          draftValue !== undefined
            ? Number(draftValue)
            : current;
        const isDefault = current === fallback;
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
    <div className="px-8 py-6">
      {/* The standard panel header: ONE title, ONE subtitle, and the
          panel's actions in the header's own slot. The reference's settings
          modal has no footer bar, so the actions live at the top right. */}
      <SectionHeader
        title="Turn Limits"
        subtitle="Optional bounds on a single turn. All of these are off by default — a limit that ends your work early is your call, not the default."
        actions={
          <>
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
          </>
        }
      />

      {/* ONE container with hairline-separated children. The reference's
          settings panel is a single rounded box whose rows are divided by
          hairlines — not a stack of bordered cards. */}
      <div className="mt-5 overflow-hidden rounded-xl border border-border/60 bg-card/60">
        <div className="divide-y divide-white/[0.04]">
          {rows.map(({ spec, shown, isDefault }) => (
            <div
              key={spec.key}
              className="flex items-start justify-between gap-6 px-5 py-3"
              data-testid={`turn-limit-${spec.key}`}
            >
              {/* NAME — the label and ONE short line, and nothing else. */}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{spec.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{spec.hint}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {/* The marker is metadata: muted, not a chip, and not in the
                    name column. */}
                {!isDefault ? (
                  <span className="text-2xs text-muted-foreground">changed</span>
                ) : null}
                {/* VALUE — ONE value, at the name's type size, and the
                    control sits at the row's right edge. */}
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
                  title={`${formatValue(spec, shown)}${shown !== 0 && spec.unit ? ` ${spec.unit}` : ''}`}
                  value={draft[spec.key] ?? String(shown)}
                  onChange={(e) => {
                    setSaved(false);
                    setSaveError(null);
                    setDraft((d) => ({ ...d, [spec.key]: e.target.value }));
                  }}
                  className="w-24 rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-right text-sm text-foreground outline-none focus:border-primary/40 aria-[invalid=true]:border-danger/60"
                />
              </div>
            </div>
          ))}
        </div>

        {/* Context relief — the same container, one hairline down. */}
        <div className="border-t border-border/50 px-5 py-3">
          <div className="flex items-center gap-2">
            <Shuffle className="size-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Context relief</h3>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            How August makes room when a conversation outgrows the model&rsquo;s context window.
          </p>
          <div className="mt-1">
            <SettingsToggle
              checked={Boolean(config.contextReliefRotate)}
              onCheckedChange={(next) => reliefMut.mutate({ contextReliefRotate: next })}
              label="Rotate onto a handoff note"
              description="Off is the shipped behaviour; on, a long chat re-anchors onto its first handoff note."
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
        <p className="mt-3 text-2xs text-muted-foreground" data-testid="turn-limits-saved">
          Saved.
        </p>
      ) : null}

      <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
        A stopped turn is always explained in the transcript.
      </p>
    </div>
  );
}
