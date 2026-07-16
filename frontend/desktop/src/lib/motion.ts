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

/* Session row leave — snappy slide-out so deletes feel real-time. */
export const sessionRow: Variants = {
  initial: { opacity: 0, x: -6, height: 0 },
  animate: {
    opacity: 1,
    x: 0,
    height: 'auto',
    transition: t.fast,
  },
  exit: {
    opacity: 0,
    x: -16,
    height: 0,
    marginTop: 0,
    marginBottom: 0,
    scale: 0.98,
    transition: { duration: 0.12, ease: easeOut },
  },
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

/* Chat bubble enter — smooth rise + fade (user send / assistant land). */
export const messagePop = {
  initial: { opacity: 0, y: 14, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -6, scale: 0.98 },
  transition: {
    opacity: { duration: 0.32, ease: easeOut },
    y: { type: 'spring', stiffness: 260, damping: 28, mass: 0.85 },
    scale: { type: 'spring', stiffness: 280, damping: 30, mass: 0.85 },
  } satisfies Transition,
};

/** Slightly softer path used for the user’s own bubble. */
export const userMessagePop = {
  initial: { opacity: 0, y: 18, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -4, scale: 0.98 },
  transition: {
    opacity: { duration: 0.38, ease: easeOut },
    y: { type: 'spring', stiffness: 220, damping: 26, mass: 0.95 },
    scale: { type: 'spring', stiffness: 240, damping: 28, mass: 0.95 },
  } satisfies Transition,
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

/* Composer chips (agent mode / model) — light lift on hover. */
export const chipTrigger = {
  whileHover: { scale: 1.03, y: -1, transition: t.fast },
  whileTap: { scale: 0.97, transition: t.fast },
};

/* Dropdown / flyout panel enter-exit (settings, agent, model menus). */
export const menuPanel = {
  initial: { opacity: 0, y: 8, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 6, scale: 0.97 },
  transition: {
    duration: 0.18,
    ease: easeOut,
  } satisfies Transition,
};

/* Side flyouts (effort / models / agent options) slide from the left edge. */
export const menuFlyout = {
  initial: { opacity: 0, x: -8, scale: 0.97 },
  animate: { opacity: 1, x: 0, scale: 1 },
  exit: { opacity: 0, x: -6, scale: 0.98 },
  transition: {
    duration: 0.16,
    ease: easeOut,
  } satisfies Transition,
};

/* Stagger menu rows when a panel opens. */
export const menuItemStagger: Variants = {
  initial: {},
  animate: {
    transition: { staggerChildren: 0.035, delayChildren: 0.045 },
  },
};

export const menuItem: Variants = {
  initial: { opacity: 0, x: -8 },
  animate: {
    opacity: 1,
    x: 0,
    transition: t.fast,
  },
};

export const menuItemHover = {
  whileHover: { x: 3, transition: t.fast },
  whileTap: { scale: 0.98, transition: t.fast },
};

/* Active-row indicator (the subtle background pill on a focused nav item). */
export const activeLayout = {
  layoutId: 'active-session-pill',
  transition: t.spring,
};
