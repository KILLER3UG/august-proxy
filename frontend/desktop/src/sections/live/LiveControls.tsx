import { MicOff, Mic, PhoneOff, MessageSquare } from 'lucide-react';

interface LiveControlsProps {
  isMuted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
  onSwitchToChat: () => void;
}

export function LiveControls({
  isMuted,
  onToggleMute,
  onEnd,
  onSwitchToChat,
}: LiveControlsProps) {
  return (
    <div
      className="bg-card border border-border rounded-full px-3 py-2 flex items-center gap-2 shadow-lg"
      data-testid="live-controls"
    >
      <button
        type="button"
        onClick={onToggleMute}
        aria-pressed={isMuted}
        aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
        className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted"
      >
        {isMuted ? <MicOff className="size-3" /> : <Mic className="size-3" />}
        <span>{isMuted ? 'Unmute' : 'Mute'}</span>
      </button>

      <button
        type="button"
        onClick={onEnd}
        aria-label="End session"
        className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-danger/20 text-danger"
      >
        <PhoneOff className="size-3" />
        <span>End</span>
      </button>

      <button
        type="button"
        onClick={onSwitchToChat}
        aria-label="Switch to chat"
        className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-muted"
      >
        <MessageSquare className="size-3" />
        <span>Switch to chat</span>
      </button>
    </div>
  );
}
