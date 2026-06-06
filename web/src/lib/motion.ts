/* ── Motion presets (Phase 8) ──────────────────────────────────────── */
/* One place to tune the feel of the whole UI. Change the spring/durations
 * here and every animated component picks it up. */

import type { Transition, Variants } from 'framer-motion';

/* Easing curves — kept short and snappy, matching shadcn/Tailwind cadence. */
export const easeOut = [0.16, 1, 0.3, 1] as const;        // expo-out, hero
export const easeInOut = [0.65, 0, 0.35, 1] as const;     // balanced

/* Reusable transitions. */
export const t = {
  fast:    { duration: 0.12, ease: easeOut } satisfies Transition,
  base:    { duration: 0.18, ease: easeOut } satisfies Transition,
  smooth:  { duration: 0.24, ease: easeOut } satisfies Transition,
  spring:  { type: 'spring', stiffness: 380, damping: 32, mass: 0.8 } satisfies Transition,
  springSoft: { type: 'spring', stiffness: 220, damping: 26, mass: 1.0 } satisfies Transition,
};

/* ── Presets used across the app ───────────────────────────────────── */

/* Simple fade + 4px slide — for panels, overlays, sections. */
export const fadeUp: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: t.smooth },
  exit:    { opacity: 0, y: -2, transition: t.fast },
};

/* Pure fade. */
export const fade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: t.base },
  exit:    { opacity: 0, transition: t.fast },
};

/* Container that staggers its children's fadeUp. */
export const stagger = (delay = 0.04, initial = 0.04): Variants => ({
  initial: {},
  animate: { transition: { staggerChildren: delay, delayChildren: initial } },
});

/* Slide in from left (sidebar expand/collapse, drawers). */
export const slideRight: Variants = {
  initial: { opacity: 0, x: -8 },
  animate: { opacity: 1, x: 0, transition: t.smooth },
  exit:    { opacity: 0, x: -6, transition: t.fast },
};

/* Pop in — for chips, badges, status pills. */
export const pop: Variants = {
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1, transition: t.spring },
  exit:    { opacity: 0, scale: 0.96, transition: t.fast },
};

/* ── Hover / tap micro-interactions ────────────────────────────────── */

export const hoverLift = {
  whileHover: { y: -1, transition: t.fast },
  whileTap:   { y:  0, scale: 0.98, transition: t.fast },
};

export const hoverScale = {
  whileHover: { scale: 1.04, transition: t.fast },
  whileTap:   { scale: 0.96, transition: t.fast },
};

/* Active-row indicator (the subtle background pill on a focused nav item). */
export const activeLayout = {
  layoutId: 'active-session-pill',
  transition: t.spring,
};
