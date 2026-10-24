import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { undoAugustRollback } from '@/api/api-client/manage';
import type { ChatMessage } from '@/types/chat';

/**
 * MemorySaveChip — at most ONE small receipt for a memory save on this turn,
 * with the rollback entry the write door recorded as its Undo.
 *
 * The spec asks for one chip; a turn that saved three facts still shows the
 * single most recent one. Silence when the turn saved nothing, or when the
 * build predates `rollbackId` (the receipt then has nothing to undo by).
 */
export function MemorySaveChip({ tools }: { tools?: ChatMessage['tools'] }) {
  const qc = useQueryClient();
  const saved = useMemo(() => {
    let hit: { key: string; rollbackId: string } | null = null;
    for (const tool of tools ?? []) {
      if (tool.name !== 'remember' || !tool.summary) continue;
      try {
        const parsed = JSON.parse(tool.summary) as Record<string, unknown>;
        if (parsed?.ok === true && typeof parsed.rollbackId === 'string' && parsed.rollbackId) {
          hit = {
            key: typeof parsed.key === 'string' ? parsed.key : 'memory',
            rollbackId: parsed.rollbackId,
          };
        }
      } catch {
        /* the receipt is JSON; a non-JSON summary is not a successful save */
      }
    }
    return hit;
  }, [tools]);

  const undo = useMutation({
    mutationFn: (id: string) => undoAugustRollback(id),
    onSuccess: () => {
      toast.success('Memory save undone');
      void qc.invalidateQueries({ queryKey: ['brain-stores'] });
    },
    onError: (err) =>
      toast.error(`Undo failed: ${err instanceof Error ? err.message : String(err)}`),
  });

  if (!saved) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-2xs text-foreground/90"
      data-testid="memory-save-chip"
    >
      <BookmarkPlus className="size-2.5 shrink-0 text-primary" aria-hidden />
      <span className="max-w-[16rem] truncate" title={saved.key}>
        Memory saved: {saved.key}
      </span>
      <button
        type="button"
        onClick={() => undo.mutate(saved.rollbackId)}
        disabled={undo.isPending}
        className="inline-flex items-center gap-0.5 text-primary transition hover:underline disabled:opacity-50"
        data-testid="memory-save-undo"
      >
        <Undo2 className="size-2.5" aria-hidden /> Undo
      </button>
    </span>
  );
}
