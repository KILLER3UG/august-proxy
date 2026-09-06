/* ── LaunchConversation — animated chat over the bootstrap gate ─────── */
/* Picks a random launch script and plays it while the backend boots. The */
/* live status row reflects the REAL setup phase, and the closing beat is */
/* gated on `proxyUp`, so the conversation finishes exactly when the load */
/* does — then it calls onDone and the gate reveals the app directly.     */

import { useMemo } from 'react';
import { ConversationStage } from '@/components/overlays/ConversationStage';
import { pickLaunchScript } from '@/lib/conversations';
import type { BackendSetupPhase } from '@/hooks/useBackendSetup';

const PHASE_LABEL: Record<string, string> = {
  idle: 'Starting backend',
  copying: 'Preparing files',
  creating_venv: 'Creating environment',
  installing: 'Installing dependencies',
  starting: 'Starting backend',
  ready: 'Ready',
  error: 'Starting backend',
};

export function LaunchConversation({
  setup,
  proxyUp,
  onDone,
}: {
  setup: BackendSetupPhase;
  proxyUp: boolean;
  onDone: () => void;
}) {
  // Stable for the life of this mount — one conversation per launch.
  const script = useMemo(() => pickLaunchScript(), []);
  const liveLabel = PHASE_LABEL[setup.phase] ?? 'Starting backend';

  return (
    <ConversationStage
      script={script}
      ready={proxyUp}
      revealOnReady
      liveLabel={liveLabel}
      liveDetail={setup.detail ?? undefined}
      onDone={onDone}
      pillText={proxyUp ? 'ready' : 'starting backend'}
      pillState={proxyUp ? 'ok' : 'busy'}
      composerHint={proxyUp ? 'Opening your workspace…' : 'The app opens when the backend is ready…'}
    />
  );
}
