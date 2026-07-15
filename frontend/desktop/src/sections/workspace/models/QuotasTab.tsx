/* Quotas view — per-model daily token usage limits.
 * Delegates rendering and save behavior to QuotasPanel.
 */

import { QuotasPanel } from '@/sections/settings/QuotasPanel';

export function QuotasTab() {
  return <QuotasPanel />;
}
