/* ── BranchChip ── current git branch selector in the composer footer ─── */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, GitBranch } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/api/client';

interface BranchEntry {
  name: string;
  current: boolean;
}

export function BranchChip({ workspacePath }: { workspacePath?: string | null }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const ws = workspacePath || '';

  useEffect(() => {
    if (!ws) {
      setCurrent(null);
      return;
    }
    api
      .get<{ current: string | null }>(`/api/git/branch?repoPath=${encodeURIComponent(ws)}`)
      .then((r) => setCurrent(r.current ?? null))
      .catch(() => setCurrent(null));
  }, [ws]);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const el = btnRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ top: Math.max(8, r.top - 260), left: Math.max(8, r.left) });
    }
    if (ws) {
      api
        .get<{ branches: BranchEntry[] }>(`/api/git/branches?repoPath=${encodeURIComponent(ws)}`)
        .then((r) => setBranches(r.branches ?? []))
        .catch(() => setBranches([]));
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ws]);

  if (!ws || !current) return null;

  const checkout = (name: string) => {
    setBusy(true);
    api
      .post<{ branch: string }>('/api/git/checkout', { repo_path: ws, branch: name })
      .then(() => {
        setCurrent(name);
        setOpen(false);
        toast.success(`Switched to ${name}`);
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Checkout failed'))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border bg-muted/40 text-muted-foreground border-border/50 hover:text-foreground cursor-pointer"
        title={`Current branch: ${current}`}
        aria-expanded={open}
      >
        <GitBranch className="size-3" />
        <span className="max-w-[120px] truncate font-mono">{current}</span>
        <ChevronDown className={cn('size-3 opacity-60 transition-transform', open && 'rotate-180')} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            data-composer-popover
            className="fixed z-50 w-64 max-h-60 overflow-y-auto rounded-xl border border-border/60 bg-popover shadow-2xl p-1.5 chat-scroll"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="px-2 py-1 text-[10px] uppercase font-semibold text-muted-foreground">
              Branches
            </div>
            {branches.length === 0 && (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">No branches found.</div>
            )}
            {branches.map((b) => (
              <button
                key={b.name}
                type="button"
                disabled={busy || b.current}
                onClick={() => checkout(b.name)}
                className={cn(
                  'w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs',
                  b.current
                    ? 'text-foreground bg-muted/60'
                    : 'text-foreground/80 hover:bg-muted cursor-pointer',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{b.name}</span>
                {b.current && <Check className="size-3.5 text-primary shrink-0" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
