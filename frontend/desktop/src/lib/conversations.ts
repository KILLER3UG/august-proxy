/* ── Conversation scripts for the launch / update animation ─────────── */
/* Pure data + a picker. The launch conversation is randomized from a pool */
/* of scripts so it reads differently each time; the update conversation   */
/* reuses the same beat model but is fed from the real changelog.          */

export type Beat =
  | { role: 'user'; text: string }
  | {
      role: 'assistant';
      text: string;
      /** Render a live status row under the text (launch only) — shows the */
      /** real backend phase while loading, flips to a green check on ready. */
      live?: boolean;
      /** Compact bullet list rendered under the text (update conversation). */
      bullets?: string[];
      /** Hold this beat until the backend is ready (the closing line). */
      gate?: 'ready';
    };

export interface ConversationScript {
  id: string;
  beats: Beat[];
}

/** 12 launch conversations about opening the app. Each ends on a `gate` */
/** beat so the closing line only lands when the backend is actually up. */
export const LAUNCH_SCRIPTS: ConversationScript[] = [
  {
    id: 'l1',
    beats: [
      { role: 'user', text: 'morning — spin it up' },
      { role: 'assistant', text: 'On it. Copying the runtime and waking the proxy.', live: true },
      { role: 'user', text: 'any blockers?' },
      { role: 'assistant', text: 'None — health check passed. You’re clear to chat.', gate: 'ready' },
    ],
  },
  {
    id: 'l2',
    beats: [
      { role: 'user', text: 'boot it' },
      { role: 'assistant', text: 'Starting the backend now.', live: true },
      { role: 'assistant', text: 'Proxy’s alive. Let’s go.', gate: 'ready' },
    ],
  },
  {
    id: 'l3',
    beats: [
      { role: 'user', text: 'let’s work' },
      { role: 'assistant', text: 'Bringing the local server up.', live: true },
      { role: 'user', text: 'how far along?' },
      { role: 'assistant', text: 'Just finished — everything’s green.', gate: 'ready' },
    ],
  },
  {
    id: 'l4',
    beats: [
      { role: 'user', text: 'open august' },
      { role: 'assistant', text: 'Waking everything up.', live: true },
      { role: 'assistant', text: 'Ready when you are.', gate: 'ready' },
    ],
  },
  {
    id: 'l5',
    beats: [
      { role: 'user', text: 'hey, start up' },
      { role: 'assistant', text: 'Hey — warming the backend.', live: true },
      { role: 'user', text: '👍' },
      { role: 'assistant', text: 'All set. What are we building?', gate: 'ready' },
    ],
  },
  {
    id: 'l6',
    beats: [
      { role: 'user', text: 'fire it up' },
      { role: 'assistant', text: 'Engines on. Loading the runtime.', live: true },
      { role: 'assistant', text: 'Up and healthy — the proxy is listening.', gate: 'ready' },
    ],
  },
  {
    id: 'l7',
    beats: [
      { role: 'user', text: 'good morning' },
      { role: 'assistant', text: 'Morning. Getting the backend on its feet.', live: true },
      { role: 'user', text: 'thanks' },
      { role: 'assistant', text: 'Anytime. Ready to roll.', gate: 'ready' },
    ],
  },
  {
    id: 'l8',
    beats: [
      { role: 'user', text: 'start' },
      { role: 'assistant', text: 'Starting.', live: true },
      { role: 'assistant', text: 'Done — your workspace is loading.', gate: 'ready' },
    ],
  },
  {
    id: 'l9',
    beats: [
      { role: 'user', text: 'let’s get into it' },
      { role: 'assistant', text: 'Provisioning the local proxy.', live: true },
      { role: 'user', text: 'take your time' },
      { role: 'assistant', text: 'No rush needed — we’re already up.', gate: 'ready' },
    ],
  },
  {
    id: 'l10',
    beats: [
      { role: 'user', text: 'wake up, august' },
      { role: 'assistant', text: 'Awake. Booting the backend.', live: true },
      { role: 'assistant', text: 'Fully up. Pick up where you left off.', gate: 'ready' },
    ],
  },
  {
    id: 'l11',
    beats: [
      { role: 'user', text: 'new session — spin it' },
      { role: 'assistant', text: 'Fresh start. Starting the server.', live: true },
      { role: 'user', text: 'cool' },
      { role: 'assistant', text: 'Ready. What’s first?', gate: 'ready' },
    ],
  },
  {
    id: 'l12',
    beats: [
      { role: 'user', text: 'load me in' },
      { role: 'assistant', text: 'Loading — copying files and starting the server.', live: true },
      { role: 'assistant', text: 'In. Everything’s responsive.', gate: 'ready' },
    ],
  },
];

/** Pick a launch script at random (never the same one twice in a row). */
let _lastLaunchId: string | null = null;
export function pickLaunchScript(): ConversationScript {
  let pool = LAUNCH_SCRIPTS;
  if (pool.length > 1 && _lastLaunchId) {
    pool = pool.filter((s) => s.id !== _lastLaunchId);
  }
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  _lastLaunchId = chosen.id;
  return chosen;
}

/* ── Update conversation ────────────────────────────────────────────── */

const UPDATE_INTROS = [
  'what changed while I was away?',
  'give me the update',
  'what’s new?',
  'fill me in',
  'what did I miss?',
  'update me',
  'what’s different now?',
  'what landed?',
  'brief me',
  'anything new since last time?',
  'what got better?',
  'show me the changelog',
];

const UPDATE_LEADS = [
  (v: string) => `Updated to ${v}. The short version:`,
  (v: string) => `You’re on ${v} now — here’s what’s new:`,
  (v: string) => `${v} is in. Highlights:`,
  (v: string) => `Fresh build ${v}. The headlines:`,
  (v: string) => `Welcome back on ${v} — what changed:`,
  (v: string) => `${v} shipped. The quick tour:`,
];

const UPDATE_OUTROS = [
  'anything I need to do?',
  'do I have to do anything?',
  'what do I need to know?',
  'anything for me to do?',
  'should I change anything?',
  'any action needed on my end?',
];

const UPDATE_CLOSERS = [
  'Nothing — you’re on the new build. Open What’s New anytime for the full list.',
  'All set. Full release notes live in What’s New.',
  'No action needed. Tap What’s New for every detail.',
  'You’re good. The complete changelog is one click away in What’s New.',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Build an update conversation from real changelog bullets (already */
/** cleaned, ≤ ~5 short lines). Framing lines are randomized. */
export function buildUpdateScript(version: string, bullets: string[]): ConversationScript {
  const v = version.startsWith('v') ? version : `v${version}`;
  const items = bullets.length ? bullets : ['Performance and reliability improvements.', 'A handful of bug fixes.'];
  return {
    id: `u-${Date.now()}`,
    beats: [
      { role: 'user', text: pick(UPDATE_INTROS) },
      { role: 'assistant', text: pick(UPDATE_LEADS)(v), bullets: items },
      { role: 'user', text: pick(UPDATE_OUTROS) },
      { role: 'assistant', text: pick(UPDATE_CLOSERS), gate: 'ready' },
    ],
  };
}
