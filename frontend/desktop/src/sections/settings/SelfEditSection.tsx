/* ── Self-edit settings page ────────────────────────────────────────── */
/* The human side of the self-edit loop (Stages 1–5):
 *
 *  - the model edits its source only inside the user-local clone
 *    ({appData}/clone, created on the next backend start once the switch file
 *    {appData}/self-edit.enabled exists — this panel writes that switch);
 *  - every clone write through a file tool is journaled with its pre-edit
 *    bytes, and an uncommitted edit is undone at boot;
 *  - unattended runs cannot write the clone at all;
 *  - this panel is the apply door: it runs the gates and, only when they pass,
 *    restarts the backend so the clone's source takes over, then commits the
 *    journal markers once the restart comes back healthy.
 *
 * The restart is Tauri IPC (`restart_to_apply`) — deliberately NOT a model
 * tool; no register_all() entry exists for it and none may.
 *
 * What is stated here is what is enforced. The clone's push URL is locked to an
 * unroutable host when the clone is created, and git runs with an absolute
 * interpreter resolved before its working directory is set. A `git push` from
 * the terminal tool is a separate door: approval-gated, and approval can be
 * granted per workspace, so the claim "the model can never push" holds for the
 * clone's remote, not for every command it can type.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleDashed, RefreshCw, XCircle } from 'lucide-react';
import { isTauri } from '@/lib/tauri-detect';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface ApplyGate {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
}

interface ApplyResult {
  ok: boolean;
  restarted: boolean;
  healthy: boolean;
  gates: ApplyGate[];
  note: string;
  disclaimer: string;
}

interface SelfEditStatus {
  enabled: boolean;
  cloneRoot: string;
  cloneComplete: boolean;
  runningFromClone: boolean;
  liveBackend: string;
}

const SELF_EDIT_STATUS_KEY = ['self-edit-status'];

function GateIcon({ status }: { status: ApplyGate['status'] }) {
  if (status === 'pass') return <CheckCircle2 className="h-4 w-4 text-success-fg" />;
  if (status === 'fail') return <XCircle className="h-4 w-4 text-danger-fg" />;
  return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
}

export function SelfEditSection() {
  const [result, setResult] = useState<ApplyResult | null>(null);
  // Two clicks, deliberately: this button restarts the backend and makes the
  // model's uncommitted source the code August runs. A single click would make
  // it an action any frame in this window could take.
  const [armed, setArmed] = useState(false);

  const queryClient = useQueryClient();
  const status = useQuery<SelfEditStatus>({
    queryKey: SELF_EDIT_STATUS_KEY,
    enabled: isTauri,
    queryFn: () => invoke<SelfEditStatus>('self_edit_status'),
  });

  const toggle = useMutation({
    // The command returns the state the shell actually produced, so the panel
    // reports what happened rather than what was asked for.
    mutationFn: (next: boolean) => invoke<SelfEditStatus>('set_self_edit_enabled', { enabled: next }),
    onSuccess: (s) => {
      queryClient.setQueryData(SELF_EDIT_STATUS_KEY, s);
      setArmed(false);
      setResult(null);
    },
  });

  const apply = useMutation({
    mutationFn: () => invoke<ApplyResult>('restart_to_apply'),
    onSuccess: (res) => {
      setResult(res);
      setArmed(false);
      void status.refetch();
    },
    onSettled: () => setArmed(false),
  });

  const s = status.data;
  const blockedReason = !s
    ? 'the app could not report its state'
    : !s.enabled
      ? 'self-edit is off — turn the switch on, then restart August so the clone is created'
      : !s.cloneComplete
        ? 'the clone at ' + s.cloneRoot + ' is not a complete checkout'
        : !s.runningFromClone
          ? 'the clone is not the running tree — a restart would boot ' + s.liveBackend
          : '';

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div>
        <h3 className="text-sm font-medium">Self-edit loop</h3>
        <p className="text-xs text-muted-foreground mt-1">
          August edits its own source only inside the local clone
          (<code className="text-xs">{'{appData}'}/clone</code>). Writes are journaled with their
          pre-edit bytes, unattended runs are blocked from the clone, and the clone cannot be
          pushed to. This panel is the only way an edit becomes live.
        </p>
      </div>

      <div className="rounded-md border p-3 flex flex-col gap-2">
        <Row label="Switch">
          {s?.enabled ? <Badge variant="secondary">on</Badge> : <Badge variant="outline">off</Badge>}
        </Row>
        <Row label="Running from">
          {s ? (
            s.runningFromClone ? (
              <span className="text-xs">the self-edit clone</span>
            ) : (
              <span className="text-xs text-warning-fg">the installed runtime</span>
            )
          ) : (
            <span className="text-xs text-muted-foreground">unknown</span>
          )}
        </Row>
        <Row label="Clone">
          <code className="text-xs break-all">{s?.cloneRoot ?? '—'}</code>
        </Row>
        {s && !s.runningFromClone && (
          <p className="text-xs text-muted-foreground">
            The code executing now lives at <code className="text-xs break-all">{s.liveBackend}</code>{' '}
            — edits in the clone stay inert until this app boots from the clone.
          </p>
        )}
        <Button
          size="sm"
          variant={s?.enabled ? 'outline' : 'default'}
          disabled={!isTauri || toggle.isPending || !s}
          onClick={() => toggle.mutate(!s?.enabled)}
        >
          {s?.enabled ? 'Turn self-edit off' : 'Turn self-edit on'}
        </Button>
        {toggle.data && !toggle.data.enabled && (
          <p className="text-xs text-muted-foreground">
            Switch off. The clone and its journal are left in place; the next boot stops preferring it.
          </p>
        )}
        {toggle.isError && (
          <p className="text-xs text-danger-fg">{String(toggle.error)}</p>
        )}
      </div>

      <div className="flex flex-col items-start gap-2">
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant={armed ? 'destructive' : 'default'}
            disabled={!isTauri || apply.isPending || !!blockedReason}
            onClick={() => {
              if (!armed) {
                setArmed(true);
                return;
              }
              apply.mutate();
            }}
          >
            <RefreshCw className={'h-3.5 w-3.5 mr-1.5' + (apply.isPending ? ' animate-spin' : '')} />
            {apply.isPending ? 'Running gates…' : armed ? 'Confirm restart to apply' : 'Restart to apply'}
          </Button>
          {!isTauri && (
            <span className="text-xs text-muted-foreground">
              Available in the desktop app only (Tauri IPC — never a model tool).
            </span>
          )}
        </div>
        {armed && !apply.isPending && (
          <p className="text-xs text-warning-fg">
            Clicking again runs the gates and restarts the backend. Nothing happens until you do.
          </p>
        )}
        {status.isError && (
          <p className="text-xs text-danger-fg">
            The app could not read its own self-edit state: {String(status.error)}
          </p>
        )}
        {!isTauri || status.isError ? null : blockedReason && !armed ? (
          <p className="text-xs text-muted-foreground">Nothing to apply yet: {blockedReason}.</p>
        ) : null}
        {apply.isError && (
          <p className="text-xs text-danger-fg">
            The apply command itself failed — no gate ran: {String(apply.error)}
          </p>
        )}
      </div>

      {result && (
        <div className="rounded-md border p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            {result.ok ? (
              <Badge variant="default">applied</Badge>
            ) : (
              <Badge variant="destructive">not applied</Badge>
            )}
            <span className="text-xs text-muted-foreground">{result.note}</span>
          </div>
          {result.gates.map((g) => (
            <div key={g.name} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-xs">
                <GateIcon status={g.status} />
                <span className="font-medium">{g.name}</span>
                <Badge variant="outline" className="h-4 px-1 text-2xs">
                  {g.status}
                </Badge>
              </div>
              {g.detail && (
                <pre className="text-xs leading-4 text-muted-foreground whitespace-pre-wrap pl-6 max-h-40 overflow-auto">
                  {g.detail}
                </pre>
              )}
            </div>
          ))}
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground border-t pt-2">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>{result.disclaimer}</span>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Gates: per-file ruff on changed .py files and eslint on changed frontend files — either may
        report <span className="font-medium">skipped</span> with a stated reason when this install
        lacks that tool, which does not block. The load-bearing one is the smoke gate, which ships
        inside this app: it boots the edited backend against a throwaway data dir and re-checks the
        token doors, the tool-surface order and clone containment from a list the model cannot edit,
        and it fails if it cannot run.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground w-28 shrink-0">{label}</span>
      {children}
    </div>
  );
}
