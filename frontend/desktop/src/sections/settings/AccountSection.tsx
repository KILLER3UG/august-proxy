/* ── Account — local August profiles (no cloud auth yet) ───────────── */

import { useMemo, useState } from 'react';
import { UserRound, Plus, LogOut, Trash2, Check } from 'lucide-react';
import { toast } from 'sonner';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  useAccountStore,
  createAccount,
  updateAccount,
  switchAccount,
  logoutAccount,
  deleteAccount,
  type AugustAccount,
} from '@/store/account';
import { cn } from '@/lib/utils';

export function AccountSection() {
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const active = useMemo(
    () => accounts.find((a) => a.id === activeAccountId) ?? null,
    [accounts, activeAccountId],
  );

  const [displayName, setDisplayName] = useState(active?.displayName ?? '');
  const [username, setUsername] = useState(active?.username.replace(/^@/, '') ?? '');
  const [email, setEmail] = useState(active?.email ?? '');
  const [avatar, setAvatar] = useState(active?.avatar ?? '');
  const [creating, setCreating] = useState(accounts.length === 0);

  const syncForm = (account: AugustAccount | null) => {
    setDisplayName(account?.displayName ?? '');
    setUsername(account?.username.replace(/^@/, '') ?? '');
    setEmail(account?.email ?? '');
    setAvatar(account?.avatar ?? '');
  };

  const handleSelect = (id: string) => {
    switchAccount(id);
    const next = useAccountStore.getState().accounts.find((a) => a.id === id) ?? null;
    syncForm(next);
    setCreating(false);
    toast.success(`Switched to ${next?.displayName ?? 'account'}`);
  };

  const handleSave = () => {
    const name = displayName.trim();
    if (!name) {
      toast.error('Display name is required');
      return;
    }
    if (creating || !active) {
      const created = createAccount({ displayName: name, username, email, avatar });
      syncForm(created);
      setCreating(false);
      toast.success('Account created');
      return;
    }
    const updated = updateAccount(active.id, {
      displayName: name,
      username,
      email,
      avatar,
    });
    if (updated) {
      syncForm(updated);
      toast.success('Account saved');
    }
  };

  const handleLogout = () => {
    logoutAccount();
    syncForm(null);
    setCreating(true);
    toast.message('Signed out of local account');
  };

  const handleDelete = (id: string) => {
    if (!confirm('Delete this local account? This cannot be undone.')) return;
    deleteAccount(id);
    const nextActive = useAccountStore.getState().accounts.find(
      (a) => a.id === useAccountStore.getState().activeAccountId,
    ) ?? null;
    syncForm(nextActive);
    setCreating(useAccountStore.getState().accounts.length === 0);
    toast.message('Account deleted');
  };

  const formTitle = creating || !active ? 'Create account' : 'Edit account';

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-5 pb-4 shrink-0">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">Account</h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          Local August profiles on this device. Cloud sign-in is not required yet —
          your account stays on this machine.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 pb-6 space-y-4">
        <SettingsCard
          icon={UserRound}
          title="Profiles on this device"
          description="Switch between local accounts or create a new one."
          actions={
            <Badge variant="outline" className="font-mono">
              {accounts.length} profile{accounts.length === 1 ? '' : 's'}
            </Badge>
          }
          inert
        >
          <div className="space-y-2">
            {accounts.map((account) => {
              const isActive = account.id === activeAccountId;
              return (
                <div
                  key={account.id}
                  className={cn(
                    'flex items-center gap-3 rounded-xl border px-3 py-2.5 transition',
                    isActive
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border/70 bg-muted/20 hover:bg-muted/40',
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    onClick={() => handleSelect(account.id)}
                  >
                    <Avatar className="size-9 border border-border">
                      <AvatarImage src={account.avatar} alt={account.displayName} />
                      <AvatarFallback>{account.initials}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {account.displayName}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {account.username}
                        {account.email ? ` · ${account.email}` : ''}
                      </p>
                    </div>
                  </button>
                  {isActive && (
                    <Check className="size-4 shrink-0 text-primary" aria-label="Active" />
                  )}
                  <button
                    type="button"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition"
                    title="Delete account"
                    onClick={() => handleDelete(account.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })}

            {accounts.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No accounts yet. Create one below to personalize the sidebar menu.
              </p>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1"
              onClick={() => {
                setCreating(true);
                setDisplayName('');
                setUsername('');
                setEmail('');
                setAvatar('');
              }}
            >
              <Plus className="size-3.5" />
              New account
            </Button>
          </div>
        </SettingsCard>

        <SettingsCard
          icon={UserRound}
          title={formTitle}
          description="Name and avatar appear in the Settings menu."
          inert
        >
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Avatar className="size-12 border border-border">
                <AvatarImage src={avatar || undefined} alt={displayName || 'Avatar'} />
                <AvatarFallback>
                  {(displayName || 'AU').slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                Paste an image URL for your avatar, or leave blank for the default.
              </div>
            </div>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Display name</span>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Username</span>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="august"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Email (optional)</span>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Avatar URL</span>
              <Input
                value={avatar}
                onChange={(e) => setAvatar(e.target.value)}
                placeholder="https://…"
              />
            </label>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="button" onClick={handleSave}>
                {creating || !active ? 'Create account' : 'Save changes'}
              </Button>
              {active && !creating && (
                <Button type="button" variant="outline" onClick={handleLogout}>
                  <LogOut className="size-3.5" />
                  Sign out
                </Button>
              )}
            </div>
          </div>
        </SettingsCard>
      </div>
    </div>
  );
}
