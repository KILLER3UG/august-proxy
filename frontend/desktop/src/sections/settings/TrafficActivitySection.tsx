/* ── TrafficActivitySection — re-exports ─────────────────────────────── */
/* Stable import paths for traffic and logs UI. Canonical components:
 *   - TrafficSubtab.tsx
 *   - LogsSubtab.tsx
 *   - ObservabilitySection.tsx (host)
 * Settings URLs that used traffic-activity resolve via observability
 * legacyAliases in the settings registry.
 */

export { TrafficSubtab as TrafficActivitySection } from './TrafficSubtab';
export { LogsSubtab as TrafficActivityLogsTab } from './LogsSubtab';
