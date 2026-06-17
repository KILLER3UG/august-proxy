import { AnimatePresence, motion } from "framer-motion";
import { SessionList } from "@/components/sidebar/SessionList";
import { useStore } from "@nanostores/react";
import { $sessions, $folders, $sessionStates } from "@/store/sessions";

interface SessionSidebarProps {
  activeId?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNew: () => void;
  onNewInFolder: (folderId: string) => void;
  onNavigate: (path: string) => void;
}

export function SessionSidebar({
  activeId,
  collapsed,
  onToggleCollapsed,
  onNew,
  onNewInFolder,
  onNavigate,
}: SessionSidebarProps) {
  const sessions = useStore($sessions);
  const folders = useStore($folders);
  const sessionStates = useStore($sessionStates);

  return (
    <>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.aside
            key="sidebar"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 256, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="shrink-0 bg-sidebar text-sidebar-foreground flex flex-col overflow-hidden"
          >
            <div className="w-64 flex-1 overflow-hidden">
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
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
