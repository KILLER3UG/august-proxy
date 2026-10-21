/* ── circuit-motion ─ the timing vocabulary the 3D board stage animates on ─
 *
 * One place owns every duration and easing curve the circuit stage uses, so
 * the motion can be read, compared and retuned without hunting through the
 * scene graph. The values are measured, not invented: they are the timings a
 * hand-built reference board stage ships with (see docs/ROADMAP.md, the 3D
 * board round) — enter 720 ms on outCubic with a drop and an outBack scale,
 * exit 420 ms on inBack, move 800 ms along an arc, a wire's tube drawing over
 * 620 ms, hover 220 ms, camera 1200 ms with a 4500 ms idle before auto-rotate.
 * Every entry here is read by something: a constant nothing reads is a promise
 * nothing keeps, and this table is where those promises are written down.
 *
 * Reduced motion does not switch the animation off — it runs the same tweens
 * at TWEEN_SPEED below, so a part still arrives at the state the tween was
 * taking it to instead of popping, which is what keeps the end state testable.
 */

export type Easing = (t: number) => number;

export const ease = {
  inOutCubic: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  /** Overshoots, then settles — the curve that makes a part feel placed. */
  outBack: (t: number): number => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  /** The mirror of outBack: leaves fast, so a part being removed looks pulled away. */
  inBack: (t: number): number => 2.70158 * t * t * t - 1.70158 * t * t,
} satisfies Record<string, Easing>;

export const TIMING = {
  /** A part dropping in: staggered per part so the board assembles itself. */
  enter: { ms: 720, curve: ease.outCubic, scaleCurve: ease.outBack },
  /** Per-part stagger between enters. */
  enterStagger: 55,
  /** A part leaving the deck. It collapses where it stood, so the eye can
   *  still connect the disappearance to the object that caused it. */
  exit: { ms: 420, curve: ease.inBack },
  /** A part the deck moved: an arc, not a slide, because a part that glides
   *  along the board looks like it is being dragged across contacts. */
  move: { ms: 800, curve: ease.inOutCubic },
  hover: { ms: 220, curve: ease.outCubic },
  /** A wire's tube drawing itself between its ends. */
  wire: { ms: 620, curve: ease.inOutCubic },
  camera: { ms: 1200, curve: ease.inOutCubic },
  /** Idle before the stage starts turning itself. */
  idleAutoRotateMs: 4500,
} as const;

/** World units (the stage is in mm-ish units, one grid cell = 10). */
export const LIFT = { enter: 4.6, hover: 0.16, moveArc: 1.6 } as const;

/** Multiplier applied to every tween when the OS asks for reduced motion. */
export const TWEEN_SPEED_REDUCED = 0.05;

/** A tween in flight: progress is wall-clock, so a retarget restarts honestly. */
export function tweenProgress(startMs: number, durationMs: number, nowMs: number, speed = 1): number {
  if (durationMs <= 0) return 1;
  const t = ((nowMs - startMs) * speed) / durationMs;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
