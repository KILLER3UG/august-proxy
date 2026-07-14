import { create } from 'zustand';

interface CommandPaletteState {
  open: boolean;
}

export const useCommandPaletteStore = create<CommandPaletteState>(() => ({
  open: false,
}));

/** Nanostores-shaped shim for imperative get/set callers. */
export const $commandPaletteOpen = {
  get: (): boolean => useCommandPaletteStore.getState().open,
  set: (open: boolean): void => {
    useCommandPaletteStore.setState({ open });
  },
  subscribe: (listener: (open: boolean) => void): (() => void) => {
    listener(useCommandPaletteStore.getState().open);
    return useCommandPaletteStore.subscribe((s) => listener(s.open));
  },
};

export function toggleCommandPalette(): void {
  useCommandPaletteStore.setState((s) => ({ open: !s.open }));
}

export function openCommandPalette(): void {
  useCommandPaletteStore.setState({ open: true });
}

export function closeCommandPalette(): void {
  useCommandPaletteStore.setState({ open: false });
}
