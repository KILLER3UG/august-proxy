import { useEffect, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { SessionList } from "@/components/sidebar/SessionList";
import { PANEL_EASE, PANEL_MS } from "@/lib/motion";
import { useResizablePane } from "@/hooks/useResizablePane";

interface SessionSidebarProps {
  activeId?: string;
  collapsed: boolean;
  /** The phone tier: the drawer's rows drop the primary nav (the tabbar owns
   *  those destinations) and the resize handle is meaningless on a touch
   *  device. */
  mobile?: boolean;
  onToggleCollapsed: () => void;
  onNew: () => void;
  onNewInFolder: (folderId: string | null) => void;
  onNavigate: (path: string) => void;
}

const SIDEBAR_WIDTH_KEY = "august-session-sidebar-width-v2";
const DEFAULT_WIDTH = 276;
const MIN_WIDTH = 220;
const MAX_VIEWPORT_FRACTION = 0.33;

function sidebarMax(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_VIEWPORT_FRACTION));
}

export function SessionSidebar({
  activeId,
  collapsed,
  mobile = false,
  onToggleCollapsed,
  onNew,
  onNewInFolder,
  onNavigate,
}: SessionSidebarProps) {
  const { size: width, isDragging, handleProps } = useResizablePane({
    initial: DEFAULT_WIDTH,
    min: MIN_WIDTH,
    max: sidebarMax,
    axis: "x",
    storageKey: SIDEBAR_WIDTH_KEY,
    "aria-label": "Resize session sidebar",
  });

  /* The phone's drawer is a sheet, not the desktop rail: the mockup opens it
     at ~86% of the screen. The stored pane width is a DESKTOP preference (a
     220px rail is a fine desktop column and a cramped phone drawer), so the
     tier ignores it without overwriting it. */
  const [viewport, setViewport] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth : 390),
  );
  useEffect(() => {
    if (!mobile) return;
    const onResize = () => setViewport(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mobile]);
  const paneWidth = mobile ? Math.min(340, Math.round(viewport * 0.86)) : width;

  const innerStyle: CSSProperties = { width: paneWidth };

  return (
    <AnimatePresence initial={false}>
      {!collapsed && (
        <motion.aside
          key="sidebar"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: paneWidth, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{
            duration: isDragging ? 0 : PANEL_MS,
            ease: PANEL_EASE,
          }}
          className="august-session-sidebar sd-sidebar relative shrink-0 text-sidebar-foreground flex flex-col overflow-hidden"
        >
          <div className="h-full flex-1 overflow-hidden" style={innerStyle}>
            <SessionList
              activeId={activeId}
              collapsed={collapsed}
              mobile={mobile}
              onToggleCollapsed={onToggleCollapsed}
              onSelect={(s) => onNavigate(`/c/${s.id}`)}
              onNew={onNew}
              onNewInFolder={onNewInFolder}
              onNavigate={onNavigate}
            />
          </div>

          {!mobile && (
            <div
              {...handleProps}
              className={`absolute top-0 right-0 h-full w-1 cursor-col-resize select-none touch-none transition-colors hover:bg-primary/40 ${isDragging ? "bg-primary/50" : "bg-transparent"}`}
            />
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}