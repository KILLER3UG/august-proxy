/* ── host.ts — which host mounted a learning surface ───────────────────── */
/* Four sections render in TWO places: the Settings panel (`/settings/<id>`,
 * behind the settings rail) and the Learning hub (`/learning`, one tab each).
 * That double mount is the reason this file exists.
 *
 * The rule the two hosts agree on: ONE shape. A section renders the same
 * header, the same rows and the same actions in both hosts, because the nav
 * in front of it carries the icon and the name in both hosts (the settings
 * rail and the hub's own rail are the same instrument). A component that
 * renders differently depending on which host mounted it is a defect — the
 * difference used to be implicit, spread across four files, and visible as
 * "the same page looks different depending on how I got here".
 *
 * The ONE difference that survives is a LINK that leaves the surface: a
 * cross-reference to another learning surface has to land on that surface in
 * the host the reader is in. It is named here rather than inferred from a
 * prop value deep in a tree, so a second host cannot appear by accident. */

export type LearningHost = 'settings' | 'hub';

/** Where the Review Inbox lives, per host. The skills detail links to it,
 *  and a link that leaves the surface must land in the SAME host the reader
 *  is in — otherwise the Learning hub throws you into the Settings overlay
 *  and the hub context is gone. */
export function inboxRoute(host: LearningHost): string {
  return host === 'hub' ? '/learning?tab=inbox' : '/settings/skills';
}
