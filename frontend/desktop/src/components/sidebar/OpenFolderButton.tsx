/* ── OpenFolderButton ────────────────────────────────────────────────── */
/* Button at the top of the sidebar that opens a native folder picker and
   creates/navigates to a workspace session. */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { openFolderViaTauri, folderNameFromPath } from '@/api/folder';
import { findOrCreateSessionForPath } from '@/store/sessions';

export function OpenFolderButton() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const handleOpenFolder = async () => {
    setLoading(true);
    try {
      const result = await openFolderViaTauri();
      if (result.cancelled || !result.path) return;

      const name = result.name || folderNameFromPath(result.path);
      const { session } = findOrCreateSessionForPath(result.path, name);
      void navigate(`/c/${session.id}`);
    } catch (err) {
      console.error('Failed to open folder:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => { void handleOpenFolder(); }}
      disabled={loading}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium',
        'text-muted-foreground hover:text-foreground hover:bg-white/[0.06]',
        'transition-colors',
        loading && 'opacity-50 cursor-not-allowed',
      )}
      title="Open workspace folder"
      aria-label="Open workspace folder"
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <FolderOpen className="size-4" />
      )}
      <span>Open Folder</span>
    </button>
  );
}
