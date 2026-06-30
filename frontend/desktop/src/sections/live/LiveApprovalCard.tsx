import { ShieldAlert } from 'lucide-react';
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
      className="bg-card border-2 border-warning rounded-lg p-4 shadow-xl max-w-md mx-auto"
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
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              onClick={() => onApprove(mutation.id)}
              className="px-3 py-1.5 text-xs rounded bg-success text-success-foreground hover:opacity-90"
              data-testid="approve"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => onDeny(mutation.id)}
              className="px-3 py-1.5 text-xs rounded bg-muted text-foreground hover:opacity-90"
              data-testid="deny"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={() => onVoiceConfirm(mutation.id)}
              className="px-3 py-1.5 text-xs rounded text-muted-foreground hover:text-foreground"
              data-testid="voice-confirm"
            >
              voice confirm (placeholder)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
