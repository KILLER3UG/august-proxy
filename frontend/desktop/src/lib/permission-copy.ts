/* ── Shared permission / approval copy ────────────────────────────────── */
/* Cursor-style “Permission required” card + legacy toast aliases.         */

export const PERMISSION_COPY = {
  title: 'Permission required',
  awaiting: 'Awaiting approval',
  allow: 'Allow',
  allowHint: 'Allow only this time',
  always: 'Always allow in this project',
  alwaysHint: 'Do not ask again for the same command',
  deny: 'Deny',
  denyHint: 'Reject it for now',
  confirmHint: 'Click Allow, Always, or Deny — or use ↑↓ and Enter',
  confirm: 'Confirm',
  /** @deprecated Prefer `allow` — kept for PermissionToast */
  once: 'Allow',
  onceHint: 'Allow only this time',
  session: 'This chat',
  sessionHint: 'Allow for the rest of this conversation',
  reject: 'Deny',
  rejectHint: 'Reject it for now',
  subtitle: 'Choose how long similar permissions last.',
  preApply: 'Permission required',
  terminalTitle: 'Permission required',
  terminalSubtitle: 'Allow · Always in this project · Deny',
} as const;

export type PermissionCopyKey = keyof typeof PERMISSION_COPY;
