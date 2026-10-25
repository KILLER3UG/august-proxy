/* ── Goals — the environment the agent works inside ──────────────────── */
/* One row per goal, with the runs that carry it, the outputs it filed and the claims it has
 * not yet proved. This is the READ side: the agent edits its goal mid-task with `goal_edit`,
 * so this page never offers create/edit — a second writer would race the optimistic lock the
 * store enforces. The two buttons are the user's: stop a goal, close a run.
 *
 * The movement ledger is why this page exists at all: a refused write is a row beside the
 * successes, and without a surface it would only ever be visible to the next model turn. */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  abandonGoal,
  closeRun,
  listGoals,
  type GoalArtifactRow,
  type GoalEnv,
  type GoalMarkRow,
  type GoalsSnapshot,
} from '../../api/api-client/goals';
import { getCurrentWorkspace } from '../../store/workspaces';

const STATUS_TONE: Record<string, string> = {
  active: 'text-info-fg',
  running: 'text-info-fg',
  done: 'text-success-fg',
  failed: 'text-danger-fg',
  abandoned: 'text-danger-fg',
  parked: 'text-warning-fg',
  woken: 'text-warning-fg',
};

const when = (ms: number): string => (Number.isFinite(ms) && ms > 0 ? new Date(ms * 1000).toLocaleString() : '—');

function Group({ title, hint, children, testId }: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section className="mt-6" data-testid={testId}>
      <div className="border-b border-border/60 pb-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[0.9375rem] font-semibold tracking-tight text-foreground">{title}</h3>
          {hint && <span className="text-2xs tabular-nums text-muted-foreground/60">{hint}</span>}
        </div>
      </div>
      {children}
    </section>
  );
}

const BoundLine: React.FC<{ env: GoalEnv }> = ({ env }) => (
  <p className="mt-1 text-2xs text-muted-foreground/70">
    rounds {env.bound.maxRounds >= 1_000_000 ? 'uncapped' : env.bound.maxRounds}
    {' · '}tools {env.bound.allow.length}
    {env.bound.deny.length > 0 ? ` · refused here ${env.bound.deny.join(', ')}` : ''}
    {env.inputs.length > 0 ? ` · reads ${env.inputs.join(', ')}` : ''}
  </p>
);

const ArtifactRow: React.FC<{ art: GoalArtifactRow }> = ({ art }) => {
  const last = art.movements.length ? art.movements[art.movements.length - 1] : null;
  const ref = useMemo(() => {
    try {
      const parsed = JSON.parse(art.ref) as { store?: string; key?: string };
      return `${parsed.store ?? '?'}/${parsed.key ?? '?'}`;
    } catch {
      return art.ref;
    }
  }, [art.ref]);
  return (
    <li className="border-b border-border/40 py-1.5 text-xs" data-testid={`goal-artifact-${art.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-foreground">{art.summary}</span>
        <span className="text-2xs text-muted-foreground/60">{ref}</span>
      </div>
      {last && (
        <p className={`mt-0.5 text-2xs ${last.ok ? 'text-muted-foreground/60' : 'text-danger-fg'}`}>
          {when(last.at)} {last.actor}: {last.ok ? 'moved' : 'REFUSED'} — {last.reason}
          {art.movements.length > 1 ? ` (${art.movements.length} moves)` : ''}
        </p>
      )}
    </li>
  );
};

export const GoalsSection: React.FC = () => {
  // A goal belongs to a PROJECT. The panel asks for the one the app is in, so another
  // project's work never appears here — and when no project is open it says so instead of
  // quietly showing everything.
  const project = getCurrentWorkspace();
  const projectPath = project?.path ?? '';
  const [snap, setSnap] = useState<GoalsSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    try {
      setSnap(await listGoals(projectPath || undefined));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the goals.');
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await run();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That action failed.');
    } finally {
      setBusy('');
    }
  }, [refresh]);

  if (error && !snap) {
    return <p className="mt-6 text-xs text-danger-fg" data-testid="goals-error">{error}</p>;
  }
  if (!snap) {
    return <p className="mt-6 text-xs text-muted-foreground/60" data-testid="goals-loading">Reading goals…</p>;
  }
  if (snap.envs.length === 0) {
    return (
      <p className="mt-6 text-xs text-muted-foreground/70" data-testid="goals-empty">
        No goals yet. The agent opens one with <span className="font-mono">goal_edit</span> when a task is worth
        tracking; this page then shows what it is working toward, what it filed, and what it has only claimed.
      </p>
    );
  }

  const marksByClaim = new Map<string, GoalMarkRow>(snap.marks.map(m => [m.claim_id, m]));
  const active = snap.envs.filter(e => e.status === 'active').length;

  return (
    <div data-testid="goals-section">
      <p className="mt-2 text-2xs text-muted-foreground/60" data-testid="goals-scope">
        {projectPath ? `showing this project — ${project?.name ?? projectPath}` : 'no project open — showing every project'}
      </p>
      <Group title="Goals" hint={`${active} active of ${snap.envs.length}`} testId="goals-list">
        <ul>
          {snap.envs.map(env => {
            const runs = snap.runs.filter(r => r.envId === env.id);
            const arts = snap.artifacts.filter(a => a.env_id === env.id);
            const openRun = runs.find(r => r.status === 'running' || r.status === 'woken' || r.status === 'parked');
            return (
              <li key={env.id} className="border-b border-border/40 py-3" data-testid={`goal-${env.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-2">
                    <span className={`text-2xs uppercase tracking-wide ${STATUS_TONE[env.status] ?? 'text-muted-foreground'}`}>
                      {env.status}
                    </span>
                    <span className="text-sm font-medium text-foreground">{env.title}</span>
                    <span className="text-2xs text-muted-foreground/50">{env.id}</span>
                  </div>
                  {!env.readOnly && env.status === 'active' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto px-0 py-0 text-2xs font-normal text-muted-foreground hover:text-danger-fg"
                      disabled={busy === env.id}
                      onClick={() => void act(env.id, () => abandonGoal(env.id))}
                      data-testid={`goal-stop-${env.id}`}
                    >
                      stop
                    </Button>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground/80">{env.goal}</p>
                <BoundLine env={env} />
                {env.readOnly && <p className="mt-1 text-2xs text-muted-foreground/50">the app's own environment — read-only to the agent</p>}
                {openRun && (
                  <div className="mt-1 flex items-baseline gap-2 text-2xs text-muted-foreground/70" data-testid={`goal-run-${openRun.id}`}>
                    <span className={`${STATUS_TONE[openRun.status] ?? ''}`}>{openRun.status}</span>
                    <span>
                      {openRun.id} · round {openRun.round}
                      {openRun.model ? ` · ${openRun.model}` : ''}
                      {openRun.reason ? ` — ${openRun.reason}` : ''}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto px-0 py-0 text-2xs font-normal text-muted-foreground hover:text-foreground"
                      disabled={busy === openRun.id}
                      onClick={() => void act(openRun.id, () => closeRun(openRun.id))}
                      data-testid={`goal-close-run-${openRun.id}`}
                    >
                      close run
                    </Button>
                  </div>
                )}
                {env.outputs.length > 0 && (
                  <p className="mt-1 text-2xs text-muted-foreground/60">
                    outputs owed: {env.outputs.filter(o => !arts.some(a => `${a.summary}`.toLowerCase().includes(o.toLowerCase()))).join('; ') || 'none — all filed'}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </Group>

      <Group title="Filed outputs" hint={`${snap.artifacts.length}`} testId="goals-artifacts">
        {snap.artifacts.length === 0
          ? <p className="py-2 text-xs text-muted-foreground/60">Nothing filed yet. An output is what lets a goal close as done.</p>
          : <ul>{snap.artifacts.slice(-30).reverse().map(a => <ArtifactRow key={a.id} art={a} />)}</ul>}
      </Group>

      <Group title="Claims and verdicts" hint={`${snap.claims.length} claims · ${snap.marks.length} marks`} testId="goals-verdicts">
        {snap.claims.length === 0
          ? <p className="py-2 text-xs text-muted-foreground/60">No claims. A claim is not a finding — only a mark with an evidence row is.</p>
          : (
            <ul>
              {snap.claims.slice(-30).reverse().map(c => {
                const mark = marksByClaim.get(c.id);
                return (
                  <li key={c.id} className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1.5 text-xs" data-testid={`goal-claim-${c.id}`}>
                    <span className="text-foreground/90">{c.text}</span>
                    <span className={`shrink-0 text-2xs ${mark ? (mark.verdict === 'confirmed' ? 'text-success-fg' : mark.verdict === 'refuted' ? 'text-danger-fg' : 'text-warning-fg') : 'text-muted-foreground/50'}`}>
                      {mark ? mark.verdict : 'no verdict yet'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
      </Group>
      {error && <p className="mt-3 text-2xs text-danger-fg">{error}</p>}
    </div>
  );
};
