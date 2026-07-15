/* ── Sandbox Python cell ──────────────────────────────────────────────── */
/* Strict cwd / no-network / banned imports — educational safe exec.      */

import { useState } from 'react';
import { Code2, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { BackgroundTaskRegistry } from '@/store/background-tasks';
import { OsNotifyService } from '@/lib/os-notify';

type SandboxResult = {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string | null;
  cwd?: string;
  elapsedMs?: number;
  policy?: { network?: boolean; timeoutMs?: number };
};

export function PythonSandboxSection() {
  const [code, setCode] = useState(
    '# Safe subset: math, json, re + builtins\nprint(sum(range(10)))\nprint(math.sqrt(16))\n',
  );
  const [cwd, setCwd] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SandboxResult | null>(null);

  const run = async () => {
    setRunning(true);
    setResult(null);
    const taskId = `sandbox_${Date.now()}`;
    BackgroundTaskRegistry.enqueue({
      id: taskId,
      label: 'Python sandbox',
      status: 'running',
    });
    try {
      const res = await fetch('/api/workbench/sandbox/python', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          cwd: cwd.trim() || undefined,
          timeoutMs: 3000,
        }),
      });
      const data = (await res.json()) as SandboxResult;
      if (!res.ok) throw new Error((data as { detail?: string }).detail || `HTTP ${res.status}`);
      setResult(data);
      if (data.ok) {
        BackgroundTaskRegistry.markDone(taskId, `ok in ${data.elapsedMs ?? '?'}ms`);
        void OsNotifyService.notifyJobComplete('Python sandbox', 'Cell finished successfully');
      } else {
        BackgroundTaskRegistry.markError(taskId, data.error || 'failed');
      }
    } catch (e) {
      toast.error(`Sandbox failed: ${(e as Error).message}`);
      BackgroundTaskRegistry.markError(taskId, (e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="px-8 py-6 space-y-4" data-testid="python-sandbox-section">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Code2 className="size-5 text-primary" />
          Python sandbox
        </h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          Optional “Run Python” cell with no network, no subprocess, banned imports, and a short
          timeout. Use for quick calculations — not full project automation.
        </p>
      </div>

      <textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        rows={12}
        spellCheck={false}
        className="w-full rounded-xl border border-white/[0.08] bg-black/40 p-3 font-mono text-xs text-foreground focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
      />

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="Optional cwd (must exist)"
          className="min-w-[16rem] flex-1 rounded-md border border-white/[0.08] bg-white/[0.06] px-2.5 py-1.5 font-mono text-xs"
        />
        <Button size="sm" onClick={() => void run()} disabled={running || !code.trim()}>
          {running ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          Run
        </Button>
      </div>

      {result && (
        <div className="space-y-2 rounded-xl border border-white/[0.08] bg-black/30 p-3 text-xs font-mono">
          <div className={result.ok ? 'text-emerald-400' : 'text-destructive'}>
            {result.ok ? 'OK' : 'Error'}
            {result.elapsedMs != null ? ` · ${result.elapsedMs}ms` : ''}
            {result.cwd ? ` · cwd ${result.cwd}` : ''}
          </div>
          {result.error && <pre className="whitespace-pre-wrap text-destructive">{result.error}</pre>}
          {result.stdout && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-foreground/90">
              {result.stdout}
            </pre>
          )}
          {result.stderr && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-warning">
              {result.stderr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default PythonSandboxSection;
