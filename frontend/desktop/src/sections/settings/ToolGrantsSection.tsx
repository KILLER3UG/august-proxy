/* ── Path-scoped always-grants Settings UI ────────────────────────────── */
/* List always-grants by workspace, revoke, explain why tools are allowed. */

import { useCallback, useEffect, useState } from 'react';
import { FolderLock, Loader2, ShieldOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/PageLoader';
import { toast } from 'sonner';

type Grant = { key: string; tool: string; path: string };
type WorkspaceGrants = { workspacePath: string; grants: Grant[] };

export function ToolGrantsSection() {
  const [rows, setRows] = useState<WorkspaceGrants[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/workbench/tool-grants');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { workspaces?: WorkspaceGrants[] };
      setRows(Array.isArray(data.workspaces) ? data.workspaces : []);
    } catch (e) {
      toast.error(`Could not load grants: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (workspacePath: string, key: string) => {
    setBusyKey(key);
    try {
      const res = await fetch('/api/workbench/tool-grants', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath, key }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { workspaces?: WorkspaceGrants[] };
      setRows(Array.isArray(data.workspaces) ? data.workspaces : []);
      toast.success('Grant revoked');
    } catch (e) {
      toast.error(`Revoke failed: ${(e as Error).message}`);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="px-8 py-6 space-y-4" data-testid="tool-grants-section">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <FolderLock className="size-5 text-primary" />
          Path-scoped permissions
        </h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          When you choose <strong>Always here</strong> on a tool approval, August remembers
          that tool+path for the workspace folder. Revoke any entry to require approval again.
        </p>
      </div>

      {loading ? (
        <PageLoader label="Loading grants…" className="px-0 py-2" />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/[0.08] p-6 text-sm text-muted-foreground">
          No always-grants yet. Approve a mutating tool with “Always here” while in Ask mode.
        </div>
      ) : (
        <div className="space-y-4">
          {rows.map((ws) => (
            <div
              key={ws.workspacePath}
              className="rounded-xl border border-white/[0.08] bg-black/20 overflow-hidden"
            >
              <div className="border-b border-white/[0.06] px-3 py-2 text-xs font-mono text-muted-foreground truncate">
                {ws.workspacePath}
              </div>
              <ul className="divide-y divide-white/[0.04]">
                {ws.grants.map((g) => (
                  <li
                    key={g.key}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                    title={`Why allowed: always grant for ${g.tool} on ${g.path}`}
                  >
                    <ShieldOff className="size-3.5 shrink-0 text-warning" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{g.tool}</div>
                      <div className="text-[11px] text-muted-foreground truncate font-mono">
                        {g.path}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px] text-destructive hover:text-destructive"
                      disabled={busyKey === g.key}
                      onClick={() => {
                        void revoke(ws.workspacePath, g.key);
                      }}
                    >
                      {busyKey === g.key ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Trash2 className="size-3" />
                      )}
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <Button size="sm" variant="outline" onClick={() => void load()}>
        Refresh
      </Button>
    </div>
  );
}

export default ToolGrantsSection;
