/* ── TrafficActivitySection — deprecated shim ────────────────────────── */
/* The Traffic & Activity section has been absorbed into the new
 * Observability section as the Traffic and Logs subtabs. The two
 * subtab components (`TrafficSubtab`, `LogsSubtab`) are now the
 * canonical sources.
 *
 * This file is kept as a thin re-export so any existing imports keep
 * working until callers are migrated. The actual UI lives in:
 *   - sections/settings/TrafficSubtab.tsx
 *   - sections/settings/LogsSubtab.tsx
 *   - sections/settings/ObservabilitySection.tsx (orchestrator)
 *
 * The `traffic-activity` row has been removed from SETTINGS_SECTIONS; the
 * old URL is preserved via legacyAliases on the `observability` section.
 */

export { TrafficSubtab as TrafficActivitySection } from './TrafficSubtab';
export { LogsSubtab as TrafficActivityLogsTab } from './LogsSubtab';
