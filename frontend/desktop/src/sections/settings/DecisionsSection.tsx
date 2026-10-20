/* ── DecisionsSection — the decision ledger as a human surface ────────────── */
/* 053. The harness kept five per-turn records and no key between them, and its
 * only measurement (`harness_outcome`) compared a quiet fortnight to a busy one
 * with no control arm. This is the half that shows the result: one row per
 * decision, the thesis and the alternatives that were rejected (the
 * counterfactual), what it cost, and — once the daily `journal` job has run —
 * how it settled and how well the confidence was calibrated.
 *
 * The one rule that governs the whole surface: `unscorableRate` never appears
 * alone. A Brier score over three resolved rows out of forty is luck, not
 * calibration, and the product's job is to make that difference visible rather
 * than to publish the flattering number. The empty state is honest for the same
 * reason — a fresh install has logged nothing, and saying so is more useful than
 * a chart of zeros. */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { getBrainConfig, saveBrainConfig } from '@/api/workbench';
import { Button } from '@/components/ui/button';
import { SettingsToggle } from '@/components/settings/SettingsToggle';

interface DecisionRow {
  id: number;
  ts?: string;
  session_id?: string;
  turn_id?: number | null;
  kind?: string;
  source?: string;
  chosen?: string;
  alternatives?: string | null;
  thesis?: string;
  observable?: string;
  confidence?: number | null;
  horizon_turns?: number | null;
  due_at?: string | null;
  cost_usd?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  status?: string;
  outcome?: number | null;
  resolved_at?: string | null;
  evidence?: string | null;
  model?: string;
  provider?: string;
}

interface Bucket {
  name?: string;
  decisions?: number;
  resolved?: number;
  unscorable?: number;
  hitRate?: number | null;
  brier?: number | null;
  unscorableRate?: number | null;
}

interface DecisionsResponse {
  days?: number;
  digest?: {
    day?: string;
    logged?: number;
    resolved?: number;
    unscorable?: number;
    expired?: number;
    costUsd?: number;
    costPerResolved?: number | null;
  };
  stats?: { days?: number; rows?: number; byModel?: Bucket[]; byKind?: Bucket[] };
  rows?: DecisionRow[];
}

const STATUS_TONE: Record<string, string> = {
  resolved: 'text-success border-success/40 bg-success/10',
  unscorable: 'text-muted-foreground border-border/60 bg-muted/30',
  expired: 'text-warning border-warning/40 bg-warning/10',
  open: 'text-info border-info/40 bg-info/10',
};

function pct(value: number | null | undefined): string {
  if (typeof value !== 'number') return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function brier(value: number | null | undefined): string {
  if (typeof value !== 'number') return '—';
  return value.toFixed(3);
}

function money(value: number | null | undefined): string {
  if (typeof value !== 'number') return '—';
  return `$${value.toFixed(4)}`;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Alternatives, when a model logged any — the counterfactual half. The
 *  ledger stores `why_rejected` snake_case (053's column); the local shape is
 *  camelCase per the lint rule, mapped here in one place. */
interface Alternative {
  action: string;
  whyRejected: string;
}

function alternatives(raw: string | null | undefined): Alternative[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as { action?: unknown; why_rejected?: unknown; whyRejected?: unknown };
      const action =
        typeof record.action === 'string'
          ? record.action
          : record.action == null
            ? ''
            : JSON.stringify(record.action);
      const why =
        typeof record.why_rejected === 'string'
          ? record.why_rejected
          : typeof record.whyRejected === 'string'
            ? record.whyRejected
            : '';
      return [{ action, whyRejected: why }];
    });
  } catch {
    return [];
  }
}

function BucketTable({ rows, label }: { rows: Bucket[] | undefined; label: string }) {
  if (!rows?.length) return null;
  return (
    <div data-testid="decisions-bucket">
      <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[0.65625rem] text-muted-foreground">
            <th className="py-0.5 pr-2 font-medium">{label === 'By model' ? 'Model' : 'Kind'}</th>
            <th className="py-0.5 pr-2 font-medium">Decided</th>
            <th className="py-0.5 pr-2 font-medium">Resolved</th>
            <th className="py-0.5 pr-2 font-medium">Unscorable</th>
            <th className="py-0.5 pr-2 font-medium">Hit rate</th>
            <th className="py-0.5 pr-2 font-medium">Brier</th>
            <th className="py-0.5 font-medium">Unscorable rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.name ?? '?'} className="border-t border-border/40">
              <td className="max-w-[13rem] truncate py-1 pr-2 text-foreground/90" title={b.name}>
                {b.name || '(unknown)'}
              </td>
              <td className="py-1 pr-2 text-muted-foreground">{b.decisions ?? 0}</td>
              <td className="py-1 pr-2 text-muted-foreground">{b.resolved ?? 0}</td>
              <td className="py-1 pr-2 text-muted-foreground">{b.unscorable ?? 0}</td>
              <td className="py-1 pr-2 text-muted-foreground">{pct(b.hitRate)}</td>
              <td className="py-1 pr-2 text-muted-foreground">{brier(b.brier)}</td>
              <td className="py-1 text-muted-foreground">{pct(b.unscorableRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DecisionsSection() {
  const qc = useQueryClient();
  const [days] = useState(30);
  const [status, setStatus] = useState('');

  const q = useQuery({
    queryKey: ['brain-decisions', days, status],
    queryFn: () =>
      api.get<DecisionsResponse>(
        `/api/brain/decisions?days=${days}${status ? `&status=${encodeURIComponent(status)}` : ''}&limit=50`,
      ),
    refetchInterval: 60_000,
  });

  const resolveNow = useMutation({
    mutationFn: () => api.post('/api/brain/decisions/resolve'),
    onSuccess: () => {
      toast.success('Journal pass finished — ledger updated');
      void qc.invalidateQueries({ queryKey: ['brain-decisions'] });
    },
  });

  // ── The two knobs this panel owns ─────────────────────────────────────
  //
  // Both were WRITABLE by the backend and had no control anywhere, which
  // is the same gap `check:brain-config` exists to close: a key nobody can
  // reach is a key nobody can change.
  //
  //   decisionJournal    promotes `record_decision` into the core tool
  //                      set, so the MODEL can log its own decisions. Off
  //                      by default, because arming it changes what a
  //                      provider sees.
  //   journalIntervalHours  how often the daily journal pass runs.
  const cfgQ = useQuery({ queryKey: ['brain-config'], queryFn: getBrainConfig });
  const [journalHours, setJournalHours] = useState<number | null>(null);
  const [journalError, setJournalError] = useState('');

  useEffect(() => {
    const raw = cfgQ.data?.config?.journalIntervalHours;
    if (typeof raw === 'number') setJournalHours(raw);
  }, [cfgQ.data?.config?.journalIntervalHours]);

  const cfgMut = useMutation({
    mutationFn: (updates: Record<string, unknown>) => saveBrainConfig(updates),
    onSuccess: () => {
      setJournalError('');
      void qc.invalidateQueries({ queryKey: ['brain-config'] });
      void qc.invalidateQueries({ queryKey: ['brain-decisions'] });
    },
    onError: (err: Error) => {
      setJournalError(err.message);
      toast.error(`Could not save — ${err.message}`);
    },
  });

  const decisionJournalOn = Boolean(cfgQ.data?.config?.decisionJournal);

  const data = q.data;
  const digest = data?.digest;
  const logged = digest?.logged ?? 0;

  return (
    <section className="px-8 py-6" data-testid="decisions-section">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          {/* No icon: a section inside a route takes its name from the nav
              that already carries the glyph. The header grammar is written
              down in `sections/learning/LearningHub.tsx`. */}
          <h2 className="text-[0.8125rem] font-semibold text-foreground">Decisions</h2>
          <p className="mt-0.5 max-w-lg text-xs text-muted-foreground">
            One row per decision — the thesis, the alternatives that were rejected, and what it
            cost. A daily pass settles each one against the turn it belongs to and scores how well
            the confidence was calibrated.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="decisions-resolve"
          onClick={() => resolveNow.mutate()}
          disabled={resolveNow.isPending}
        >
          {resolveNow.isPending ? (
            <span className="flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              running…
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <RotateCcw className="size-3" aria-hidden="true" />
              resolve now
            </span>
          )}
        </Button>
      </div>

      {/* The two knobs. The cadence is a number because the backend's range
          is 1..168 hours; the switch is a switch because it is a boolean. */}
      <div
        className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-white/[0.06] bg-card/40 px-3 py-2.5"
        data-testid="decisions-controls"
      >
        <SettingsToggle
          checked={decisionJournalOn}
          onCheckedChange={(next) => cfgMut.mutate({ decisionJournal: next })}
          label="Let the model log its own decisions"
          disabled={cfgQ.isLoading || cfgMut.isPending}
          data-testid="decision-journal-toggle"
        />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Journal every</span>
          <input
            type="number"
            min={1}
            max={168}
            value={journalHours ?? ''}
            onChange={(e) => setJournalHours(e.target.value === '' ? null : Number(e.target.value))}
            onBlur={() => {
              if (journalHours === null) return;
              if (journalHours < 1 || journalHours > 168) {
                setJournalError('The journal cadence must be between 1 and 168 hours.');
                return;
              }
              cfgMut.mutate({ journalIntervalHours: journalHours });
            }}
            aria-label="Journal interval in hours"
            className="w-16 rounded border border-white/[0.08] bg-transparent px-1.5 py-0.5 text-xs text-foreground tabular-nums"
          />
          <span>hours</span>
        </label>
        {journalError ? (
          <span role="alert" className="text-xs text-danger-fg" data-testid="journal-cadence-error">
            {journalError}
          </span>
        ) : null}
      </div>

      {/* Digest. `unscorable` is never folded into a success number — it is the
          denominator that makes the rest mean something. */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="decisions-digest">
        {[
          { label: 'Logged', value: String(logged) },
          { label: 'Resolved', value: String(digest?.resolved ?? 0) },
          { label: 'Unscorable', value: String(digest?.unscorable ?? 0) },
          {
            label: 'Cost / resolved',
            value: digest?.costPerResolved == null ? '—' : money(digest.costPerResolved),
          },
        ].map((tile) => (
          <div
            key={tile.label}
            className="rounded-lg border border-border/50 bg-card/60 px-3 py-1.5"
          >
            <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              {tile.label}
            </p>
            <p className="text-sm text-foreground/90">{tile.value}</p>
          </div>
        ))}
      </div>

      {logged === 0 ? (
        <p className="rounded-lg border border-border/50 bg-card/60 px-3 py-2 text-xs text-muted-foreground">
          No decisions logged yet. August records one row per turn automatically; the daily journal
          pass settles them the next day. Nothing here needs a human until there is something to
          read.
        </p>
      ) : (
        <div className="space-y-4">
          <BucketTable rows={data?.stats?.byModel} label="By model" />
          <BucketTable rows={data?.stats?.byKind} label="By kind" />

          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Recent decisions
              </p>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                aria-label="Filter by status"
                className="rounded border border-border/60 bg-muted/30 px-1 py-0.5 text-[0.65625rem] text-muted-foreground"
              >
                <option value="">all</option>
                <option value="open">open</option>
                <option value="resolved">resolved</option>
                <option value="unscorable">unscorable</option>
                <option value="expired">expired</option>
              </select>
            </div>
            <ul className="space-y-1.5">
              {(data?.rows ?? []).map((row) => {
                const tone = STATUS_TONE[row.status ?? ''] ?? STATUS_TONE.open;
                const alts = alternatives(row.alternatives);
                return (
                  <li
                    key={row.id}
                    data-testid={`decision-row-${row.id}`}
                    className="rounded-lg border border-border/50 bg-card/60 px-3 py-1.5 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`shrink-0 rounded border px-1 text-[0.65625rem] ${tone}`}
                        data-testid={`decision-status-${row.id}`}
                      >
                        {row.status ?? 'open'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-foreground/90">
                        <span className="text-muted-foreground">
                          {row.source === 'model' ? 'decided' : 'turn'} ·{' '}
                        </span>
                        {row.chosen}
                      </span>
                      <span className="shrink-0 text-[0.65625rem] text-muted-foreground">
                        {ago(row.ts)}
                      </span>
                    </div>
                    {row.thesis ? (
                      <p className="mt-0.5 line-clamp-2 text-muted-foreground">{row.thesis}</p>
                    ) : null}
                    {(row.model || row.confidence != null || row.cost_usd != null) && (
                      <p className="mt-0.5 text-[0.65625rem] text-muted-foreground">
                        {[
                          row.model,
                          row.confidence != null ? `confidence ${row.confidence.toFixed(2)}` : null,
                          row.cost_usd != null ? money(row.cost_usd) : null,
                          row.observable ? `observable ${row.observable}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    )}
                    {alts.length ? (
                      <p className="mt-0.5 text-[0.65625rem] text-muted-foreground">
                        not taken:{' '}
                        {alts
                          .map((a) => (a.whyRejected ? `${a.action} (${a.whyRejected})` : a.action))
                          .join('; ')}
                      </p>
                    ) : null}
                    {row.status === 'unscorable' && row.evidence ? (
                      <p className="mt-0.5 text-[0.65625rem] text-warning">
                        no verdict: the evidence could not settle it
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
