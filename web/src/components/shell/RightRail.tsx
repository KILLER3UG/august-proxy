import { useState, type ReactNode } from 'react';
import { X, Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Resizable right-rail details pane. Used by Inspector (per-request details),
 * Workbench (per-message tool call preview), and any section that wants
 * side-by-side details. Mirrors Hermes Desktop's ChatPreviewRail pattern.
 */
export function RightRail({ title, subtitle, children, className }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(420);

  if (collapsed) {
    return (
      <aside className="w-9 border-l border-border bg-card flex flex-col items-center py-2">
        <Button variant="ghost" size="icon-sm" onClick={() => setCollapsed(false)} aria-label="Expand rail">
          <Maximize2 className="rotate-90" />
        </Button>
      </aside>
    );
  }

  return (
    <aside
      className={cn('border-l border-border bg-card flex flex-col shrink-0', className)}
      style={{ width }}
    >
      <header className="h-9 flex items-center justify-between border-b border-border px-3 shrink-0">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{title}</p>
          {subtitle && <p className="text-[12px] text-muted-foreground truncate">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button variant="ghost" size="icon-sm" onClick={() => setCollapsed(true)} aria-label="Collapse rail">
            <Minimize2 className="rotate-90" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close rail">
            <X />
          </Button>
        </div>
      </header>
      <div
        className="flex-1 overflow-auto p-3 resize-x min-w-[320px] max-w-[720px]"
        onMouseDown={(e) => {
          // simple drag-to-resize on the left edge
          if (e.target !== e.currentTarget) return;
          const startX = e.clientX;
          const startW = width;
          const onMove = (ev: MouseEvent) => {
            const delta = startX - ev.clientX;
            setWidth(Math.max(320, Math.min(720, startW + delta)));
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
      >
        {children}
      </div>
    </aside>
  );
}
