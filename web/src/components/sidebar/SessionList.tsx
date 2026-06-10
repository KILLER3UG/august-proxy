/* ── Session list — the actual sidebar from the screenshot ─────────── */
/* Top:   New session (⌘N) + Skills & Tools + Messaging + Artifacts         */
/* Middle: search, PINNED, SESSIONS (count)                                */
/* Bottom: ⌂ + ⚙ ⏵ ⟳ + status                                  */

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { 
  Plus, Search, Pin, MessageSquare, Wrench, Package, Home, 
  MoreHorizontal, Settings, Columns, Folder as FolderIcon, FolderOpen, 
  FolderPlus, ChevronRight, ChevronDown, Edit3, Trash2, Archive 
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fadeUp, hoverScale } from '@/lib/motion';
import { useStore } from '@nanostores/react';
import { 
  $sessions, 
  $folders, 
  renameSession, 
  deleteSession, 
  archiveSession, 
  moveSessionToFolder, 
  createFolder, 
  renameFolder, 
  deleteFolder, 
  toggleFolderCollapse,
  updateSessionWorkspace,
  type Session, 
  type Folder 
} from '@/store/sessions';
import { toast } from 'sonner';

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
  const [uncategorizedCollapsed, setUncategorizedCollapsed] = useState(() => localStorage.getItem('august-uncategorized-collapsed') === '1');

  const sessions = useStore($sessions);
  const folders = useStore($folders);

  const handleFolderUploadClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();

    let selectedPath: string | null = null;
    const isTauri = typeof window !== 'undefined' && (window as any).__TAURI__ !== undefined;

    if (isTauri) {
      try {
        selectedPath = await (window as any).__TAURI__.core.invoke('select_directory');
      } catch (err) {
        console.error('Failed to open Tauri directory dialog:', err);
      }
    } else {
      selectedPath = prompt('Enter absolute path to workspace folder (e.g. C:/projects/my-app):');
    }

    if (!selectedPath) return;
    selectedPath = selectedPath.trim();
    if (!selectedPath) return;

    // Normalize Windows backslashes
    const normalizedPath = selectedPath.replace(/\\/g, '/');
    const folderName = normalizedPath.split('/').pop() || 'workspace';

    const toastId = toast.loading(`Connecting to workspace: ${folderName}...`);

    try {
      const res = await fetch(`/api/workspace/files?path=${encodeURIComponent(normalizedPath)}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Directory does not exist or is not readable');
      }

      toast.success(`Connected to workspace: ${folderName}`, { id: toastId });

      if (activeId) {
        updateSessionWorkspace(activeId, normalizedPath);
        window.dispatchEvent(new CustomEvent('august-open-right-sidebar'));
      }
    } catch (err: any) {
      toast.error(`Access failed: ${err.message}`, { id: toastId });
    }
  };

  const visible = sessions.filter((s) => !s.isArchived && (!filter || s.title.toLowerCase().includes(filter.toLowerCase())));
  const pinned  = visible.filter((s) => pinnedIds.has(s.id));
  const others  = visible.filter((s) => !pinnedIds.has(s.id));

  const togglePin = (id: string) => {
    const next = new Set(pinnedIds);
    next.has(id) ? next.delete(id) : next.add(id);
    setPinnedIds(next);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([...next]));
  };

  const handleCreateFolder = () => {
    const name = prompt('Enter folder name:');
    if (name && name.trim()) {
      createFolder(name.trim());
    }
  };

  const handleRenameFolder = (id: string, currentName: string) => {
    const name = prompt('Rename folder:', currentName);
    if (name && name.trim() && name.trim() !== currentName) {
      renameFolder(id, name.trim());
    }
  };

  const handleDeleteFolder = (id: string) => {
    if (confirm('Are you sure you want to delete this folder? All sessions inside will be moved to uncategorized.')) {
      deleteFolder(id);
    }
  };

  const toggleUncategorizedCollapse = () => {
    const next = !uncategorizedCollapsed;
    setUncategorizedCollapsed(next);
    localStorage.setItem('august-uncategorized-collapsed', next ? '1' : '0');
  };

  return (
    <div className="flex h-full text-xs relative select-none bg-sidebar">
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
          <div className="py-2.5 px-2 flex flex-col gap-0.5">
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
          <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-4">
            <Section
              title="PINNED"
              count={pinned.length}
              empty="Shift-click a chat to pin"
            >
              <LayoutGroup id="pinned-sessions">
                <AnimatePresence initial={false}>
                  {pinned.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={activeId === s.id}
                      pinned
                      folders={folders}
                      onClick={() => onSelect(s)}
                      onTogglePin={() => togglePin(s.id)}
                      onRename={(newTitle) => renameSession(s.id, newTitle)}
                      onArchive={() => {
                        archiveSession(s.id);
                        if (activeId === s.id) {
                          const fallback = sessions.find(x => x.id !== s.id && !x.isArchived);
                          if (fallback) onSelect(fallback);
                        }
                      }}
                      onMoveToFolder={(fId) => moveSessionToFolder(s.id, fId)}
                      onDelete={() => {
                        if (confirm('Are you sure you want to permanently delete this chat?')) {
                          deleteSession(s.id);
                          if (activeId === s.id) {
                            const fallback = sessions.find(x => x.id !== s.id && !x.isArchived);
                            if (fallback) onSelect(fallback);
                          }
                        }
                      }}
                    />
                  ))}
                </AnimatePresence>
              </LayoutGroup>
            </Section>

            <Section 
              title="SESSIONS" 
              count={others.length}
              onNewFolder={handleCreateFolder}
              onUploadFolder={handleFolderUploadClick}
            >
              <div className="space-y-2.5">
                {/* Collapsible Folders */}
                {folders.map((folder) => {
                  const folderSessions = others.filter(s => s.folderId === folder.id);
                  const isCollapsed = folder.isCollapsed ?? false;
                  
                  return (
                    <div key={folder.id} className="space-y-0.5">
                      <FolderHeader
                        folder={folder}
                        count={folderSessions.length}
                        onToggleCollapse={() => toggleFolderCollapse(folder.id)}
                        onRename={() => handleRenameFolder(folder.id, folder.name)}
                        onDelete={() => handleDeleteFolder(folder.id)}
                      />
                      
                      {!isCollapsed && (
                        <div className="pl-2.5 border-l border-border/10 ml-3.5 space-y-0.5">
                          {folderSessions.map((s) => (
                            <SessionRow
                              key={s.id}
                              session={s}
                              active={activeId === s.id}
                              pinned={false}
                              folders={folders}
                              onClick={() => onSelect(s)}
                              onTogglePin={() => togglePin(s.id)}
                              onRename={(newTitle) => renameSession(s.id, newTitle)}
                              onArchive={() => {
                                archiveSession(s.id);
                                if (activeId === s.id) {
                                  const fallback = sessions.find(x => x.id !== s.id && !x.isArchived);
                                  if (fallback) onSelect(fallback);
                                }
                              }}
                              onMoveToFolder={(fId) => moveSessionToFolder(s.id, fId)}
                              onDelete={() => {
                                if (confirm('Are you sure you want to permanently delete this chat?')) {
                                  deleteSession(s.id);
                                  if (activeId === s.id) {
                                    const fallback = sessions.find(x => x.id !== s.id && !x.isArchived);
                                    if (fallback) onSelect(fallback);
                                  }
                                }
                              }}
                            />
                          ))}
                          {folderSessions.length === 0 && (
                            <p className="py-1 text-[10px] text-muted-foreground/30 italic pl-1.5">Empty folder</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Uncategorized Sessions (Other Chats) */}
                {(() => {
                  const uncategorizedSessions = others.filter(s => !s.folderId);
                  
                  return (
                    <div className="space-y-0.5">
                      <UncategorizedHeader
                        count={uncategorizedSessions.length}
                        isCollapsed={uncategorizedCollapsed}
                        onToggleCollapse={toggleUncategorizedCollapse}
                      />
                      
                      {!uncategorizedCollapsed && (
                        <div className="pl-2.5 border-l border-border/10 ml-3.5 space-y-0.5">
                          {uncategorizedSessions.map((s) => (
                            <SessionRow
                              key={s.id}
                              session={s}
                              active={activeId === s.id}
                              pinned={false}
                              folders={folders}
                              onClick={() => onSelect(s)}
                              onTogglePin={() => togglePin(s.id)}
                              onRename={(newTitle) => renameSession(s.id, newTitle)}
                              onArchive={() => {
                                archiveSession(s.id);
                                if (activeId === s.id) {
                                  const fallback = sessions.find(x => x.id !== s.id && !x.isArchived);
                                  if (fallback) onSelect(fallback);
                                }
                              }}
                              onMoveToFolder={(fId) => moveSessionToFolder(s.id, fId)}
                              onDelete={() => {
                                if (confirm('Are you sure you want to permanently delete this chat?')) {
                                  deleteSession(s.id);
                                  if (activeId === s.id) {
                                    const fallback = sessions.find(x => x.id !== s.id && !x.isArchived);
                                    if (fallback) onSelect(fallback);
                                  }
                                }
                              }}
                            />
                          ))}
                          {uncategorizedSessions.length === 0 && (
                            <p className="py-1 text-[10px] text-muted-foreground/30 italic pl-1.5">No other chats</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </Section>
          </div>
        </motion.div>
      )}
    </div>
  );
}

function Section({ title, count, empty, onNewFolder, onUploadFolder, children }: { 
  title: string; 
  count: number; 
  empty?: string; 
  onNewFolder?: () => void;
  onUploadFolder?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children?: React.ReactNode 
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 px-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[9.5px] uppercase tracking-wider text-muted-foreground/75 font-bold">{title}</h3>
          <span className="text-[9.5px] text-muted-foreground/50 font-mono">({count})</span>
        </div>
        {title === 'SESSIONS' && onNewFolder && onUploadFolder && (
          <div className="flex items-center gap-1">
            <button 
              onClick={onUploadFolder} 
              className="text-muted-foreground/50 hover:text-foreground p-0.5 rounded transition hover:bg-white/5"
              title="Open Workspace Folder"
            >
              <FolderPlus className="size-3" />
            </button>
            <button 
              onClick={(e) => { e.stopPropagation(); onNewFolder(); }} 
              className="text-muted-foreground/50 hover:text-foreground p-0.5 rounded transition hover:bg-white/5"
              title="Create Sidebar Folder"
            >
              <Plus className="size-3" />
            </button>
          </div>
        )}
      </div>
      {count === 0 && title === 'PINNED'
        ? <p className="px-2 py-1 text-[10px] text-muted-foreground/40 italic">{empty ?? 'No items'}</p>
        : <div className="space-y-0.5">{children}</div>
      }
    </div>
  );
}

function FolderHeader({ folder, count, onToggleCollapse, onRename, onDelete }: {
  folder: Folder;
  count: number;
  onToggleCollapse: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  
  return (
    <div 
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-white/5 cursor-pointer group text-sidebar-foreground/80 font-medium"
      onClick={onToggleCollapse}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {folder.isCollapsed ? <ChevronRight className="size-3 text-muted-foreground/60" /> : <ChevronDown className="size-3 text-muted-foreground/60" />}
        {folder.isCollapsed ? <FolderIcon className="size-3.5 text-muted-foreground/70 shrink-0" /> : <FolderOpen className="size-3.5 text-muted-foreground/70 shrink-0" />}
        <span className="truncate text-[11px] font-semibold text-foreground/85">{folder.name}</span>
        <span className="text-[9.5px] text-muted-foreground/50 font-mono">({count})</span>
      </div>
      
      {isHovered && (
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button 
            onClick={onRename} 
            className="p-0.5 hover:bg-white/10 rounded text-muted-foreground hover:text-foreground"
            title="Rename Folder"
          >
            <Edit3 className="size-2.5" />
          </button>
          <button 
            onClick={onDelete} 
            className="p-0.5 hover:bg-white/10 rounded text-destructive hover:text-destructive-foreground"
            title="Delete Folder"
          >
            <Trash2 className="size-2.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function UncategorizedHeader({ count, isCollapsed, onToggleCollapse }: {
  count: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <div 
      className="flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-white/5 cursor-pointer text-sidebar-foreground/80 font-medium"
      onClick={onToggleCollapse}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {isCollapsed ? <ChevronRight className="size-3 text-muted-foreground/60" /> : <ChevronDown className="size-3 text-muted-foreground/60" />}
        <MessageSquare className="size-3.5 text-muted-foreground/70 shrink-0" />
        <span className="truncate text-[11px] font-semibold text-foreground/85">Other Chats</span>
        <span className="text-[9.5px] text-muted-foreground/50 font-mono">({count})</span>
      </div>
    </div>
  );
}

function SessionRow({ 
  session, active, pinned, folders, onClick, onTogglePin, onRename, onArchive, onMoveToFolder, onDelete 
}: {
  session: Session;
  active: boolean;
  pinned: boolean;
  folders: Folder[];
  onClick: () => void;
  onTogglePin: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onMoveToFolder: (folderId: string | null) => void;
  onDelete: () => void;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(session.title);

  useEffect(() => {
    if (!showMenu) return;
    const handleClose = () => setShowMenu(false);
    window.addEventListener('click', handleClose);
    return () => window.removeEventListener('click', handleClose);
  }, [showMenu]);

  const handleSaveRename = () => {
    if (editTitle.trim() && editTitle.trim() !== session.title) {
      onRename(editTitle.trim());
    }
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <div className="w-full px-2 py-1 flex items-center gap-1.5 bg-white/5 rounded-md">
        <input
          autoFocus
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSaveRename();
            if (e.key === 'Escape') { setEditTitle(session.title); setIsEditing(false); }
          }}
          onBlur={handleSaveRename}
          onClick={(e) => e.stopPropagation()}
          className="bg-[#09090b] border border-border/80 px-1.5 py-0.5 rounded text-[11px] w-full outline-none text-foreground"
        />
      </div>
    );
  }

  return (
    <motion.div
      layout="position"
      variants={fadeUp}
      exit={{ opacity: 0, x: -4, transition: { duration: 0.12, ease: [0.16, 1, 0.3, 1] } }}
      className={cn('group relative rounded-md border border-transparent', active ? 'bg-white/5 border-white/5' : 'hover:bg-sidebar-accent/20')}
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
        className="relative w-full text-left px-2 py-1.5 flex items-center gap-1.5 pr-12 min-w-0"
        title="Right click or use three-dots menu to pin"
      >
        <span className="text-muted-foreground/60 text-[10px] shrink-0">•</span>
        {pinned && <Pin className="size-2.5 text-muted-foreground/60 shrink-0" />}
        <p className={cn('truncate flex-1 text-[11.5px]', active ? 'text-foreground font-semibold' : 'text-foreground/75')}>
          {session.title}
        </p>
      </button>

      {/* Floating kebab menu triggers */}
      <div 
        onClick={(e) => e.stopPropagation()} 
        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition flex items-center gap-0.5 bg-background/90 border border-border/30 backdrop-blur rounded px-0.5 z-40"
      >
        <motion.button
          onClick={onTogglePin}
          whileHover={hoverScale.whileHover}
          whileTap={hoverScale.whileTap}
          className="p-0.5 hover:bg-white/10 rounded"
          aria-label={pinned ? 'Unpin' : 'Pin'}
        >
          <Pin className={cn('size-2.5 text-muted-foreground/70 hover:text-foreground', pinned && 'text-primary')} />
        </motion.button>
        <motion.button
          onClick={() => setShowMenu(!showMenu)}
          whileHover={hoverScale.whileHover}
          whileTap={hoverScale.whileTap}
          className="p-0.5 hover:bg-white/10 rounded"
          aria-label="More options"
        >
          <MoreHorizontal className="size-2.5 text-muted-foreground/70 hover:text-foreground" />
        </motion.button>
      </div>

      {/* Kebab action dropdown */}
      {showMenu && (
        <div 
          className="absolute right-1 top-7 z-50 w-36 bg-[#18181b] border border-border/60 rounded-md shadow-2xl py-1 text-[11px] animate-in fade-in slide-in-from-top-1 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          <button 
            onClick={() => { onTogglePin(); setShowMenu(false); }} 
            className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-foreground/90 transition"
          >
            <Pin className="size-3 text-muted-foreground" />
            {pinned ? 'Unpin Chat' : 'Pin Chat'}
          </button>
          
          <button 
            onClick={() => { setIsEditing(true); setShowMenu(false); }} 
            className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-foreground/90 transition"
          >
            <Edit3 className="size-3 text-muted-foreground" />
            Rename Chat
          </button>

          {/* Move to folder submenu */}
          <div className="relative group/sub">
            <button 
              className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center justify-between gap-1.5 text-foreground/90 transition"
            >
              <span className="flex items-center gap-1.5">
                <FolderIcon className="size-3 text-muted-foreground" />
                Move to Folder
              </span>
              <ChevronRight className="size-2.5 text-muted-foreground" />
            </button>
            <div className="absolute left-full top-0 ml-0.5 hidden group-hover/sub:block w-32 bg-[#18181b] border border-border/60 rounded-md shadow-2xl py-1 z-50 animate-in fade-in slide-in-from-left-1 duration-100">
              <button 
                onClick={() => { onMoveToFolder(null); setShowMenu(false); }}
                className={cn("w-full text-left px-2.5 py-1 hover:bg-white/5 truncate transition", !session.folderId ? "text-primary font-medium" : "text-foreground/80")}
              >
                No Folder
              </button>
              {folders.map(f => (
                <button 
                  key={f.id}
                  onClick={() => { onMoveToFolder(f.id); setShowMenu(false); }}
                  className={cn("w-full text-left px-2.5 py-1 hover:bg-white/5 truncate transition", session.folderId === f.id ? "text-primary font-medium" : "text-foreground/80")}
                  title={f.name}
                >
                  {f.name}
                </button>
              ))}
            </div>
          </div>

          <button 
            onClick={() => { onArchive(); setShowMenu(false); }} 
            className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-amber-500 hover:text-amber-400 transition"
          >
            <Archive className="size-3 text-amber-500/80" />
            Archive Chat
          </button>
          
          <div className="h-[1px] bg-border/40 my-1" />
          
          <button 
            onClick={() => { onDelete(); setShowMenu(false); }} 
            className="w-full text-left px-2.5 py-1 hover:bg-white/5 flex items-center gap-1.5 text-destructive hover:text-destructive/90 transition"
          >
            <Trash2 className="size-3 text-destructive/80" />
            Delete Chat
          </button>
        </div>
      )}
    </motion.div>
  );
}
