/* ── Shared permission / approval copy ────────────────────────────────── */
/* Cursor-style “Permission required” card + legacy toast aliases.         */

export const PERMISSION_COPY = {
  title: 'Permission required',
  awaiting: 'Awaiting approval',
  /** Scope choices. Order in the card is fixed; see lib/approval-scope.ts. */
  once: 'Once',
  onceHint: 'Run only this time, then ask again next time',
  session: 'This session',
  sessionHint: 'Allow for the rest of this conversation, then forget it',
  always: 'Always allow',
  alwaysHint: 'Never ask again for this exact command, in this project',
  /** Shown in place of the `always` row when the grant cannot be made durable. */
  alwaysWithheld: 'Always is unavailable here',
  alwaysWithheldHint:
    'Destructive or network commands can only be allowed once or for this session',
  deny: 'Deny',
  denyHint: 'Reject it for now',
  instructions: 'Give instructions instead',
  instructionsHint: 'Type what the AI should do rather than running this',
  instructionsPlaceholder: 'e.g. Skip this and edit README.md instead…',
  confirmHint: 'Use Tab / arrow keys to choose, then press Enter to confirm',
  confirm: 'Confirm',
  reject: 'Deny',
  rejectHint: 'Reject it for now',
  subtitle: 'Choose how long similar permissions last.',
  preApply: 'Permission required',
  terminalTitle: 'Permission required',
  terminalSubtitle: 'Once · This session · Always · Deny',
} as const;

export type PermissionCopyKey = keyof typeof PERMISSION_COPY;
