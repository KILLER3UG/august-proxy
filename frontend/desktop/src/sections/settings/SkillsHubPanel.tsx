/* ── Skills hub — browse / install recipes ────────────────────────────── */

import { useEffect, useState } from 'react';
import { Download, Loader2, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/PageLoader';
import { toast } from 'sonner';
import { api } from '@/api/client';

export type HubEntry = {
  id: string;
  name: string;
  title: string;
  description: string;
  category: string;
  source: string;
  packagePath?: string;
};

type Props = {
  installedNames: Set<string>;
  onInstalled?: () => void;
};

export function SkillsHubPanel({ installedNames, onInstalled }: Props) {
  const [entries, setEntries] = useState<HubEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/workbench/skills/hub')
      .then((r) => r.json() as Promise<{ entries?: HubEntry[] }>)
      .then((data) => {
        if (!cancelled) setEntries(Array.isArray(data.entries) ? data.entries : []);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const install = async (entry: HubEntry) => {
    setBusy(entry.id);
    try {
      // Create a skill shell from hub metadata (body points users at the package path).
      await api.post('/api/skills', {
        name: entry.name,
        description: entry.description,
        body: `# ${entry.title}\n\n${entry.description}\n\n_Installed from Skills Hub (${entry.packagePath || entry.id})._\n\nEnable and edit instructions to match your workflow.`,
        trigger: entry.name,
        category: entry.category || 'uncategorized',
      });
      toast.success(`Installed ${entry.title}`);
      onInstalled?.();
    } catch (e) {
      toast.error(`Install failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="rounded-xl border border-white/[0.08] bg-black/20 p-4 space-y-3"
      data-testid="skills-hub-panel"
    >
      <div className="flex items-center gap-2">
        <Store className="size-4 text-primary" />
        <h3 className="text-sm font-semibold">Skills hub</h3>
        <span className="text-[10px] text-muted-foreground">Browse & install recipes</span>
      </div>

      {loading ? (
        <PageLoader label="Loading hub…" variant="card" className="px-0 py-2" />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {entries.map((e) => {
            const installed = installedNames.has(e.name);
            return (
              <li
                key={e.id}
                className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-card/30 p-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{e.title}</div>
                  <p className="text-[11px] text-muted-foreground line-clamp-2">{e.description}</p>
                  <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground/80">
                    {e.category} · {e.source}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={installed ? 'outline' : 'default'}
                  disabled={installed || busy === e.id}
                  onClick={() => {
                    void install(e);
                  }}
                  className="self-end"
                >
                  {busy === e.id ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Download className="size-3" />
                  )}
                  {installed ? 'Installed' : 'Install'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default SkillsHubPanel;
