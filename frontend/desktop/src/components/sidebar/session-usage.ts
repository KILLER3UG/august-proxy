/* ── session-usage — the ONE batched token read behind the sidebar rows ──
 *
 * Each chat row shows `+input / −output` (the Haze row signature). Reading
 * that per row meant one request per row, each dragging back a 500-event list
 * the row never reads — a sidebar render fanning out over the network.
 *
 * SessionList fetches every visible id in one grouped query and publishes the
 * result here, so <SessionRow> can stay a pure `memo` component: the provider
 * value is the query's own object, which React Query keeps referentially
 * stable until new data arrives. A context rather than a prop because the rows
 * are rendered from four separate pools (pinned, each folder, unfiled); a prop
 * would have to be threaded through all of them and re-added at every new
 * call site. */

import { createContext, useContext } from 'react';
import type { SessionTokenDelta } from '@/api/usage';

/** Stable empty so the no-data case never re-renders every row. */
export const NO_DELTAS: Record<string, SessionTokenDelta> = {};

export const SessionUsageContext = createContext<Record<string, SessionTokenDelta>>(NO_DELTAS);

export const SessionUsageProvider = SessionUsageContext.Provider;

/** The shape `GET /api/usage/sessions` returns, re-exported so the row and
 *  its tests do not each import the api module for one type. */
export type { SessionTokenDelta } from '@/api/usage';

/** Totals for one chat, or undefined when nothing has been recorded for it.
 *  Keyed by the workbench/SoT id — the form `record_usage` writes, which is why
 *  the status bar and composer chip read the same key. */
export function useSessionTokenDelta(id: string | undefined): SessionTokenDelta | undefined {
  return useContext(SessionUsageContext)[id ?? ''];
}