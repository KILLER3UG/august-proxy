/* ── circuit-api ─ typed client for the circuit schematic endpoints ────────
 *
 * The netlist stays the SPICE source of truth; these endpoints drive only
 * the layout sidecar (<name>.layout.json) and the renderable graph. The
 * editor and the model's circuit_edit_schematic tool write the same file.
 */

import { api } from './client';

export interface SchematicPin {
  0: number;
  1: number;
}

export interface SchematicComponent {
  ref: string;
  kind: string;
  nodes: string[];
  value: string;
  col: number;
  row: number;
  rot: number;
  /** [x, y] pairs in SVG user units, left pin then right pin. */
  pins: SchematicPin[];
}

export interface SchematicWire {
  nodes: string[];
  points: SchematicPin[];
  path: string;
}

export interface SchematicGraph {
  components: SchematicComponent[];
  wires: SchematicWire[];
  nodes: string[];
  grounded: boolean;
  grid: number;
  path?: string;
  layoutPath?: string;
  layoutExists?: boolean;
  autoLayout?: boolean;
  savedTo?: string;
}

export interface SchematicMove {
  ref: string;
  col?: number;
  row?: number;
  rot?: number;
}

export const circuitApi = {
  readSchematic: (sessionId: string, path: string) =>
    api.get<SchematicGraph>(
      `/api/workbench/sessions/${encodeURIComponent(sessionId)}/circuit/schematic?path=${encodeURIComponent(path)}`,
    ),
  editSchematic: (
    sessionId: string,
    body: { path: string; moves?: SchematicMove[]; wireRoutes?: Record<string, SchematicPin[]>; auto?: boolean },
  ) =>
    api.post<SchematicGraph>(
      `/api/workbench/sessions/${encodeURIComponent(sessionId)}/circuit/schematic`,
      body,
    ),
};
