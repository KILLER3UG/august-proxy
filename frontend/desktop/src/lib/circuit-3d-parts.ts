/* ── circuit-3d-parts ─ mesh factories for the 3D board stage ─────────────
 *
 * Geometry is PROCEDURAL: no model file is fetched, loaded or shipped. A part
 * is described by the netlist graph the backend already returns (kind, ref,
 * value, nodes, pin coordinates), and its solid is built from primitives at
 * runtime. That is both the reference stage's design and the right one for an
 * agent-driven app — the deck is the source of truth, so a part the model just
 * wrote appears without any asset pipeline existing.
 *
 * Colours come from the CSS custom properties in styles/tokens.css, read once
 * per mount. A TS table would trip the design gate's raw-hex rule and, more
 * importantly, would be a second place a part's colour could be.
 */

import {
  BackSide,
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  type BufferGeometry,
  type Material,
} from 'three';

/** A mesh with its geometry/material types left open. `Object3D.traverse`
 *  hands back `Mesh<any, any, any>`, and passing that where a concrete mesh
 *  is expected is what the unsafe-argument rule exists to catch — so the
 *  scene graph is narrowed HERE, once, at the boundary with three. */
type AnyMesh = Mesh<BufferGeometry, Material | Material[]>;

export interface PartPin {
  0: number;
  1: number;
}

export interface PartInput {
  ref: string;
  kind: string;
  value: string;
  nodes: string[];
  pins: PartPin[];
}

/** One SVG user unit is a tenth of a world unit; the grid is 10 units. */
export const WORLD_PER_UNIT = 0.1;

/** Fallbacks for a stage that mounts before the stylesheet is applied. Named
 *  colours, deliberately: the design gate bans raw hex in .ts/.tsx precisely
 *  so a colour cannot be set from two places, and these are not the real
 *  values — `--cb3d-*` in styles/tokens.css is. */
const FALLBACKS: Record<string, string> = {
  '--cb3d-board': 'gold',
  '--cb3d-board-deep': 'goldenrod',
  '--cb3d-slab': 'linen',
  '--cb3d-slab-hole': 'dimgray',
  '--cb3d-resistor': 'tan',
  '--cb3d-band-a': 'saddlebrown',
  '--cb3d-band-b': 'firebrick',
  '--cb3d-band-c': 'darkgreen',
  '--cb3d-cap': 'steelblue',
  '--cb3d-ic': 'darkslategray',
  '--cb3d-lead': 'silver',
  '--cb3d-led-r': 'red',
  '--cb3d-led-g': 'limegreen',
  '--cb3d-led-b': 'royalblue',
  '--cb3d-stage-ink': 'black',
  '--cb3d-select': 'orange',
  '--cb3d-silk': 'ivory',
};

export type Palette = Record<string, string>;

/** Read the palette out of the cascade, so the stylesheet is the only place a
 *  part's colour can be changed. */
export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const out: Palette = {};
  for (const key of Object.keys(FALLBACKS)) {
    out[key] = cs.getPropertyValue(key).trim() || FALLBACKS[key];
  }
  return out;
}

export function material(color: string, opts?: { rough?: number; metal?: number; emissive?: number }): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    roughness: opts?.rough ?? 0.55,
    metalness: opts?.metal ?? 0.08,
    emissive: color,
    emissiveIntensity: opts?.emissive ?? 0,
    flatShading: true,
  });
}

/** The ink-coloured back-face hull that reads as an outline without a second
 *  render pass. Cheap, and it is what makes the parts look drawn rather than
 *  photographed. */
export function hullOf(mesh: Mesh, ink: string, gain = 1.045): Mesh {
  const hull = new Mesh(mesh.geometry, new MeshStandardMaterial({
    color: ink,
    side: BackSide,
    roughness: 1,
    metalness: 0,
  }));
  hull.scale.multiplyScalar(gain);
  hull.position.copy(mesh.position);
  hull.rotation.copy(mesh.rotation);
  hull.userData.hull = true;
  return hull;
}

/** `pins` are in world units, already relative to the part's centroid. */
function leads(pins: PartPin[], palette: Palette): Mesh[] {
  const out: Mesh[] = [];
  for (const pin of pins.slice(0, 2)) {
    const geo = new CylinderGeometry(0.05, 0.05, 1.1, 8);
    const mesh = new Mesh(geo, material(palette['--cb3d-lead'], { metal: 0.55, rough: 0.35 }));
    mesh.rotation.z = Math.PI / 2;
    mesh.position.set(pin[0], 0.12, pin[1]);
    out.push(mesh);
  }
  return out;
}

/** A two-terminal part laid between its pins: body length comes from the pin
 *  distance, so the drawing cannot disagree with the connectivity. */
function axialBody(pins: PartPin[], radius: number, color: string, height: number): Mesh {
  const a = pins[0];
  const b = pins[1] ?? pins[0];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.max(0.6, Math.hypot(dx, dy) - radius * 2);
  const geo = new CylinderGeometry(radius, radius, len, 18);
  const mesh = new Mesh(geo, material(color, { rough: 0.5 }));
  mesh.rotation.z = Math.PI / 2;
  mesh.rotation.y = -Math.atan2(dy, dx);
  mesh.position.set((a[0] + b[0]) / 2, height, (a[1] + b[1]) / 2);
  return mesh;
}

function bands(body: Mesh, palette: Palette): Mesh[] {
  const out: Mesh[] = [];
  const colors = ['--cb3d-band-a', '--cb3d-band-b', '--cb3d-band-c'];
  const len = (body.geometry as CylinderGeometry).parameters.height;
  colors.forEach((key, i) => {
    const geo = new CylinderGeometry(len / 8, len / 8, len * 0.42, 12);
    const band = new Mesh(geo, material(palette[key], { rough: 0.4 }));
    band.rotation.copy(body.rotation);
    // The body lies along X after its z-rotation; offset in the same frame.
    const off = (i - 1) * len * 0.26;
    band.position.set(
      body.position.x + Math.cos(body.rotation.y) * off,
      body.position.y,
      body.position.z - Math.sin(body.rotation.y) * off,
    );
    out.push(band);
  });
  return out;
}

/** The runtime canvas texture that gives a part its silk screen. Nothing is
 *  fetched: the label is drawn here, at build time. Two lines, because the
 *  board's reference and its value are the two things a reader checks a 3D
 *  view against — a brand line would be decoration. */
export function labelTexture(top: string, bottom: string, ink: string, base: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.font = 'bold 72px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(top.slice(0, 12), canvas.width / 2, 125);
    ctx.font = '44px ui-monospace, monospace';
    ctx.globalAlpha = 0.75;
    ctx.fillText(bottom.slice(0, 18), canvas.width / 2, 190);
  }
  const tex = new CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

/** Everything that changes a part's MESH, not just its position. The stage
 *  uses this to rebuild a part whose value/kind/pins changed; rebuilding only
 *  on a position change is how a resistor→LED edit stayed a resistor. */
export function partGeometryKey(input: PartInput): string {
  const pins = input.pins.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(';');
  return `${input.kind}|${input.value}|${input.nodes.join(',')}|${pins}`;
}

/** Where the part's group belongs, in world units, BEFORE the caller's board
 *  centring. The stage reads this for a move without rebuilding the mesh. */
export function partCentroid(input: PartInput): { x: number; z: number } {
  const pins = input.pins.length >= 2 ? input.pins : ([[0, 0], [20, 0]] as PartPin[]);
  const n = pins.length;
  return {
    x: (pins.reduce((s, p) => s + p[0], 0) / n) * WORLD_PER_UNIT,
    z: (pins.reduce((s, p) => s + p[1], 0) / n) * WORLD_PER_UNIT,
  };
}

/** Build one part's group, placed at its pin centroid by `partCentroid`. */
export function buildPart(input: PartInput, palette: Palette): Group {
  const group = new Group();
  group.name = input.ref;
  group.userData.ref = input.ref;
  group.userData.kind = input.kind;
  group.userData.value = input.value;
  group.userData.nodes = input.nodes;

  const pins = input.pins.length >= 2 ? input.pins : [[0, 0], [20, 0]] as PartPin[];
  const local = pins.map((p) => [p[0] * WORLD_PER_UNIT, p[1] * WORLD_PER_UNIT] as PartPin);
  const centre = partCentroid(input);
  const shifted = local.map((p) => [p[0] - centre.x, p[1] - centre.z] as PartPin);
  // `local`, the centre and `shifted` are WORLD units. The group sits at the
  // pin centroid and every child is built around zero; multiplying or centring
  // a second time inside a child put every axial part at the board origin.
  group.position.set(centre.x, 0, centre.z);

  const kind = input.kind;
  if (kind === 'resistor') {
    const body = axialBody(shifted, 0.22, palette['--cb3d-resistor'], 0.45);
    group.add(body, ...bands(body, palette));
  } else if (kind === 'capacitor') {
    const body = axialBody(shifted, 0.3, palette['--cb3d-cap'], 0.6);
    group.add(body);
  } else if (kind === 'isource' || kind === 'voltage') {
    // `voltage`, not `vsource`: the kind vocabulary is schematic._ELEMENT_KINDS
    // and the board graph is `schematic.build_graph` output — a test against
    // 'vsource' matched nothing, so the draggable bench-knob this branch draws
    // only ever appeared on a current source, and every V card fell through to
    // the generic axial body below.
    // The deck's own adjustable input, drawn as the thing it is on a bench: a
    // rotary knob. Its dimensions are the reference stage's, scaled from mm to
    // world units — a 6.1/6.4 radius barrel, a knurled cap and a pointer that
    // is what actually turns. `knob` is tagged so the stage can rotate exactly
    // that group from a drag, and `draggable` is what the cursor and the
    // pointer-down test read.
    const base = new Mesh(
      new CylinderGeometry(0.46, 0.46, 0.12, 24),
      material(palette['--cb3d-lead'], { metal: 0.55, rough: 0.32 }),
    );
    base.position.set(0, 0.08, 0);
    const knob = new Group();
    knob.name = `${input.ref}-knob`;
    const barrel = new Mesh(
      new CylinderGeometry(0.61, 0.64, 0.7, 24),
      material(palette['--cb3d-ic'], { rough: 0.45 }),
    );
    barrel.position.set(0, 0.48, 0);
    const cap = new Mesh(
      new CylinderGeometry(0.54, 0.62, 0.09, 24),
      material(palette['--cb3d-board-deep'], { rough: 0.5 }),
    );
    cap.position.set(0, 0.87, 0);
    const pointer = new Mesh(
      new BoxGeometry(0.11, 0.04, 0.44),
      material(palette['--cb3d-silk'], { rough: 0.3 }),
    );
    pointer.position.set(0, 0.93, 0.16);
    knob.add(barrel, cap, pointer);
    group.add(base, knob);
    group.userData.draggable = 'pot';
    group.userData.knob = knob;
    for (const [i, offset] of [-0.254, 0, 0.254].entries()) {
      const pin = new Mesh(
        new BoxGeometry(0.07, 0.34, 0.05),
        material(palette['--cb3d-lead'], { metal: 0.6, rough: 0.3 }),
      );
      pin.position.set(offset, -0.12, i === 1 ? -0.2 : 0.2);
      group.add(pin);
    }
  } else if (kind === 'diode' && /led/i.test(input.value)) {
    // An LED is a diode whose model names it (`D1 a 0 LED`): the branch keyed
    // on a literal `led` kind that no deck letter produces — schematic emits
    // 'diode' for D — so the sphere was unreachable and every diode, LED or
    // rectifier, rendered as the generic body.
    const geo = new SphereGeometry(0.3, 18, 12);
    const colour = /r/i.test(input.value) || input.nodes.length === 0
      ? palette['--cb3d-led-r']
      : /b/i.test(input.value)
        ? palette['--cb3d-led-b']
        : palette['--cb3d-led-g'];
    const domeMat = material(colour, { rough: 0.2 });
    // Emissive starts at zero on purpose: the stage drives it from the knob, so
    // a part that glows before anything is connected to it would be a lie about
    // the circuit.
    domeMat.emissiveIntensity = 0;
    const dome = new Mesh(geo, domeMat);
    dome.userData.led = true;
    dome.position.set(0, 0.45, 0);
    dome.scale.y = 1.3;
    group.add(dome);
  } else if (kind === 'subckt' || kind === 'switch') {
    // A board or an IC: a box with a silkscreen and one pin stub per net.
    const wide = Math.max(1.6, (Math.max(...local.map((p) => p[0])) - Math.min(...local.map((p) => p[0]))) * 0.6 + 1);
    const deep = Math.max(1.0, (Math.max(...local.map((p) => p[1])) - Math.min(...local.map((p) => p[1]))) * 0.6 + 1);
    const geo = new BoxGeometry(wide, 0.5, deep);
    const body = new Mesh(geo, material(palette['--cb3d-ic'], { rough: 0.45 }));
    body.position.set(0, 0.28, 0);
    const face = new Mesh(
      new BoxGeometry(wide * 0.92, 0.02, deep * 0.92),
      new MeshStandardMaterial({ map: labelTexture(input.ref, input.value || input.nodes.slice(0, 3).join(' '), palette['--cb3d-silk'], palette['--cb3d-ic']) }),
    );
    face.position.set(0, 0.54, 0);
    group.add(body, face);
    for (const p of shifted) {
      const geo2 = new CylinderGeometry(0.045, 0.045, 0.5, 6);
      const pin = new Mesh(geo2, material(palette['--cb3d-lead'], { metal: 0.6, rough: 0.3 }));
      pin.position.set(p[0], 0.02, p[1]);
      group.add(pin);
    }
  } else if (shifted.length >= 3) {
    // A three-plus-terminal device (BJT, FET, coupled inductor): a box with a
    // pin stub for EVERY net. The generic two-lead body drew three-terminal
    // parts as resistors and left the third net landing nowhere.
    const xs = shifted.map((p) => p[0]);
    const ys = shifted.map((p) => p[1]);
    const wide = Math.max(1.0, Math.max(...xs) - Math.min(...xs) + 0.5);
    const deep = Math.max(0.8, Math.max(...ys) - Math.min(...ys) + 0.5);
    const body = new Mesh(
      new BoxGeometry(wide, 0.5, deep),
      material(palette['--cb3d-ic'], { rough: 0.45 }),
    );
    body.position.set(0, 0.28, 0);
    group.add(body);
    for (const p of shifted) {
      const pin = new Mesh(
        new CylinderGeometry(0.045, 0.045, 0.5, 6),
        material(palette['--cb3d-lead'], { metal: 0.6, rough: 0.3 }),
      );
      pin.position.set(p[0], 0.02, p[1]);
      group.add(pin);
    }
  } else {
    const body = axialBody(shifted, 0.24, palette['--cb3d-board-deep'], 0.5);
    group.add(body);
  }

  // Leads sit at the pin positions for the two-terminal families.
  if (kind !== 'subckt' && kind !== 'switch' && shifted.length < 3) {
    for (const mesh of leads(shifted, palette)) {
      group.add(mesh);
    }
  }
  const bodies: AnyMesh[] = [];
  group.traverse((o) => {
    const isHull = o.userData['hull'] === true;
    if (o instanceof Mesh && !isHull) bodies.push(o as AnyMesh);
  });
  for (const body of bodies) {
    group.add(hullOf(body, palette['--cb3d-stage-ink']));
  }
  return group;
}

/** The board slab every part sits on — one box, one runtime texture. */
export function buildSlab(width: number, depth: number, palette: Palette): Group {
  const group = new Group();
  const geo = new BoxGeometry(width, 0.3, depth);
  const holes = document.createElement('canvas');
  holes.width = 512;
  holes.height = 256;
  const ctx = holes.getContext('2d');
  if (ctx) {
    ctx.fillStyle = palette['--cb3d-slab'];
    ctx.fillRect(0, 0, holes.width, holes.height);
    ctx.fillStyle = palette['--cb3d-slab-hole'];
    for (let x = 12; x < holes.width; x += 16) {
      for (let y = 12; y < holes.height; y += 16) {
        ctx.beginPath();
        ctx.arc(x, y, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const top = new CanvasTexture(holes);
  const body = new Mesh(geo, new MeshStandardMaterial({
    color: palette['--cb3d-slab'],
    map: top,
    roughness: 0.7,
    metalness: 0,
  }));
  body.position.y = -0.15;
  body.receiveShadow = true;
  body.name = 'slab';
  group.add(body);
  return group;
}
