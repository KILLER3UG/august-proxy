import { useEffect, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { SessionList } from "@/components/sidebar/SessionList";
import { useSessionsStore } from "@/store/sessions";

interface SessionSidebarProps {
  activeId?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNew: () => void;
  onNewInFolder: (folderId: string) => void;
  onNavigate: (path: string) => void;
}

const SIDEBAR_WIDTH_KEY = "august-session-sidebar-width";
const DEFAULT_WIDTH = 256;
const MIN_WIDTH = 150;
const MAX_VIEWPORT_FRACTION = 0.4;

function loadStoredWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_WIDTH;
  return clampWidth(parsed);
}

function clampWidth(value: number): number {
  const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_VIEWPORT_FRACTION));
  return Math.min(max, Math.max(MIN_WIDTH, value));
}

export function SessionSidebar({
  activeId,
  collapsed,
  onToggleCollapsed,
  onNew,
  onNewInFolder,
  onNavigate,
}: SessionSidebarProps) {
  const _sessions = useSessionsStore((s) => s.sessions);
  const _folders = useSessionsStore((s) => s.folders);
  const _sessionStates = useSessionsStore((s) => s.sessionStates);
  const [width, setWidth] = useState<number>(loadStoredWidth);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  }, [width]);

  // Stop dragging if the component unmounts mid-drag.
  useEffect(() => {
    if (!isDragging) return;
    const stop = () => setIsDragging(false);
    window.addEventListener("mouseup", stop);
    window.addEventListener("touchend", stop);
    return () => {
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("touchend", stop);
    };
  }, [isDragging]);

  const startResize = (clientX: number) => {
    const startX = clientX;
    const startW = width;
    setIsDragging(true);

    const onMove = (ev: MouseEvent | TouchEvent) => {
      const next = "touches" in ev && ev.touches.length
        ? ev.touches[0].clientX
        : (ev as MouseEvent).clientX;
      const delta = next - startX;
      setWidth(clampWidth(startW + delta));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove as (e: MouseEvent) => void);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove as (e: TouchEvent) => void);
      window.removeEventListener("touchend", onUp);
      setIsDragging(false);
    };

    window.addEventListener("mousemove", onMove as (e: MouseEvent) => void);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove as (e: TouchEvent) => void, { passive: true });
    window.addEventListener("touchend", onUp);
  };

  const asideStyle: CSSProperties = { width };

  return (
    <>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.aside
            key="sidebar"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: isDragging ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="relative shrink-0 bg-sidebar text-sidebar-foreground flex flex-col overflow-hidden"
            style={asideStyle}
          >
            <div className="w-full flex-1 overflow-hidden">
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
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize session sidebar"
              onMouseDown={(e) => {
                e.preventDefault();
                startResize(e.clientX);
              }}
              onTouchStart={(e) => {
                if (e.touches.length) startResize(e.touches[0].clientX);
              }}
              className={`absolute top-0 right-0 h-full w-1 cursor-col-resize select-none touch-none transition-colors hover:bg-primary/40 ${isDragging ? "bg-primary/50" : "bg-transparent"}`}
            />
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}