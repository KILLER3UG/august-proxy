/* ── Shared permission / approval copy ────────────────────────────────── */
/* One mental model for workbench + terminal grant surfaces.              */

export const PERMISSION_COPY = {
  title: 'Allow this action?',
  subtitle: 'Choose how long similar permissions last.',
  once: 'Once',
  onceHint: 'Allow this single action',
  session: 'This chat',
  sessionHint: 'Allow for the rest of this conversation',
  always: 'Always here',
  alwaysHint: 'Remember for this workspace folder',
  reject: 'Reject',
  rejectHint: 'Do not run this change',
  preApply: 'Review change before it applies',
  terminalTitle: 'Allow terminal command?',
  terminalSubtitle: 'Same as file tools: Once · This chat · Always here',
} as const;

export type PermissionCopyKey = keyof typeof PERMISSION_COPY;
