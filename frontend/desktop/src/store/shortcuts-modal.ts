import { create } from 'zustand';

interface ShortcutsModalState {
  open: boolean;
}

export const useShortcutsModalStore = create<ShortcutsModalState>(() => ({
  open: false,
}));

export function toggleShortcutsModal(): void {
  useShortcutsModalStore.setState((s) => ({ open: !s.open }));
}

export function openShortcutsModal(): void {
  useShortcutsModalStore.setState({ open: true });
}

export function closeShortcutsModal(): void {
  useShortcutsModalStore.setState({ open: false });
}
