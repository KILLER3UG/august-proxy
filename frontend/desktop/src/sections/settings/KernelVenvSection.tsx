/* ── Kernel venv — the write half of kernel venv discovery ────────────────── */
/* venv_python() has always DISCOVERED <ws>/.aug/kernel/venv, but nothing in the
 * backend ever created one. This is the one door that does: it creates the venv
 * from an interpreter >= 3.13 and pip-installs the seed set. Needed because
 * manimgx requires >= 3.13 while the desktop payload ships 3.12.9 — the app's
 * own interpreter cannot host it, and there is no reuse-the-bundled-python
 * shortcut.
 *
 * The pip network belongs to THIS action's consent (the user pressed the
 * button), which is a different thing from the per-session sandboxNetwork flag
 * — that one is the model-command default. The backend logs the grant. */

import { useState } from 'react';
import { Boxes, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { BackgroundTaskRegistry } from '@/store/background-tasks';
import { OsNotifyService } from '@/lib/os-notify';

type ProvisionResult = {
  ok: boolean;
  interpreter?: string;
  version?: string;
  venv?: string;
  python?: string;
  installed?: string[];
  log?: string;
  error?: string | null;
};

export function KernelVenvSection() {
  const [workspace, setWorkspace] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  const provision = async () => {
    setRunning(true);
    setResult(null);
    const taskId = `kernel_venv_${Date.now()}`;
    BackgroundTaskRegistry.enqueue({
      id: taskId,
      label: 'Kernel venv',
      status: 'running',
    });
    try {
      const data = await api.post<ProvisionResult>('/api/workbench/kernel/provision', {
        workspace: workspace.trim(),
      });
      setResult(data);
      if (data.ok) {
        BackgroundTaskRegistry.markDone(
          taskId,
          `python ${data.version ?? '?'} · ${(data.installed ?? []).length} packages`,
        );
        void OsNotifyService.notifyJobComplete('Kernel venv', 'Workspace kernel venv is ready');
      } else {
        BackgroundTaskRegistry.markError(taskId, data.error || 'failed');
      }
    } catch (e) {
      toast.error(`Provisioning failed: ${(e as Error).message}`);
      BackgroundTaskRegistry.markError(taskId, (e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="px-8 py-6 space-y-4" data-testid="kernel-venv-section">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Boxes className="size-5 text-primary" />
          Kernel venv
        </h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          A per-workspace Python environment for packages the app itself cannot ship. It is created
          from a Python 3.13+ interpreter found on this machine, then seeded with the common data
          packages — and it is the only place manimgx (the math-animation engine, which needs 3.13+
          while the bundled interpreter is 3.12) can live. Installing downloads packages with your
          consent from this button; that download grant is separate from any session&rsquo;s network
          setting, and the venv is per-user — never staged into a release.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          placeholder="Workspace path (the folder whose sessions share this venv)"
          className="min-w-[20rem] flex-1 rounded-md border border-border/60 bg-white/[0.06] px-2.5 py-1.5 font-mono text-xs"
        />
        <Button size="sm" onClick={() => void provision()} disabled={running || !workspace.trim()}>
          {running ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          Create venv &amp; install
        </Button>
      </div>

      {result && (
        <div className="space-y-2 rounded-xl border border-border/60 bg-black/30 p-3 text-xs font-mono">
          <div className={result.ok ? 'text-success-fg' : 'text-destructive'}>
            {result.ok ? 'Ready' : 'Error'}
            {result.version ? ` · python ${result.version}` : ''}
            {result.venv ? ` · ${result.venv}` : ''}
          </div>
          {result.error && <pre className="whitespace-pre-wrap text-destructive">{result.error}</pre>}
          {result.installed && result.installed.length > 0 && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-foreground/90">
              installed: {result.installed.join(' ')}
            </pre>
          )}
          {result.log && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-muted-foreground">
              {result.log.split('\n').slice(-8).join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default KernelVenvSection;
