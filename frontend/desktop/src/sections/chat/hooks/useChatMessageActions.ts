/* ── Message actions ───────────────────────────────────────────────────── */
/* Revert / edit / regenerate / clarify for turns already on the thread.   */

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import { queueWorkbenchMessage } from '@/api/workbench';
import type { ChatMessage } from '@/types/chat';
import { persistMessages } from '../message-storage';

export function useChatMessageActions({
  sessionId,
  messages,
  setMessages,
  input,
  setInput,
  streaming,
  generateAIResponse,
}: {
  sessionId: string | null;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  streaming: boolean;
  generateAIResponse: (msgs: ChatMessage[]) => Promise<void>;
}) {
  const [revertingIndex, setRevertingIndex] = useState<number | null>(null);

  const handleRevert = useCallback(
    (index: number) => {
      if (streaming) return;

      let userMsgIndex = -1;
      if (messages[index].role === 'user') {
        userMsgIndex = index;
      } else if (index > 0 && messages[index - 1].role === 'user') {
        userMsgIndex = index - 1;
      }

      if (userMsgIndex === -1) return;

      const userMsg = messages[userMsgIndex];
      const deleted = messages.length - userMsgIndex;

      const originalMessages = [...messages];
      const originalInput = input;
      setRevertingIndex(userMsgIndex);

      setTimeout(() => {
        setInput(userMsg.content);
        setMessages((prev) => {
          const next = prev.slice(0, userMsgIndex);
          persistMessages(sessionId, next);
          return next;
        });
        setRevertingIndex(null);

        toast.success('Conversation reverted', {
          description: `Put prompt back into composer and removed ${deleted} message${deleted > 1 ? 's' : ''}`,
          duration: 5000,
          action: {
            label: 'Undo',
            onClick: () => {
              setMessages((_prev) => {
                persistMessages(sessionId, originalMessages);
                return originalMessages;
              });
              setInput(originalInput);
            },
          },
        });
      }, 300);
    },
    [streaming, messages, input, setInput, setMessages, sessionId],
  );

  const handleEdit = useCallback(
    (index: number, newText: string) => {
      if (streaming) return;
      if (!newText.trim()) return;
      const msg = messages[index];
      if (!msg || msg.role !== 'user') return;
      const nextCount = messages.length - index - 1;
      if (
        nextCount > 0 &&
        !confirm(
          `Editing this message will remove ${nextCount} follow-up message${nextCount > 1 ? 's' : ''}. Continue?`,
        )
      )
        return;
      setMessages((prev) => {
        const current = prev[index];
        if (!current || current.role !== 'user') return prev;
        const next = prev.slice(0, index).concat({ ...current, content: newText.trim() });
        persistMessages(sessionId, next);
        return next;
      });
    },
    [streaming, messages, setMessages, sessionId],
  );

  const handleRegenerate = useCallback(
    async (index: number) => {
      if (streaming) return;
      let userIndex = index;
      for (let i = index; i >= 0; i--) {
        if (messages[i].role === 'user') {
          userIndex = i;
          break;
        }
      }
      const msg = messages[userIndex];
      if (!msg || msg.role !== 'user') return;
      const trimmed = messages.slice(0, userIndex + 1);
      setMessages(trimmed);
      persistMessages(sessionId, trimmed);
      await generateAIResponse([msg]);
    },
    [streaming, messages, setMessages, sessionId, generateAIResponse],
  );

  const handleClarifyAnswer = useCallback(
    (msgId: string, answer: string) => {
      if (sessionId) {
        void queueWorkbenchMessage(sessionId, answer);
      }
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === msgId ? { ...msg, clarify: { ...(msg.clarify ?? {}), answer } } : msg,
        ),
      );
    },
    [sessionId, setMessages],
  );

  return {
    revertingIndex,
    handleRevert,
    handleEdit,
    handleRegenerate,
    handleClarifyAnswer,
  };
}
