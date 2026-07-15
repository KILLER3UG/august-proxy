/* ── useChatAttachments ───────────────────────────────────────────────── */
/* Composer attachment list + paste/file handlers via ChatAttachmentService */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { FileAttachment } from '@/types/chat';
import { ChatAttachmentService } from '../services/ChatAttachmentService';

export function useChatAttachments() {
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  // Revoke blob previews on unmount so we don't leak object URLs.
  useEffect(() => {
    return () => {
      ChatAttachmentService.revokePreviews(attachmentsRef.current);
    };
  }, []);

  const patchAttachment = useCallback((id: string, patch: Partial<FileAttachment>) => {
    setAttachments((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        // When we gain a stable dataUrl, drop the temporary blob preview.
        if (patch.dataUrl && a.previewUrl) {
          try {
            URL.revokeObjectURL(a.previewUrl);
          } catch {
            /* ignore */
          }
          return { ...a, ...patch, previewUrl: undefined };
        }
        if (patch.status === 'error' && a.previewUrl && patch.previewUrl === undefined) {
          try {
            URL.revokeObjectURL(a.previewUrl);
          } catch {
            /* ignore */
          }
          return { ...a, ...patch, previewUrl: undefined };
        }
        return { ...a, ...patch };
      }),
    );
  }, []);

  const attachFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;

      // Show chips immediately with progress rings, then fill content as each file is read.
      const pendingList = list.map((f) => ({
        file: f,
        pending: ChatAttachmentService.createPending(f),
      }));

      setAttachments((prev) => [...prev, ...pendingList.map((p) => p.pending)]);

      await Promise.all(
        pendingList.map(async ({ file, pending }) => {
          const id = pending.id!;
          const done = await ChatAttachmentService.readInto(file, pending, (progress) => {
            patchAttachment(id, { progress, status: 'reading' });
          });
          patchAttachment(id, {
            name: done.name,
            content: done.content,
            dataUrl: done.dataUrl,
            type: done.type,
            truncated: done.truncated,
            status: done.status,
            progress: done.progress,
            error: done.error,
            // clear preview via patchAttachment when dataUrl is set
            previewUrl: done.dataUrl ? undefined : done.previewUrl,
          });
        }),
      );
    },
    [patchAttachment],
  );

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      await attachFiles(files);
      if (e.target) e.target.value = '';
    },
    [attachFiles],
  );

  const handleComposerPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = ChatAttachmentService.filesFromClipboard(e.clipboardData);
      if (files.length === 0) return;
      const hasImage = files.some((f) => f.type.startsWith('image/'));
      e.preventDefault();
      void attachFiles(files);
      toast.message(
        hasImage
          ? `Attached ${files.length} image${files.length === 1 ? '' : 's'}`
          : `Attached ${files.length} file${files.length === 1 ? '' : 's'}`,
      );
    },
    [attachFiles],
  );

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      const target = prev[index];
      if (target?.previewUrl) {
        try {
          URL.revokeObjectURL(target.previewUrl);
        } catch {
          /* ignore */
        }
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const removeAttachmentById = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) {
        try {
          URL.revokeObjectURL(target.previewUrl);
        } catch {
          /* ignore */
        }
      }
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      ChatAttachmentService.revokePreviews(prev);
      return [];
    });
  }, []);

  const composeText = useCallback(
    (text: string) => ChatAttachmentService.composeUserText(text, attachments),
    [attachments],
  );

  const isReading = ChatAttachmentService.isReading(attachments);
  const readyAttachments = ChatAttachmentService.readyOnly(attachments);

  return {
    attachments,
    setAttachments,
    attachFiles,
    handleFileUpload,
    handleComposerPaste,
    removeAttachment,
    removeAttachmentById,
    clearAttachments,
    composeText,
    isReading,
    readyAttachments,
  };
}
