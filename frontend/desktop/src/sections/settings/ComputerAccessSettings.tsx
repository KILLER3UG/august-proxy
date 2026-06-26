/* ── Computer Access — Filesystem scope + Computer-use app allowlist ── */
/* Task 8: surfaces the runtime security configuration that Task 1's
 * permission-profiles and Task 6's app-allowlist write to.
 *
 * Persists via:
 *   - /ui/august/settings/update     (security.allowedRoots, security.filesystemScope)
 *   - august__app_policy tool        (per-app allow/ask/deny)
 *
 * Locked decision 1: default scope is 'allowlist'. Setting scope to 'root'
 * widens host filesystem access — explicitly opt-in.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, FolderTree, Cpu, Camera, Eye } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAugustSnapshot,
  setAugustAppPolicy,
  listAugustAppPolicies,
  deleteAugustAppPolicy,
  putSecurity,
  getHostAgentHealth,
  type AugustSnapshot,
} from '@/api/api-client';
import { SettingsToggle } from '@/components/settings/SettingsToggle';

interface ComputerRoots {
  allowedRoots: string[];
  filesystemScope: 'allowlist' | 'root';
  postObservationScreenshot?: boolean;
}

interface AppPolicyMap {
  [app: string]: 'allow' | 'ask' | 'deny';
}

async function fetchComputerRoots(): Promise<ComputerRoots> {
  const snap = await getAugustSnapshot();
  const sec = snap.config?.security;
  return sec || { allowedRoots: [], filesystemScope: 'allowlist', postObservationScreenshot: true };
}

async function saveComputerRoots(next: Partial<ComputerRoots>): Promise<ComputerRoots> {
  // Persist via /ui/august/settings/update which writes security.* sub-keys.
  if (next.filesystemScope) {
    await setAugustSetting({ key_path: 'security.filesystemScope', value: next.filesystemScope });
  }
  if (next.allowedRoots) {
    await setAugustSetting({ key_path: 'security.allowedRoots', value: next.allowedRoots });
  }
  if (typeof next.postObservationScreenshot === 'boolean') {
    await setAugustSetting({ key_path: 'security.postObservationScreenshot', value: next.postObservationScreenshot });
  }
  return fetchComputerRoots();
}

async function setAugustSetting(payload: { key_path: string; value: unknown }): Promise<unknown> {
  const { updateAugustSetting } = await import('@/api/api-client');
  return updateAugustSetting(payload);
}

async function fetchAppPolicies(): Promise<AppPolicyMap> {
  const res = await listAugustAppPolicies();
  return res.policies || {};
}

export function ComputerAccessSettings() {
  const qc = useQueryClient();
  const rootsQuery = useQuery({ queryKey: ['computer-roots'], queryFn: fetchComputerRoots });
  const appsQuery = useQuery({ queryKey: ['computer-apps'], queryFn: fetchAppPolicies });

  const [newRoot, setNewRoot] = useState('');
  const [newApp, setNewApp] = useState('');
  const [newAppPolicy, setNewAppPolicy] = useState<'allow' | 'ask' | 'deny'>('ask');

  const saveMutation = useMutation({
    mutationFn: (next: Partial<ComputerRoots>) => saveComputerRoots(next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['computer-roots'] }),
  });
  const setPolicyMutation = useMutation({
    mutationFn: ({ app, policy }: { app: string; policy: 'allow' | 'ask' | 'deny' }) =>
      setAugustAppPolicy({ app, policy }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['computer-apps'] }),
  });
  const deletePolicyMutation = useMutation({
    mutationFn: (app: string) => deleteAugustAppPolicy(app),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['computer-apps'] }),
  });

  const roots = rootsQuery.data?.allowedRoots ?? [];
  const scope = rootsQuery.data?.filesystemScope ?? 'allowlist';
  const postObs = rootsQuery.data?.postObservationScreenshot !== false;
  const apps = appsQuery.data ?? {} as AppPolicyMap;

  const healthQuery = useQuery({ queryKey: ['host-agent', 'health'], queryFn: getHostAgentHealth, refetchInterval: 30_000 });
  const observationCount = healthQuery.data?.postObservationCount ?? 0;
  const lastObsAt = healthQuery.data?.lastObservationAt;

  const toggleMutation = useMutation({
    mutationFn: (next: boolean) => putSecurity({ postObservationScreenshot: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['computer-roots'] }),
  });

  function addRoot() {
    if (!newRoot.trim()) return;
    const next = Array.from(new Set([...roots, newRoot.trim()]));
    saveMutation.mutate({ allowedRoots: next });
    setNewRoot('');
  }

  function removeRoot(root: string) {
    saveMutation.mutate({ allowedRoots: roots.filter(r => r !== root) });
  }

  function addApp() {
    const trimmed = newApp.trim();
    if (!trimmed) return;
    setPolicyMutation.mutate({ app: trimmed, policy: newAppPolicy });
    setNewApp('');
  }

  function changeAppPolicy(app: string, policy: 'allow' | 'ask' | 'deny') {
    setPolicyMutation.mutate({ app, policy });
  }

  function removeApp(app: string) {
    deletePolicyMutation.mutate(app);
  }

  return (
    <div className="px-8 py-12 max-w-3xl space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Computer Access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Controls which directories August may read, write, or modify, and which
          desktop applications August may control through the host computer agent.
        </p>
      </header>

      {/* Computer Security — post-observation screenshots (Task 9) */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Camera className="size-4 text-foreground/70" />
          <h2 className="text-base font-medium">Computer security</h2>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">Capture post-observation screenshots</div>
              <p className="mt-1 text-xs text-muted-foreground">
                After every mutating computer_* action, August saves a screenshot
                to <code className="font-mono">data/computer-observations/</code> and
                links it to the audit entry. Disable to reduce disk usage.
              </p>
            </div>
            <SettingsToggle
              checked={postObs}
              onCheckedChange={(v) => toggleMutation.mutate(v)}
              label={postObs ? 'enabled' : 'disabled'}
            />
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.06] pt-3">
            <div className="text-xs text-muted-foreground">
              {observationCount === 0
                ? 'No observations captured yet.'
                : `${observationCount} observation${observationCount === 1 ? '' : 's'}`}
              {lastObsAt && ` · last ${new Date(lastObsAt).toLocaleString()}`}
            </div>
            <Link
              to="/settings/observability"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <Eye className="size-3.5" /> View observation gallery →
            </Link>
          </div>
        </div>
      </section>

      {/* Filesystem scope */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-foreground/70" />
          <h2 className="text-base font-medium">Filesystem scope</h2>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 space-y-3">
          <label className="flex items-center gap-3">
            <input
              type="radio"
              name="scope"
              value="allowlist"
              checked={scope === 'allowlist'}
              onChange={() => saveMutation.mutate({ filesystemScope: 'allowlist' })}
            />
            <div>
              <div className="font-medium">Allowlist (recommended)</div>
              <div className="text-xs text-muted-foreground">
                August may only read/write files inside the project working directory,
                August data dir, tmp, and the roots listed below.
              </div>
            </div>
          </label>
          <label className="flex items-center gap-3">
            <input
              type="radio"
              name="scope"
              value="root"
              checked={scope === 'root'}
              onChange={() => saveMutation.mutate({ filesystemScope: 'root' })}
            />
            <div>
              <div className="font-medium text-warning">Full machine (root)</div>
              <div className="text-xs text-muted-foreground">
                August may read/write any path on the host. Critical actions still
                require explicit confirmation. Use with care.
              </div>
            </div>
          </label>
        </div>
      </section>

      {/* Allowed roots */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <FolderTree className="size-4 text-foreground/70" />
          <h2 className="text-base font-medium">Allowed filesystem roots</h2>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 space-y-3">
          <ul className="space-y-1">
            {roots.length === 0 && (
              <li className="text-xs text-muted-foreground italic">
                No custom roots configured. Project cwd, August data dir, and tmp are always allowed.
              </li>
            )}
            {roots.map(r => (
              <li key={r} className="flex items-center justify-between text-sm">
                <code className="text-foreground/80">{r}</code>
                <button
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => removeRoot(r)}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newRoot}
              onChange={e => setNewRoot(e.target.value)}
              placeholder="C:\Users\me\Projects"
              className="flex-1 rounded-md border border-white/[0.08] bg-background/40 px-3 py-1.5 text-sm"
            />
            <button
              className="rounded-md bg-foreground/10 px-3 py-1.5 text-sm hover:bg-foreground/15"
              onClick={addRoot}
            >
              Add root
            </button>
          </div>
        </div>
      </section>

      {/* Computer-use app allowlist */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Cpu className="size-4 text-foreground/70" />
          <h2 className="text-base font-medium">Computer-use app policy</h2>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Per-app policy enforced at Workbench dispatch. Unknown apps default to
            <span className="font-medium"> ask</span>.
          </p>
          {Object.keys(apps).length === 0 && (
            <p className="text-xs text-muted-foreground italic">No app-specific policies yet.</p>
          )}
          <ul className="space-y-1">
            {Object.entries(apps).map(([app, policy]) => (
              <li key={app} className="flex items-center justify-between text-sm">
                <code className="text-foreground/80">{app}</code>
                <div className="flex items-center gap-2">
                  <select
                    value={policy}
                    onChange={(e) => changeAppPolicy(app, e.target.value as 'allow' | 'ask' | 'deny')}
                    className="rounded-md border border-white/[0.08] bg-background/40 px-2 py-0.5 text-xs"
                  >
                    <option value="allow">allow</option>
                    <option value="ask">ask</option>
                    <option value="deny">deny</option>
                  </select>
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => removeApp(app)}
                  >
                    remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newApp}
              onChange={e => setNewApp(e.target.value)}
              placeholder="notepad.exe"
              className="flex-1 rounded-md border border-white/[0.08] bg-background/40 px-3 py-1.5 text-sm"
            />
            <select
              value={newAppPolicy}
              onChange={e => setNewAppPolicy(e.target.value as 'allow' | 'ask' | 'deny')}
              className="rounded-md border border-white/[0.08] bg-background/40 px-2 py-1.5 text-sm"
            >
              <option value="allow">allow</option>
              <option value="ask">ask</option>
              <option value="deny">deny</option>
            </select>
            <button
              className="rounded-md bg-foreground/10 px-3 py-1.5 text-sm hover:bg-foreground/15"
              onClick={addApp}
            >
              Add app
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export default ComputerAccessSettings;
