/**
 * PlansSection — Settings ▸ Plans & Todos.
 *
 * Lists the `.aug` plan/todo artifacts left in the active workspace. These
 * are normally auto-deleted when a session is reset/rejected/deleted; this
 * view is a rescue surface for any artifact not cleaned up (e.g. left behind
 * by an error). The user can manually delete survivors here.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  ClipboardList,
  Trash2,
  RefreshCw,
  FolderOpen,
} from 'lucide-react';
import { api } from '@/api/client';
import { PageLoader } from '@/components/PageLoader';
import { getCurrentWorkspace } from '@/store/workspaces';

interface AugArtifact {
  kind: string;
  slug: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  path: string;
}

export function PlansSection() {
  const [artifacts, setArtifacts] = useState<AugArtifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const workspace = getCurrentWorkspace();
  const workspacePath = workspace?.path || '';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ artifacts: AugArtifact[] }>(
        '/api/aug/plans' + (workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : ''),
      );
      setArtifacts(res.artifacts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load plans');
    } finally {
      setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    void load();
  }, [load]);

  async function doDelete(artifact: AugArtifact) {
    setConfirming(null);
    try {
      await api.delete(
        `/api/aug/plans/${encodeURIComponent(artifact.kind)}/${encodeURIComponent(artifact.slug)}` +
          (workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : ''),
      );
      setArtifacts(prev => prev.filter(a => a.slug !== artifact.slug || a.kind !== artifact.kind));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Artifacts</h1>
          <p className="text-sm text-zinc-400">
            {workspace
              ? `Workspace plans & todos · ${workspace.name}`
              : 'No active workspace — showing project-root .aug artifacts.'}
          </p>
        </div>
        <button
          onClick={() => { void load(); }}
          disabled={loading}
          className="flex items-center gap-1 rounded bg-zinc-700 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-600 disabled:opacity-50"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <p className="text-xs text-zinc-500">
        Model-generated plans and todo lists are saved to <code>.aug/</code> in your
        workspace and normally removed when a session ends. This list shows any
        survivors so you can clean them up manually.
      </p>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      {loading ? (
        <PageLoader label="Loading plans…" className="px-0 py-2" />
      ) : artifacts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-zinc-700 py-12 text-zinc-500">
          <ClipboardList size={28} />
          <p className="text-sm">No .aug artifacts. Nothing to clean up.</p>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {artifacts.map(a => (
            <li key={`${a.kind}/${a.slug}`} className="flex items-center justify-between p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={
                      'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ' +
                      (a.kind === 'plans'
                        ? 'bg-sky-500/15 text-sky-300'
                        : 'bg-violet-500/15 text-violet-300')
                    }
                  >
                    {a.kind === 'plans' ? 'Plan' : 'Todo'}
                  </span>
                  <span className="truncate font-medium text-zinc-100">{a.title}</span>
                  <span className="text-[10px] text-zinc-500">{a.status}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-zinc-500">{a.path}</p>
              </div>
              <div className="flex items-center gap-2">
                {confirming === `${a.kind}/${a.slug}` ? (
                  <>
                    <button
                      onClick={() => { void doDelete(a); }}
                      className="rounded bg-rose-600 px-2 py-1 text-xs text-white hover:bg-rose-500"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirming(null)}
                      className="rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirming(`${a.kind}/${a.slug}`)}
                    className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-rose-300"
                    aria-label="Delete artifact"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!workspace && (
        <p className="flex items-center gap-1 text-xs text-zinc-600">
          <FolderOpen size={12} /> Select a workspace to scope this list to a project.
        </p>
      )}
    </div>
  );
}

export default PlansSection;
