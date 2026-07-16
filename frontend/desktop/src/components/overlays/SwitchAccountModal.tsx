import { Check, X } from 'lucide-react';
import { SiGoogle } from 'react-icons/si';
import { useState } from 'react';
import { toast } from 'sonner';
import { Backdrop } from '@/components/overlays/Backdrop';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  useAccountStore,
  switchAccount,
  type AugustAccount,
} from '@/store/account';
import { signInWithGoogle } from '@/lib/google-account-signin';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreateNew: () => void;
}

export function SwitchAccountModal({ open, onClose, onCreateNew }: Props) {
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const [googleBusy, setGoogleBusy] = useState(false);

  if (!open) return null;

  const pick = (account: AugustAccount) => {
    switchAccount(account.id);
    onClose();
  };

  const handleGoogle = async () => {
    setGoogleBusy(true);
    try {
      const account = await signInWithGoogle();
      toast.success(`Signed in as ${account.displayName}`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setGoogleBusy(false);
    }
  };

  return (
    <Backdrop onClose={onClose}>
      <div
        className="relative w-[min(92vw,360px)] overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Switch account"
      >
        <header className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Switch account</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Choose a profile or sign in with Google
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition"
            aria-label="Close"
          >
            <X className="size-3.5" />
          </button>
        </header>

        <div className="max-h-[50vh] space-y-1 overflow-y-auto px-3 py-3">
          {accounts.map((account) => {
            const active = account.id === activeAccountId;
            return (
              <button
                key={account.id}
                type="button"
                onClick={() => pick(account)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition',
                  active ? 'bg-primary/10' : 'hover:bg-accent/70',
                )}
              >
                <Avatar className="size-9 border border-border">
                  <AvatarImage src={account.avatar} alt={account.displayName} />
                  <AvatarFallback>{account.initials}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {account.displayName}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{account.username}</p>
                </div>
                {active && <Check className="size-4 text-primary" />}
              </button>
            );
          })}
          {accounts.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              No accounts yet. Sign in with Google to get started.
            </p>
          )}
        </div>

        <footer className="space-y-2 border-t border-border/60 px-5 py-3">
          <Button
            type="button"
            className="w-full gap-2"
            disabled={googleBusy}
            onClick={() => void handleGoogle()}
          >
            <SiGoogle className="size-3.5" />
            {googleBusy ? 'Waiting for Google…' : 'Continue with Google'}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => {
              onClose();
              onCreateNew();
            }}
          >
            Create local account
          </Button>
        </footer>
      </div>
    </Backdrop>
  );
}
