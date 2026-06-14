import { atom } from 'nanostores';

const STORAGE_KEY = 'august-theme';
const initial = (localStorage.getItem(STORAGE_KEY) ?? 'dark') as 'light' | 'dark';
if (typeof document !== 'undefined') {
  document.documentElement.classList.toggle('dark', initial === 'dark');
}

export const $theme = atom<'light' | 'dark'>(initial);

export function toggleTheme() {
  const next = $theme.get() === 'dark' ? 'light' : 'dark';
  $theme.set(next);
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', next === 'dark');
    localStorage.setItem(STORAGE_KEY, next);
  }
}
