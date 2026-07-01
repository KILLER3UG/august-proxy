import { motion } from 'framer-motion';
import type { LiveState } from './useLiveSession';

interface LiveOrbProps {
  state: LiveState;
  reducedMotion?: boolean;
}

const STATE_COLOR: Record<LiveState, string> = {
  'idle': 'bg-muted-foreground/30',
  'listening': 'bg-primary',
  'thinking': 'bg-warning',
  'tool-running': 'bg-warning',
  'awaiting-approval': 'bg-danger',
  'speaking': 'bg-success',
};

export function LiveOrb({ state, reducedMotion }: LiveOrbProps) {
  const color = STATE_COLOR[state] ?? 'bg-muted-foreground/30';

  if (reducedMotion) {
    return (
      <div
        data-testid="live-orb"
        data-state={state}
        className="relative size-32 rounded-full border-4 border-border flex items-center justify-center"
      >
        <div className={`size-16 rounded-full ${color}`} />
        <span className="absolute left-0 right-0 -bottom-6 text-center text-xs text-muted-foreground">{state}</span>
      </div>
    );
  }

  return (
    <div data-testid="live-orb" data-state={state} className="relative">
      <motion.div
        className={`size-32 rounded-full ${color}`}
        animate={{
          scale: state === 'listening' || state === 'speaking' ? [1, 1.1, 1] : 1,
          opacity: state === 'thinking' || state === 'tool-running' ? [0.6, 1, 0.6] : 1,
        }}
        transition={{
          duration: state === 'listening' || state === 'speaking' ? 1.5 : 1.2,
          repeat: state === 'idle' ? 0 : Infinity,
        }}
      />
      <span className="absolute left-0 right-0 -bottom-6 text-center text-xs text-muted-foreground">
        {state}
      </span>
    </div>
  );
}
