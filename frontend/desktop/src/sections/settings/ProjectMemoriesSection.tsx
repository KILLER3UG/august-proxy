/* ── ProjectMemoriesSection — browse memories by project (folder) ──────── */

import { useState } from 'react';
import { useSessionsStore } from '@/store/sessions';
import { AutoMemoryBrowse } from './AutoMemoryBrowse';

function folderFromOpenChat(): string {
  try {
    const back = sessionStorage.getItem('pre-settings-path') || '';
    const m = back.match(/\/c\/([^/?#]+)/);
    if (!m) return '';
    const sid = decodeURIComponent(m[1]);
    const sess = useSessionsStore
      .getState()
      .sessions.find((s) => s.id === sid || s.workbenchSessionId === sid);
    return sess?.folderId || '';
  } catch {
    return '';
  }
}

export function ProjectMemoriesSection({ embedded }: { embedded?: boolean }) {
  const folders = useSessionsStore((s) => s.folders);
  const [folderId, setFolderId] = useState<string>(() => folderFromOpenChat());

  return (
    <div className={embedded ? 'space-y-2' : 'flex h-full flex-col'}>
      <div className={embedded ? 'space-y-2' : 'px-6 pt-5 pb-3 shrink-0 space-y-2'}>
        {embedded ? null : (
          <>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Project Memories
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              Memories August learned from chats inside a project folder — browse
              what it remembers per project.
            </p>
          </>
        )}
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Project</span>
          <select
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            className="mt-1 w-full max-w-sm rounded-md border border-border bg-popover px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/50"
          >
            <option value="">All projects</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="min-h-0 flex-1">
        <AutoMemoryBrowse
          embedded={embedded}
          origin="recalled"
          title="Project Memories"
          subtitle={
            folderId
              ? 'Memories from chats in the selected project.'
              : 'Pick a project above to see its memories.'
          }
          emptyTitle={
            folderId ? 'No memories for this project yet' : 'Select a project to browse'
          }
          emptyHint={
            folderId
              ? 'August saves memories as you chat in this project.'
              : 'Memories are grouped by the project folder their chat lives in.'
          }
          listComposerPlaceholder=""
          detailComposerPlaceholder="Tell August what to change or remove"
          showListComposer={false}
          folderId={folderId || undefined}
        />
      </div>
    </div>
  );
}
