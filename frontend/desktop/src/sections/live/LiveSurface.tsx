import { useState, useEffect, useRef } from 'react';
import { X, Mic } from 'lucide-react';
import { useLiveSession } from './useLiveSession';
import { LiveOrb } from './LiveOrb';
import { LiveCaptions } from './LiveCaptions';
import { LiveToolRail } from './LiveToolRail';
import { LiveApprovalCard } from './LiveApprovalCard';
import { LiveControls } from './LiveControls';
import { liveClient } from '@/api/liveClient';
import { liveSTTFactory } from '@/api/speech/liveSTT';
import { liveTTSFactory } from '@/api/speech/liveTTS';
import type { LiveSTT } from '@/api/speech/liveSTT';
import type { LiveTTS } from '@/api/speech/liveTTS';
import type { PendingMutation } from './useLiveSession';

interface LiveSurfaceProps {
  onSwitchToChat: () => void;
  pendingMutations?: PendingMutation[];
}

export function LiveSurface({ onSwitchToChat, pendingMutations = [] }: LiveSurfaceProps) {
  const session = useLiveSession();
  const [reducedMotion, setReducedMotion] = useState(false);
  const sessionIdRef = useRef<string>('');
  const sttRef = useRef<LiveSTT | null>(null);
  const ttsRef = useRef<LiveTTS | null>(null);

  // Reduced-motion preference (feature-detect for jsdom)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Push prop-supplied pending mutations into the session queue
  useEffect(() => {
    pendingMutations.forEach((m) => session.addPendingMutation(m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMutations]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      sttRef.current?.stop();
      ttsRef.current?.cancel();
    };
  }, []);

  const startListening = async () => {
    if (session.state !== 'idle') return;
    sessionIdRef.current = sessionIdRef.current || (await liveClient.startSession());
    const stt = liveSTTFactory();
    const tts = liveTTSFactory();
    sttRef.current = stt;
    ttsRef.current = tts;

    stt.onPartial((text) => {
      // Barge-in: if the user starts talking while TTS is speaking, cancel TTS.
      if (session.state === 'speaking') {
        tts.cancel();
      }
      session.onPartial(text);
    });
    stt.onFinal(async (text) => {
      session.onFinal(text);
      const turnId = `t-${Date.now()}`;
      session.addToolEvent({
        id: turnId,
        name: 'turn',
        args: { transcript: text },
        status: 'running',
      });
      const response = await liveClient.sendTurn(sessionIdRef.current, text);
      if (response) {
        await tts.speak(response);
        session.updateToolEvent(turnId, { status: 'done', result: response });
      } else {
        session.updateToolEvent(turnId, { status: 'error' });
      }
    });
    stt.onError((err) => {
      session.addToolEvent({
        id: `e-${Date.now()}`,
        name: 'stt_error',
        args: { message: err.message },
        status: 'error',
      });
      session.stop();
    });

    session.start();
    await stt.start();
  };

  return (
    <div
      className="h-full w-full flex flex-col bg-background"
      data-testid="live-surface"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="text-sm font-medium">August Live</div>
        <button
          type="button"
          aria-label="Close"
          onClick={onSwitchToChat}
          className="p-1 rounded hover:bg-muted"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Body: tool rail | main */}
      <div className="flex-1 flex min-h-0">
        <aside className="w-56 border-r border-border overflow-y-auto">
          <LiveToolRail events={session.toolEvents} />
        </aside>

        <main className="flex-1 flex flex-col items-center justify-center gap-6 p-6 min-h-0">
          <LiveOrb state={session.state} reducedMotion={reducedMotion} />
          <LiveCaptions partial={session.partialTranscript} transcript={session.transcript} />

          {session.state === 'idle' && (
            <button
              type="button"
              data-testid="start-listening"
              onClick={startListening}
              className="px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm hover:opacity-90"
            >
              <Mic className="size-4 inline mr-2" />
              Start listening
            </button>
          )}

          {session.pendingMutations[0] && (
            <LiveApprovalCard
              mutation={session.pendingMutations[0]}
              onApprove={session.approve}
              onDeny={session.deny}
              onVoiceConfirm={session.approve}
            />
          )}
        </main>
      </div>

      {/* Bottom controls */}
      <div className="flex items-center justify-center p-4 border-t border-border">
        <LiveControls
          isMuted={session.isMuted}
          continuousMode={false}
          onToggleMute={() => {
            // Toggle the underlying audio capture directly; the hook's
            // isMuted state updates through toggleMute() but we don't
            // read it back here to avoid a stale-closure on `session`.
            if (sttRef.current) {
              if (session.isMuted) sttRef.current.start();
              else sttRef.current.stop();
            }
            session.toggleMute();
          }}
          onEnd={() => {
            session.stop();
            sttRef.current?.stop();
            ttsRef.current?.cancel();
            if (sessionIdRef.current) liveClient.stopSession(sessionIdRef.current);
            onSwitchToChat();
          }}
          onToggleContinuous={() => {}}
          onSwitchToChat={onSwitchToChat}
        />
      </div>
    </div>
  );
}
