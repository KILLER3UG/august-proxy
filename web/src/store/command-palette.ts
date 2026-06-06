import { atom } from 'nanostores';
export const $commandPaletteOpen = atom(false);
export function toggleCommandPalette() { $commandPaletteOpen.set(!$commandPaletteOpen.get()); }
export function openCommandPalette()  { $commandPaletteOpen.set(true); }
export function closeCommandPalette() { $commandPaletteOpen.set(false); }
