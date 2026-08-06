/**
 * Conversation search modal (C8) — FTS search across all conversations.
 * Opened from the command palette; results navigate to the session.
 */
import { create } from 'zustand';

interface ConversationSearchState {
  open: boolean;
}

export const useConversationSearchStore = create<ConversationSearchState>(() => ({
  open: false,
}));

export function openConversationSearch(): void {
  useConversationSearchStore.setState({ open: true });
}

export function closeConversationSearch(): void {
  useConversationSearchStore.setState({ open: false });
}
