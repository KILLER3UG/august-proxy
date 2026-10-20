import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PendingMutation } from './useLiveSession';

interface LiveApprovalCardProps {
  mutation: PendingMutation;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onVoiceConfirm: (id: string) => void;
}

export function LiveApprovalCard({ mutation, onApprove, onDeny, onVoiceConfirm }: LiveApprovalCardProps) {
  return (
    <div
      className="bg-card border border-warning/60 rounded-lg p-4 shadow-md max-w-md mx-auto"
      role="alertdialog"
      aria-live="assertive"
      data-testid="live-approval-card"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="size-5 text-warning shrink-0" />
        <div className="flex-1">
          <div className="text-sm font-medium">Allow {mutation.description}?</div>
          {mutation.spokenPrompt && (
            <div className="text-xs text-muted-foreground italic mt-1">
              spoken: "{mutation.spokenPrompt}"
            </div>
          )}
          {/* The shared Button primitive: one primary action (approve), one
              quiet secondary (deny), one placeholder kept out of the way. */}
          <div className="flex gap-2 mt-3">
            <Button size="sm" onClick={() => onApprove(mutation.id)} data-testid="approve">
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => onDeny(mutation.id)} data-testid="deny">
              Deny
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => onVoiceConfirm(mutation.id)}
              data-testid="voice-confirm"
            >
              voice confirm (placeholder)
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
