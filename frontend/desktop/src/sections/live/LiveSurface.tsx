import { useEffect, useRef } from 'react';
import { X, Mic, MicOff } from 'lucide-react';
import { useLiveSession } from './useLiveSession';
import { LiveOrb } from './LiveOrb';
import { LiveCaptions } from './LiveCaptions';
import { LiveToolRail } from './LiveToolRail';
import { LiveApprovalCard } from './LiveApprovalCard';
import { LiveControls } from './LiveControls';
import { Button } from '@/components/ui/button';
import { useReducedMotion } from '@/lib/motion';
import { liveClient } from '@/api/liveClient';
import { getLiveConfig } from '@/api/api-client';
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
  // Audit P2#18 — the sanctioned reduced-motion read (lib/motion.ts), which
  // replaces the hand-rolled matchMedia subscription this component used to
  // own. It reads the preference once instead of tracking OS flips; the orb
  // is re-created with the rest of the Live surface, so the difference was
  // never visible here.
  const reducedMotion = useReducedMotion();
  const sessionIdRef = useRef<string>('');
  const sttRef = useRef<LiveSTT | null>(null);
  const ttsRef = useRef<LiveTTS | null>(null);

  // Push prop-supplied pending mutations into the session queue
  useEffect(() => {
    pendingMutations.forEach((m) => session.addPendingMutation(m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMutations]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      void sttRef.current?.stop();
      void ttsRef.current?.cancel();
    };
  }, []);

  const startListening = async () => {
    if (session.state !== 'idle') return;
    sessionIdRef.current = sessionIdRef.current || (await liveClient.startSession());
    // Stop whatever the previous run left holding the microphone. The error
    // path below idles the session WITHOUT stopping its STT, so a fresh click
    // used to build a second capture (and a second getUserMedia stream) on top
    // of the half-dead one — one leaked mic session per click.
    void sttRef.current?.stop();
    void ttsRef.current?.cancel();
    // Prefer browser speech; only use server STT/TTS when Settings mark them ready.
    let sttReady = false;
    let ttsReady = false;
    try {
      const liveCfg = await getLiveConfig();
      sttReady = Boolean(liveCfg.sttReady);
      ttsReady = Boolean(liveCfg.ttsReady);
    } catch {
      /* browser defaults */
    }
    const stt = liveSTTFactory({ serverConfigured: sttReady });
    const tts = liveTTSFactory({ serverConfigured: ttsReady });
    sttRef.current = stt;
    ttsRef.current = tts;

    stt.onPartial((text) => {
      // Barge-in: if the user starts talking while TTS is speaking, cancel TTS.
      if (session.state === 'speaking') {
        tts.cancel();
      }
      session.onPartial(text);
    });
    stt.onFinal((text) => {
      void (async () => {
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
      })();
    });
    stt.onError((err) => {
      session.addToolEvent({
        id: `e-${Date.now()}`,
        name: 'stt_error',
        args: { message: err.message },
        status: 'error',
      });
      // session.stop() alone only resets state — the capture kept running,
      // so the next Start built a second one on top of it (the leak).
      session.stop();
      void stt.stop();
      void tts.cancel();
      sttRef.current = null;
      ttsRef.current = null;
    });

    session.start();
    await stt.start();
  };

  return (
    <div
      className="h-full w-full flex flex-col bg-background"
      data-testid="live-surface"
    >
      {/* Top bar. This is a MODE, not a page (the chat stays visible behind
          it), so it keeps its own bar rather than taking a page header —
          see the header grammar note in sections/learning/LearningHub.tsx.
          The bar itself is muted: a quiet label, a borderless icon button. */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Live voice</span>
          {/* Mute is a mic-only state (capture stops; TTS playback is separate)
              and used to be visible ONLY as the Mute/Unmute label swap on the
              small bottom button — while looking at the orb you could not tell
              the session was muted at all. The badge sits where the eye is. */}
          {session.isMuted && (
            <span
              data-testid="live-muted-badge"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-warning bg-warning/10"
            >
              <MicOff className="size-3" aria-hidden />
              Muted
            </span>
          )}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close"
          onClick={onSwitchToChat}
        >
          <X className="size-4" />
        </Button>
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
            <Button
              size="lg"
              className="rounded-full"
              data-testid="start-listening"
              onClick={() => { void startListening(); }}
            >
              <Mic className="size-4" />
              Start listening
            </Button>
          )}

          {session.pendingMutations.length > 0 && (
            <div className="flex w-full max-w-lg flex-col gap-2">
              {session.pendingMutations.length > 1 && (
                <p className="text-center text-xs text-warning">
                  {session.pendingMutations.length} changes need approval
                </p>
              )}
              {session.pendingMutations.map((mutation) => (
                <LiveApprovalCard
                  key={mutation.id}
                  mutation={mutation}
                  onApprove={session.approve}
                  onDeny={session.deny}
                  onVoiceConfirm={session.approve}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Bottom controls */}
      <div className="flex items-center justify-center p-4 border-t border-border">
        <LiveControls
          isMuted={session.isMuted}
          onToggleMute={() => {
            // Toggle the underlying audio capture directly; the hook's
            // isMuted state updates through toggleMute() but we don't
            // read it back here to avoid a stale-closure on `session`.
            if (sttRef.current) {
              if (session.isMuted) void sttRef.current.start();
              else void sttRef.current.stop();
            }
            session.toggleMute();
          }}
          onEnd={() => {
            session.stop();
            void sttRef.current?.stop();
            void ttsRef.current?.cancel();
            if (sessionIdRef.current) void liveClient.stopSession(sessionIdRef.current);
            onSwitchToChat();
          }}
          onSwitchToChat={onSwitchToChat}
        />
      </div>
    </div>
  );
}
