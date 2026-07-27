/* One-shot server sync for UI customization on app launch.
 *
 * localStorage hydrates instantly at startup (anti-FOUC), but the server is
 * the source of truth — the model's customize_ui tool writes there — so a
 * non-empty server map wins over the local cache once the backend is up.
 */

import { useEffect } from 'react';
import { getUiCustomization } from '@/api/api-client';
import { applyExternalCustomization } from '@/lib/ui-customization';

export function useUiCustomizationSync(): void {
  useEffect(() => {
    let cancelled = false;
    getUiCustomization()
      .then(({ customization }) => {
        if (!cancelled && customization && Object.keys(customization).length > 0) {
          applyExternalCustomization(customization);
        }
      })
      .catch(() => {
        /* best-effort: keep the localStorage-hydrated colors */
      });
    return () => {
      cancelled = true;
    };
  }, []);
}
