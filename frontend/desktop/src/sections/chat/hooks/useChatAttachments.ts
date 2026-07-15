/* ── useChatAttachments ───────────────────────────────────────────────── */
/* Composer attachment list + paste/file handlers via ChatAttachmentService */

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { FileAttachment } from '@/types/chat';
import { ChatAttachmentService } from '../services/ChatAttachmentService';

export function useChatAttachments() {
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);

  const attachFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const next = await ChatAttachmentService.fromFiles(list);
    setAttachments((prev) => [...prev, ...next]);
  }, []);

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
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAttachments = useCallback(() => setAttachments([]), []);

  const composeText = useCallback(
    (text: string) => ChatAttachmentService.composeUserText(text, attachments),
    [attachments],
  );

  return {
    attachments,
    setAttachments,
    attachFiles,
    handleFileUpload,
    handleComposerPaste,
    removeAttachment,
    clearAttachments,
    composeText,
  };
}
