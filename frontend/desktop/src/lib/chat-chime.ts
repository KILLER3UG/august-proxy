/* ── Synthesized chat send/receive chimes ───────────────────────────── */
/* Two-note blips via Web Audio — no audio assets to ship. Lazy AudioContext
 * is created on the first user gesture (browser autoplay policy). */

type Note = { freq: number; at: number };

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const Ctx =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

function playChime(notes: Note[], volume: number): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();

  notes.forEach(({ freq, at }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = ctx.currentTime + at;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.2);
  });
}

/** Higher two-note blip — user message sent. */
export function playSendChime(): void {
  playChime(
    [
      { freq: 523.25, at: 0 },
      { freq: 783.99, at: 0.06 },
    ],
    0.05,
  );
}

/** Lower two-note blip — assistant reply arrived. */
export function playReceiveChime(): void {
  playChime(
    [
      { freq: 392.0, at: 0 },
      { freq: 587.33, at: 0.08 },
    ],
    0.05,
  );
}

/** Close the shared AudioContext (tests / hot teardown). */
export function disposeChatChime(): void {
  void audioCtx?.close();
  audioCtx = null;
}
