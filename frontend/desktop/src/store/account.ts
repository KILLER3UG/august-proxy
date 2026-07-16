/* ── Local August account (no cloud auth yet) ───────────────────────── */
/* Profiles live in localStorage. Multiple accounts can exist; one is
 * active. Logout clears the active selection without deleting profiles. */

import { create } from 'zustand';
import type { UserStatus } from '@/components/ui/user-dropdown';

export interface AugustAccount {
  id: string;
  displayName: string;
  username: string;
  email: string;
  avatar: string;
  initials: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

interface AccountState {
  accounts: AugustAccount[];
  activeAccountId: string | null;
}

const STORAGE_KEY = 'august-accounts-v1';
const ACTIVE_KEY = 'august-active-account';

const DEFAULT_AVATAR =
  'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&fit=crop&crop=face';

function loadAccounts(): AugustAccount[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AugustAccount[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadActiveId(accounts: AugustAccount[]): string | null {
  if (typeof localStorage === 'undefined') return null;
  const saved = localStorage.getItem(ACTIVE_KEY);
  if (saved && accounts.some((a) => a.id === saved)) return saved;
  return accounts[0]?.id ?? null;
}

function persist(accounts: AugustAccount[], activeAccountId: string | null) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
  if (activeAccountId) localStorage.setItem(ACTIVE_KEY, activeAccountId);
  else localStorage.removeItem(ACTIVE_KEY);
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'AU';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

function normalizeUsername(raw: string, fallbackName: string): string {
  const cleaned = raw.trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (cleaned) return `@${cleaned.toLowerCase()}`;
  const fromName = fallbackName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || 'august';
  return `@${fromName}`;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `acct_${Date.now().toString(36)}`;
}

const initialAccounts = loadAccounts();

export const useAccountStore = create<AccountState>(() => ({
  accounts: initialAccounts,
  activeAccountId: loadActiveId(initialAccounts),
}));

export function getActiveAccount(): AugustAccount | null {
  const { accounts, activeAccountId } = useAccountStore.getState();
  return accounts.find((a) => a.id === activeAccountId) ?? null;
}

export type CreateAccountInput = {
  displayName: string;
  username?: string;
  email?: string;
  avatar?: string;
  status?: UserStatus;
};

export function createAccount(input: CreateAccountInput): AugustAccount {
  const now = new Date().toISOString();
  const displayName = input.displayName.trim() || 'August User';
  const account: AugustAccount = {
    id: newId(),
    displayName,
    username: normalizeUsername(input.username ?? '', displayName),
    email: (input.email ?? '').trim(),
    avatar: (input.avatar ?? '').trim() || DEFAULT_AVATAR,
    initials: initialsFromName(displayName),
    status: input.status ?? 'online',
    createdAt: now,
    updatedAt: now,
  };
  const accounts = [...useAccountStore.getState().accounts, account];
  useAccountStore.setState({ accounts, activeAccountId: account.id });
  persist(accounts, account.id);
  return account;
}

export function updateAccount(
  id: string,
  patch: Partial<Omit<AugustAccount, 'id' | 'createdAt'>>,
): AugustAccount | null {
  const { accounts, activeAccountId } = useAccountStore.getState();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const prev = accounts[idx];
  const displayName = patch.displayName?.trim() || prev.displayName;
  const next: AugustAccount = {
    ...prev,
    ...patch,
    displayName,
    username: patch.username != null
      ? normalizeUsername(patch.username, displayName)
      : prev.username,
    email: patch.email != null ? patch.email.trim() : prev.email,
    avatar: patch.avatar != null ? (patch.avatar.trim() || DEFAULT_AVATAR) : prev.avatar,
    initials: patch.displayName != null ? initialsFromName(displayName) : prev.initials,
    updatedAt: new Date().toISOString(),
  };
  const updated = accounts.slice();
  updated[idx] = next;
  useAccountStore.setState({ accounts: updated, activeAccountId });
  persist(updated, activeAccountId);
  return next;
}

export function switchAccount(id: string): boolean {
  const { accounts } = useAccountStore.getState();
  if (!accounts.some((a) => a.id === id)) return false;
  useAccountStore.setState({ activeAccountId: id });
  persist(accounts, id);
  return true;
}

export function logoutAccount(): void {
  const { accounts } = useAccountStore.getState();
  useAccountStore.setState({ activeAccountId: null });
  persist(accounts, null);
}

export function deleteAccount(id: string): void {
  const { accounts, activeAccountId } = useAccountStore.getState();
  const next = accounts.filter((a) => a.id !== id);
  const nextActive =
    activeAccountId === id ? (next[0]?.id ?? null) : activeAccountId;
  useAccountStore.setState({ accounts: next, activeAccountId: nextActive });
  persist(next, nextActive);
}

export function setAccountStatus(status: UserStatus): void {
  const active = getActiveAccount();
  if (!active) return;
  updateAccount(active.id, { status });
}

export const GUEST_ACCOUNT_VIEW = {
  name: 'Guest',
  username: '@guest',
  avatar: DEFAULT_AVATAR,
  initials: 'G',
  status: 'online' as UserStatus,
};
