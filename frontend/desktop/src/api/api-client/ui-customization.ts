/* UI customization — server-side color-token overrides (Settings → Design UI
 * and the model's customize_ui tool). The frontend paints these as CSS vars;
 * the server is the source of truth so chat-driven recolors persist. */

import { api } from '../client';

export type UiCustomizationMap = Record<string, string>;

export function getUiCustomization(): Promise<{ customization: UiCustomizationMap }> {
  return api.get<{ customization: UiCustomizationMap }>('/api/config/ui-customization');
}

export function updateUiCustomization(
  changes: Record<string, string | null>,
  opts?: { reset?: boolean },
): Promise<{
  customization: UiCustomizationMap;
  errors: string[];
}> {
  return api.put('/api/config/ui-customization', { changes, reset: opts?.reset ?? false });
}
