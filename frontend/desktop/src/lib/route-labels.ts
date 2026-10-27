/* ── Route labels — the name a surface answers to in the chrome ─────── */
/* The desktop titlebar and the phone topbar both print a title for the
 * CURRENT route, and they must not disagree: two copies of this map is how
 * one of them ends up saying "August" where the other says "Charts". The
 * rules are the titlebar's own, moved here so both read one table:
 *
 *  • a chat route shows the SESSION's title (it is the document's name);
 *  • a settings route names the section, because "Settings" alone tells a
 *    reader nothing about which panel is open;
 *  • every other route is a name from the table below.
 */

import { SETTINGS_SECTIONS } from '@/settings/settings-registry';

const ROUTE_LABELS: Record<string, string> = {
  '/automations': 'Automations',
  '/runs': 'Runs',
  '/board': 'Board',
  '/live': 'Live',
  '/history': 'History',
  '/learning': 'Learning',
  '/artifacts': 'Artifacts',
  '/charts': 'Charts',
  '/docs': 'Docs',
  '/_design': 'Design system',
};

export function routeLabelFor(pathname: string, sessionTitle?: string | null): string {
  const lowered = pathname.toLowerCase();
  if (pathname === '/' || lowered.startsWith('/c/')) return sessionTitle || 'New chat';
  if (lowered.startsWith('/settings')) {
    const section = pathname.split('/')[2]?.toLowerCase();
    if (!section) return 'Settings';
    const hit = SETTINGS_SECTIONS.find((s) => s.id === section);
    return hit ? `Settings · ${hit.label}` : 'Settings';
  }
  return ROUTE_LABELS[pathname] ?? 'August';
}
