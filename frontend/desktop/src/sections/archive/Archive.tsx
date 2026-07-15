import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  useSessionsStore,
  restoreSession,
  deleteSession,
  clearAllSessions,
  type Session
} from '@/store/sessions';
import { Button } from '@/components/ui/button';
import { Search, RotateCcw, Trash2, Folder as FolderIcon, MessageSquare } from 'lucide-react';
import { formatTimeAgo } from '@/lib/utils';
import { sessionRow } from '@/lib/motion';

export function Archive() {
  const navigate = useNavigate();
  const sessions = useSessionsStore((s) => s.sessions);
  const folders = useSessionsStore((s) => s.folders);

  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'alpha'>('newest');

  // Filter archived sessions
  const archived = sessions.filter(s => s.isArchived && (!filter || s.title.toLowerCase().includes(filter.toLowerCase())));

  // Sort archived sessions
  const sortedArchived = [...archived].sort((a, b) => {
    if (sortBy === 'alpha') {
      return a.title.localeCompare(b.title);
    }
    const timeA = new Date(a.startedAt).getTime();
    const timeB = new Date(b.startedAt).getTime();
    return sortBy === 'newest' ? timeB - timeA : timeA - timeB;
  });

  const handleClearAll = () => {
    if (confirm('Are you sure you want to delete sessions? This will wipe your conversation history and cannot be undone.')) {
      const deleteArchived = confirm('Do you want to delete archived sessions as well? Click OK to delete BOTH active and archived sessions, or Cancel to delete ONLY active sessions.');
      const newSess = clearAllSessions(deleteArchived);
      void navigate(`/c/${newSess.id}`);
      // Close settings by pressing Escape or navigating back
      const preSettingsPath = sessionStorage.getItem('pre-settings-path') || '/';
      void navigate(preSettingsPath);
    }
  };

  const handleRestore = (id: string) => {
    restoreSession(id);
  };

  const handleDeletePermanently = (id: string) => {
    if (confirm('Are you sure you want to permanently delete this session and its history? This action is irreversible.')) {
      deleteSession(id);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Top action row */}
      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between pb-4 border-b border-border/40">
        <div className="flex flex-1 max-w-md gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search archived sessions..."
              className="w-full pl-8 pr-2 py-1.5 text-xs bg-popover border border-border/40 rounded-md outline-none text-foreground placeholder:text-muted-foreground focus:border-primary/50"
            />
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'newest' | 'oldest' | 'alpha')}
            className="px-2 py-1.5 text-xs bg-popover border border-border/40 rounded-md text-foreground outline-none cursor-pointer focus:border-primary/50"
          >
            <option value="newest">Newest First</option>
            <option value="oldest">Oldest First</option>
            <option value="alpha">Alphabetical</option>
          </select>
        </div>
        
        <Button variant="destructive" size="sm" onClick={handleClearAll} className="h-8">
          <Trash2 className="size-3" />
          Clear All Sessions
        </Button>
      </div>

      {/* Grouped sessions list */}
      <div className="space-y-6">
        {archived.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-border/40 rounded-lg text-muted-foreground/60 text-xs">
            {filter ? 'No archived sessions match your search' : 'No archived sessions'}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Folders */}
            {folders.map(folder => {
              const folderSessions = sortedArchived.filter(s => s.folderId === folder.id);
              if (folderSessions.length === 0) return null;
              
              return (
                <div key={folder.id} className="space-y-2">
                  <div className="flex items-center gap-1.5 text-foreground/80 px-1 font-semibold text-xs border-b border-border/10 pb-1">
                    <FolderIcon className="size-3.5 text-muted-foreground/75" />
                    <span>📁 {folder.name}</span>
                    <span className="text-[10px] text-muted-foreground/50 font-normal">({folderSessions.length})</span>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5">
                    <AnimatePresence initial={false} mode="popLayout">
                      {folderSessions.map(s => (
                        <ArchiveRow
                          key={s.id}
                          session={s}
                          onRestore={() => handleRestore(s.id)}
                          onDelete={() => handleDeletePermanently(s.id)}
                        />
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              );
            })}

            {/* Uncategorized (Other Chats) */}
            {(() => {
              const uncategorizedSessions = sortedArchived.filter(s => !s.folderId);
              if (uncategorizedSessions.length === 0) return null;
              
              return (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-foreground/80 px-1 font-semibold text-xs border-b border-border/10 pb-1">
                    <MessageSquare className="size-3.5 text-muted-foreground/75" />
                    <span>Other Chats</span>
                    <span className="text-[10px] text-muted-foreground/50 font-normal">({uncategorizedSessions.length})</span>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5">
                    <AnimatePresence initial={false} mode="popLayout">
                      {uncategorizedSessions.map(s => (
                        <ArchiveRow
                          key={s.id}
                          session={s}
                          onRestore={() => handleRestore(s.id)}
                          onDelete={() => handleDeletePermanently(s.id)}
                        />
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

function ArchiveRow({ 
  session, onRestore, onDelete 
}: {
  session: Session;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <motion.div
      layout
      variants={sessionRow}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex items-center justify-between p-3 rounded-md bg-[#111113]/40 border border-border/20 hover:border-border/40 hover:bg-[#111113]/80 transition group overflow-hidden"
    >
      <div className="min-w-0 flex-1 pr-4">
        <h4 className="text-xs font-semibold text-foreground/90 truncate">{session.title}</h4>
        <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
          <span>Started {formatTimeAgo(session.startedAt)}</span>
          <span>·</span>
          <span>{session.messageCount} messages</span>
          <span>·</span>
          <span className="truncate">{session.model}</span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button 
          variant="outline" 
          size="icon-sm" 
          onClick={onRestore}
          className="size-7 text-muted-foreground hover:text-foreground"
          title="Restore session to sidebar"
        >
          <RotateCcw className="size-3" />
        </Button>
        <Button 
          variant="outline" 
          size="icon-sm" 
          onClick={onDelete}
          className="size-7 text-destructive hover:bg-destructive hover:text-destructive-foreground"
          title="Permanently delete session"
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </motion.div>
  );
}
