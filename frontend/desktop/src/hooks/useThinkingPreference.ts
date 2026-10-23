import { useSyncExternalStore } from 'react';
import {
  isCollapseThinkingEnabled,
  subscribeThinkingPreference,
} from '@/lib/thinking-preference';

/** Live view of the collapse-thinking preference for mounted transcript
 *  cards, so the Settings switch does not require a route change. */
export function useCollapseThinking(): boolean {
  return useSyncExternalStore(
    subscribeThinkingPreference,
    isCollapseThinkingEnabled,
    isCollapseThinkingEnabled,
  );
}
