/* ── Agent sandbox (Codex-like) ───────────────────────────────────────── */
/* Orthogonal to Plan/Ask/Full. Shows doctor backend capability.           */

import { useEffect, useState } from 'react';
import { Shield } from 'lucide-react';
import { workbenchClient } from '@/api/workbench/WorkbenchClient';
import {
  WORKBENCH_SANDBOX_MODES,
  type WorkbenchSandboxMode,
} from '@/components/chat/SandboxModeSelector';

type DoctorCheck = {
  id?: string;
  label?: string;
  ok?: boolean;
  detail?: string;
  backend?: string;
};

export function AgentSandboxSection() {
  const [backend, setBackend] = useState<string>('…');
  const [detail, setDetail] = useState('');
  const [networkDefault, setNetworkDefault] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void workbenchClient
      .doctor()
      .then((report) => {
        if (cancelled) return;
        const checks = (report as { checks?: DoctorCheck[] }).checks || [];
        const sandbox = checks.find((c) => c.id === 'sandbox');
        setBackend(String(sandbox?.backend || 'soft'));
        setDetail(String(sandbox?.detail || 'Soft policy enforcement'));
      })
      .catch(() => {
        if (!cancelled) {
          setBackend('unknown');
          setDetail('Could not load doctor report');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      setNetworkDefault(localStorage.getItem('august_sandbox_network_default') === '1');
    } catch {
      /* ignore */
    }
  }, []);

  const modes = Object.values(WORKBENCH_SANDBOX_MODES) as Array<{
    id: WorkbenchSandboxMode;
    label: string;
    description: string;
  }>;

  return (
    <div className="px-8 py-6 space-y-5" data-testid="agent-sandbox-section">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Shield className="size-5 text-primary" />
          Tool reach
        </h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          <strong className="font-medium text-foreground/90">Not agent mode.</strong> Agent mode
          (Ask / Edit / Plan / Full access) on the chat input answers “should August act?” Tool reach /
          sandbox answers “where can tools touch?” — by default only this project, with network off.
        </p>
      </div>

      <div className="rounded-xl border border-white/[0.08] bg-black/20 p-3 text-xs text-muted-foreground space-y-1.5 max-w-2xl">
        <div>
          <span className="text-foreground/90 font-medium">Agent mode</span> — approvals &amp; plans
          (composer chip next to +).
        </div>
        <div>
          <span className="text-foreground/90 font-medium">Tool reach</span> — machine boundary for
          shell/files (this page, or + menu → Tool reach).
        </div>
      </div>

      <div className="rounded-xl border border-white/[0.08] bg-black/30 p-3 text-sm space-y-1">
        <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
          Active backend
        </div>
        <div className="font-mono text-xs text-foreground" data-testid="sandbox-backend">
          {backend}
        </div>
        <p className="text-xs text-muted-foreground">{detail}</p>
        {backend === 'soft' && (
          <p className="text-xs text-warning/90 pt-1">
            Soft mode is not OS isolation. It forces workspace cwd, blocks network prefixes, and
            rejects out-of-workspace paths. Seatbelt / bwrap / AppContainer activate when available.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
          Modes
        </div>
        <ul className="space-y-2 text-sm">
          {modes.map((m) => (
            <li key={m.id} className="rounded-lg border border-white/[0.06] px-3 py-2">
              <div className="font-medium">{m.label}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{m.description}</div>
            </li>
          ))}
        </ul>
      </div>

      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="mt-1"
          checked={networkDefault}
          onChange={(e) => {
            const on = e.target.checked;
            setNetworkDefault(on);
            try {
              localStorage.setItem('august_sandbox_network_default', on ? '1' : '0');
            } catch {
              /* ignore */
            }
          }}
        />
        <span>
          <span className="font-medium">Prefer network on for new Workspace sessions</span>
          <span className="block text-xs text-muted-foreground mt-0.5">
            Default remains off (Codex-like). Turn on only if agents routinely need package installs
            / API calls inside workspace-write.
          </span>
        </span>
      </label>

      <p className="text-xs text-muted-foreground">
        Per-chat control lives on the composer sandbox chip. Sandbox denials can be approved Once /
        This chat / Always (unsandboxed retry). Revoke durable grants under Tool Grants.
      </p>
    </div>
  );
}

export default AgentSandboxSection;
