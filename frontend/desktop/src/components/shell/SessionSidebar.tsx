import { type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { SessionList } from "@/components/sidebar/SessionList";
import { PANEL_EASE, PANEL_MS } from "@/lib/motion";
import { useResizablePane } from "@/hooks/useResizablePane";

interface SessionSidebarProps {
  activeId?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNew: () => void;
  onNewInFolder: (folderId: string | null) => void;
  onNavigate: (path: string) => void;
}

const SIDEBAR_WIDTH_KEY = "august-session-sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 220;
const MAX_VIEWPORT_FRACTION = 0.33;

function sidebarMax(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_VIEWPORT_FRACTION));
}

export function SessionSidebar({
  activeId,
  collapsed,
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

  const innerStyle: CSSProperties = { width };

  return (
    <AnimatePresence initial={false}>
      {!collapsed && (
        <motion.aside
          key="sidebar"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{
            duration: isDragging ? 0 : PANEL_MS,
            ease: PANEL_EASE,
          }}
          className="august-session-sidebar relative shrink-0 bg-sidebar text-sidebar-foreground flex flex-col overflow-hidden"
        >
          <div className="h-full flex-1 overflow-hidden" style={innerStyle}>
            <SessionList
              activeId={activeId}
              collapsed={collapsed}
              onToggleCollapsed={onToggleCollapsed}
              onSelect={(s) => onNavigate(`/c/${s.id}`)}
              onNew={onNew}
              onNewInFolder={onNewInFolder}
              onNavigate={onNavigate}
            />
          </div>

          <div
            {...handleProps}
            className={`absolute top-0 right-0 h-full w-1 cursor-col-resize select-none touch-none transition-colors hover:bg-primary/40 ${isDragging ? "bg-primary/50" : "bg-transparent"}`}
          />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}