import { MicOff, Mic, PhoneOff, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
      {/* The three controls are the shared Button primitive, not hand-rolled
          pills: the focus ring, the variant scale and the icon sizing are
          the same everywhere else in the app. */}
      <Button
        variant="ghost"
        onClick={onToggleMute}
        aria-pressed={isMuted}
        aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
      >
        {isMuted ? <MicOff className="size-3" /> : <Mic className="size-3" />}
        <span>{isMuted ? 'Unmute' : 'Mute'}</span>
      </Button>

      <Button
        variant="ghost"
        onClick={onEnd}
        aria-label="End session"
        className="text-danger hover:bg-danger/20"
      >
        <PhoneOff className="size-3" />
        <span>End</span>
      </Button>

      <Button variant="ghost" onClick={onSwitchToChat} aria-label="Switch to chat">
        <MessageSquare className="size-3" />
        <span>Switch to chat</span>
      </Button>
    </div>
  );
}
