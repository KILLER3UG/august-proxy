/* The tab ↔ tabpanel id contract for `SettingsTabs`, in its own module so
 * react-refresh keeps the component file hot (the rule's own remedy — a shared
 * function does not belong in a component module). One source means the
 * `aria-controls` on a tab and the `id` on the consumer's panel cannot drift
 * apart, which is the whole point of wiring them at all. */

/** The tabpanel id for a tab, or null when the tablist has no panel wiring. */
export function settingsTabPanelId(prefix: string | undefined, key: string): string | null {
  return prefix ? `${prefix}-panel-${key}` : null;
}

/** The tab's own element id, which the panel names in `aria-labelledby`. */
export function settingsTabTriggerId(prefix: string, key: string): string {
  return `${prefix}-tab-${key}`;
}
