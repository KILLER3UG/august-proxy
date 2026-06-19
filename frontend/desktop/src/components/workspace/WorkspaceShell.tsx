/* ── WorkspaceShell — settings-panel shell (chat-side) ───────────────── */
/* Mounted by SettingsPage inside ChatLayout. Renders the dark left rail */
/* + scrollable content area. Section nav clicks use `/settings/:id` — */
/* the Settings overlay route. The previous `/workspace/*` routes were     */
/* retired when Settings absorbed the panel.                                   */

import { type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { WorkspaceNavLink } from './WorkspaceNavLink';
import { cn } from '@/lib/utils';

export interface WorkspaceSectionMeta {
  id: string;
  label: string;
  icon: import('lucide-react').LucideIcon;
  /** Optional category label shown above the item. */
  category?: string;
}

interface WorkspaceShellProps {
  sections: WorkspaceSectionMeta[];
  active: string;
  children: ReactNode;
  className?: string;
}

export function WorkspaceShell({
  sections,
  active,
  children,
  className,
}: WorkspaceShellProps) {
  const navigate = useNavigate();

  // Group sections by category while preserving order.
  const grouped = new Map<string, WorkspaceSectionMeta[]>();
  for (const s of sections) {
    const k = s.category ?? '';
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(s);
  }

  return (
    <div className={cn('flex h-full min-h-0', className)}>
      {/* Left rail */}
      <aside className="w-64 shrink-0 border-r border-white/[0.06] bg-[#0f0f12] flex flex-col">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground hover:text-foreground transition text-left"
        >
          <ArrowLeft className="size-4" />
          Back to workspace
        </button>
        <nav className="flex-1 overflow-y-auto py-1">
          {Array.from(grouped.entries()).map(([category, items]) => (
            <div key={category || 'default'} className="mb-1">
              {category && (
                <p className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-widest text-muted-foreground/50 font-semibold">
                  {category}
                </p>
              )}
              {items.map((s) => (
                <WorkspaceNavLink
                  key={s.id}
                  icon={s.icon}
                  label={s.label}
                  active={active === s.id}
                  onSelect={() => navigate(`/settings/${s.id}`)}
                />
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* Main content — each section renders its own h1 inside */}
      <div className="flex-1 min-w-0 overflow-auto">{children}</div>
    </div>
  );
}

