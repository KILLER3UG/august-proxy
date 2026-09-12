/* ── Skill packs — install-from-remote for skill folders ─────────────── */
/* Mirrors the plugin-cache idea from ZCode's marketplace, scoped to       */
/* skills: install a pack (GitHub owner/repo[/subdir][@ref] or an https    */
/* .zip URL), see what's installed, remove it. Backed by                   */
/* /api/skills/packs (app/routers/skill_packs.py).                        */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Package, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';

interface PackInfo {
  pack: string;
  source: string;
  rev: string;
  skills: string[];
  installedAt: number;
}

export function SkillPacksPanel() {
  const queryClient = useQueryClient();
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);

  const packsQ = useQuery<{ packs: PackInfo[] }>({
    queryKey: ['skill-packs'],
    queryFn: () => api.get<{ packs: PackInfo[] }>('/api/skills/packs'),
  });
  const packs = packsQ.data?.packs ?? [];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['skill-packs'] });
    void queryClient.invalidateQueries({ queryKey: ['skills-list'] });
  };

  const install = async () => {
    const s = source.trim();
    if (!s) return;
    setBusy(true);
    try {
      const r = await api.post<{
        ok: boolean;
        pack?: string;
        skills?: string[];
        refused?: string[];
        error?: string;
      }>('/api/skills/packs', { source: s });
      if (r.ok) {
        toast.success(`Installed ${r.pack} — ${(r.skills ?? []).length} skill(s)${r.refused?.length ? ` · ${r.refused.length} refused` : ''}`);
        setSource('');
      } else {
        toast.error(r.error ?? 'install failed');
      }
      if (r.refused?.length) toast.info(r.refused[0]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const uninstall = async (pack: string) => {
    try {
      await api.delete(`/api/skills/packs/${encodeURIComponent(pack)}`);
      toast.success(`Removed ${pack}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      refresh();
    }
  };

  return (
    <div
      className="shrink-0 rounded-xl border border-white/[0.06] bg-card/60 p-3 space-y-2"
      data-testid="skill-packs-panel"
    >
      <div className="flex items-center gap-2">
        <Package className="size-3.5 text-muted-foreground/70" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Skill packs
        </span>
        <span className="text-[10.5px] text-muted-foreground/70">
          install skill folders from a GitHub repo or an https zip
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void install();
          }}
          placeholder="owner/repo, owner/repo/skills/@v2, or https://example/pack.zip"
          aria-label="Skill pack source"
          data-testid="skill-pack-source"
          className="h-8 min-w-0 flex-1 rounded-lg border border-border/60 bg-muted/40 px-3 text-xs placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
        />
        <Button size="sm" variant="outline" onClick={() => void install()} disabled={busy || !source.trim()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          Install
        </Button>
      </div>
      {packs.length > 0 && (
        <ul className="space-y-1" data-testid="skill-packs-list">
          {packs.map((p) => (
            <li key={p.pack} className="flex items-center justify-between gap-2 rounded-lg bg-muted/30 px-2.5 py-1.5">
              <div className="min-w-0">
                <span className="text-xs font-medium text-foreground">{p.pack}</span>
                <span className="ml-2 text-[10.5px] text-muted-foreground/80">
                  {p.source} · {p.skills.length} skill{p.skills.length === 1 ? '' : 's'} · {p.skills.slice(0, 4).join(', ')}
                  {p.skills.length > 4 ? '…' : ''}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 text-destructive hover:bg-destructive/10"
                onClick={() => void uninstall(p.pack)}
                aria-label={`Uninstall ${p.pack}`}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
