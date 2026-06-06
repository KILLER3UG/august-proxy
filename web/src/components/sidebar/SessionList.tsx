/* ── Session list — the actual sidebar from the screenshot ─────────── */
/* Top:   New session (⌘N) + Skills & Tools + Messaging + Artifacts         */
/* Middle: search, PINNED, SESSIONS (count)                                */
/* Bottom: ⌂ + ⚙ ⏵ ⟳ + status                                  */

import { useState } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { Plus, Search, Pin, MessageSquare, Wrench, Package, Home, MoreHorizontal, Settings, Columns } from 'lucide-react';
import { cn } from '@/lib/utils';
import { mockSessions, type Session } from '@/lib/mock';
import { fadeUp, stagger, hoverScale } from '@/lib/motion';

const SESSIONS_KEY = 'august-pinned-sessions';
const STORAGE = (() => {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]') as string[]; }
  catch { return []; }
})();

interface Props {
  activeId?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (s: Session) => void;
  onNew: () => void;
  onNavigate: (path: string) => void;
}

export function SessionList({ activeId, collapsed, onToggleCollapsed, onSelect, onNew, onNavigate }: Props) {
  const [filter, setFilter] = useState('');
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set(STORAGE));

  const visible = mockSessions.filter((s) => !filter || s.title.toLowerCase().includes(filter.toLowerCase()));
  const pinned  = visible.filter((s) => pinnedIds.has(s.id));
  const others  = visible.filter((s) => !pinnedIds.has(s.id));

  const togglePin = (id: string) => {
    const next = new Set(pinnedIds);
    next.has(id) ? next.delete(id) : next.add(id);
    setPinnedIds(next);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([...next]));
  };

  return (
    <div className="flex h-full text-xs relative select-none bg-sidebar">
      {/* Absolute positioned divider line between narrow rail and second column */}
      {!collapsed && (
        <div className="absolute left-12 top-0 bottom-0 w-[1px] bg-sidebar-border/30" />
      )}

      {/* Left Column: Narrow Navigation Rail (always w-12 / 48px) */}
      <div className="w-12 shrink-0 flex flex-col justify-between py-2.5 bg-[#09090b]">
        {/* Top group */}
        <div className="flex flex-col items-center gap-3 w-full">
          {/* Toggle button */}
          <button
            onClick={onToggleCollapsed}
            className="p-1.5 hover:bg-sidebar-accent/50 rounded-md text-muted-foreground hover:text-foreground transition"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <Columns className="size-4" />
          </button>

          {/* Nav Icons */}
          <button
            onClick={onNew}
            className={cn(
              "p-1.5 hover:bg-sidebar-accent/50 rounded-md transition",
              !activeId ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            title="New session"
          >
            <Plus className="size-4" />
          </button>
          <button
            onClick={() => onNavigate('/settings?tab=mcp')}
            className="p-1.5 hover:bg-sidebar-accent/50 rounded-md text-muted-foreground hover:text-foreground transition"
            title="Skills & Tools"
          >
            <Wrench className="size-4" />
          </button>
          <button
            onClick={() => onNavigate('/settings?tab=services')}
            className="p-1.5 hover:bg-sidebar-accent/50 rounded-md text-muted-foreground hover:text-foreground transition"
            title="Messaging"
          >
            <MessageSquare className="size-4" />
          </button>
          <button
            onClick={() => onNavigate('/dashboard')}
            className="p-1.5 hover:bg-sidebar-accent/50 rounded-md text-muted-foreground hover:text-foreground transition"
            title="Artifacts"
          >
            <Package className="size-4" />
          </button>
        </div>

        {/* Bottom group */}
        <div className="flex flex-col items-center gap-2 mb-1 w-full">
          <button
            onClick={() => onNavigate('/')}
            className="p-1.5 hover:bg-sidebar-accent/50 rounded-md text-muted-foreground hover:text-foreground transition"
            title="Home"
          >
            <Home className="size-4" />
          </button>
          <button
            onClick={onNew}
            className="p-1.5 hover:bg-sidebar-accent/50 rounded-md text-muted-foreground hover:text-foreground transition"
            title="New"
          >
            <Plus className="size-4" />
          </button>
          <button
            onClick={() => onNavigate('/settings')}
            className="p-1.5 hover:bg-sidebar-accent/50 rounded-md text-muted-foreground hover:text-foreground transition"
            title="Settings"
          >
            <Settings className="size-4" />
          </button>
        </div>
      </div>

      {/* Right Column: Expanded Panel (visible only when not collapsed, flex-1) */}
      {!collapsed && (
        <motion.div
          key="expanded-panel"
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{    opacity: 0, x: -4 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="flex-1 flex flex-col min-w-0 bg-[#0e0e11] text-xs"
        >
          {/* Nav labels */}
          <div className="py-2.5 px-2 border-b border-sidebar-border/30 flex flex-col gap-0.5">
            <button
              onClick={onNew}
              className="w-full flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sidebar-foreground/80 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground transition"
            >
              <span>New session</span>
              <kbd className="text-[9px] text-muted-foreground font-mono bg-muted/20 px-1 py-0.5 rounded border border-border/20">ctrl N</kbd>
            </button>
            <button
              onClick={() => onNavigate('/settings?tab=mcp')}
              className="w-full text-left rounded-md px-2.5 py-1.5 text-sidebar-foreground/80 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground transition"
            >
              Skills & Tools
            </button>
            <button
              onClick={() => onNavigate('/settings?tab=services')}
              className="w-full text-left rounded-md px-2.5 py-1.5 text-sidebar-foreground/80 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground transition"
            >
              Messaging
            </button>
            <button
              onClick={() => onNavigate('/dashboard')}
              className="w-full text-left rounded-md px-2.5 py-1.5 text-sidebar-foreground/80 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground transition"
            >
              Artifacts
            </button>
          </div>

          {/* Search input */}
          <div className="px-2 py-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search sessions..."
                className="w-full pl-8 pr-2 py-1 text-[11px] bg-secondary/30 rounded-md border border-transparent focus:border-border/50 focus:bg-background outline-none transition text-sidebar-foreground placeholder:text-muted-foreground"
              />
            </div>
          </div>

          {/* Scrollable sessions area */}
          <motion.div
            variants={stagger(0.025, 0.05)}
            initial="initial"
            animate="animate"
            className="flex-1 overflow-y-auto px-2 pb-2 space-y-4"
          >
            <Section
              title="PINNED"
              count={pinned.length}
              empty="Shift-click a chat to pin - drag to reorder"
            >
              <LayoutGroup id="pinned-sessions">
                <AnimatePresence initial={false}>
                  {pinned.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={activeId === s.id}
                      pinned
                      onClick={() => onSelect(s)}
                      onTogglePin={() => togglePin(s.id)}
                    />
                  ))}
                </AnimatePresence>
              </LayoutGroup>
            </Section>

            <Section title="SESSIONS" count={others.length}>
              <LayoutGroup id="all-sessions">
                <AnimatePresence initial={false}>
                  {others.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={activeId === s.id}
                      pinned={false}
                      onClick={() => onSelect(s)}
                      onTogglePin={() => togglePin(s.id)}
                    />
                  ))}
                </AnimatePresence>
              </LayoutGroup>
            </Section>
          </motion.div>
        </motion.div>
      )}
    </div>
  );
}

function Section({ title, count, empty, children }: { title: string; count: number; empty?: string; children?: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 px-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[9px] uppercase tracking-wider text-muted-foreground/75 font-semibold">{title}</h3>
          <span className="text-[9px] text-muted-foreground/50 font-mono">{count}</span>
        </div>
        {title === 'SESSIONS' && (
          <button className="text-muted-foreground/50 hover:text-foreground">
            <Columns className="size-2.5" />
          </button>
        )}
      </div>
      {count === 0
        ? <p className="px-2 py-1 text-[10px] text-muted-foreground/50 italic">{empty ?? 'No items'}</p>
        : <div className="space-y-0.5">{children}</div>
      }
    </div>
  );
}

function SessionRow({ session, active, pinned, onClick, onTogglePin }: {
  session: Session;
  active: boolean;
  pinned: boolean;
  onClick: () => void;
  onTogglePin: () => void;
}) {
  return (
    <motion.div
      layout="position"
      variants={fadeUp}
      exit={{ opacity: 0, x: -4, transition: { duration: 0.12, ease: [0.16, 1, 0.3, 1] } }}
      className={cn('group relative rounded-md', active ? 'bg-white/5' : 'hover:bg-sidebar-accent/20')}
    >
      {active && (
        <motion.span
          layoutId="active-session-pill"
          className="absolute inset-0 rounded-md bg-white/5 ring-1 ring-white/10"
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          aria-hidden="true"
        />
      )}
      <button
        onClick={onClick}
        onContextMenu={(e) => { e.preventDefault(); onTogglePin(); }}
        className="relative w-full text-left px-2 py-1.5 flex items-center gap-1.5"
        title="Shift-click to pin"
      >
        <span className="text-muted-foreground/60 text-[10px] shrink-0">•</span>
        {pinned && <Pin className="size-2.5 text-muted-foreground/60 shrink-0" />}
        <p className={cn('truncate flex-1 text-[11.5px]', active ? 'text-foreground font-medium' : 'text-foreground/75')}>
          {session.title}
        </p>
      </button>
      <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition flex items-center gap-0.5 bg-background/80 backdrop-blur rounded px-0.5">
        <motion.button
          onClick={onTogglePin}
          whileHover={hoverScale.whileHover}
          whileTap={hoverScale.whileTap}
          className="p-0.5 hover:bg-white/10 rounded"
          aria-label={pinned ? 'Unpin' : 'Pin'}
        >
          <Pin className={cn('size-2.5', pinned && 'text-primary')} />
        </motion.button>
        <motion.button
          whileHover={hoverScale.whileHover}
          whileTap={hoverScale.whileTap}
          className="p-0.5 hover:bg-white/10 rounded"
          aria-label="More"
        >
          <MoreHorizontal className="size-2.5 text-muted-foreground" />
        </motion.button>
      </div>
    </motion.div>
  );
}
