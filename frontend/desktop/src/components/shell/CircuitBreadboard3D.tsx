/* ── CircuitBreadboard3D ─ the live 3D view of the deck being edited ──────
 *
 * The schematic editor draws the wiring; this shows the same netlist as
 * objects you can turn. It is driven entirely by the graph the backend already
 * returns for the active deck — kind, ref, value, nodes and each pin's
 * coordinates — so a part the model just wrote into the .cir appears here
 * without any asset, model file or second data source existing. The netlist
 * stays the source of truth, exactly as it is for the schematic and the
 * simulation.
 *
 * The scene is built ONCE and then DIFFED against each new graph, which is
 * what makes the three state changes legible instead of a flash: a part that
 * arrives drops in, a part that moved travels along an arc to its new place,
 * and a part that left collapses out where it stood. Rebuilding the scene per
 * edit would show all three as the same pop.
 *
 * Camera is ORTHOGRAPHIC with a back-face hull outline, both measured off a
 * reference board stage and kept because they make a procedural scene read as
 * a drawing rather than a photograph. Motion lives in lib/circuit-motion.ts,
 * colour in styles/tokens.css, keyframes in styles/motion.css.
 *
 * The overlay readout, the halo and the knob's own numbers are written straight
 * onto elements from the render loop: they are per-frame scene projections, not
 * styling, and an inline style object would re-render the tree sixty times a
 * second.
 */

import { useEffect, useRef, useState } from 'react';
import {
  AmbientLight,
  CatmullRomCurve3,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFShadowMap,
  Raycaster,
  Scene,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
} from 'three';

/** A mesh with its geometry/material types left open. `Object3D.traverse`
 *  hands back `Mesh<any, any, any>`, so the scene graph is narrowed here, once,
 *  at the boundary with three rather than at every disposal call. */
type AnyMesh = Mesh<BufferGeometry, Material | Material[]>;
import { buildPart, buildSlab, readPalette, WORLD_PER_UNIT, type PartInput } from '@/lib/circuit-3d-parts';
import { LIFT, TIMING, TWEEN_SPEED_REDUCED, prefersReducedMotion, tweenProgress } from '@/lib/circuit-motion';
import type { SchematicGraph } from '@/api/circuit';

interface Props {
  graph: SchematicGraph | null;
  selectedRef?: string;
  onSelect?: (ref: string) => void;
  className?: string;
}

type PartMode = 'enter' | 'move' | 'exit';

interface PartState {
  group: Group;
  ref: string;
  mode: PartMode;
  startMs: number;
  from: Vector3;
  to: Vector3;
  hoverFrom: number;
  hoverTo: number;
  hoverStart: number;
}

interface Stage {
  scene: Scene;
  camera: OrthographicCamera;
  renderer: WebGLRenderer;
  parts: Map<string, PartState>;
  wires: Mesh[];
  size: { w: number; h: number };
  pointer: Vector2;
  setReadout: (text: string) => void;
  setPot: (pot: number, pwm: number, led: string) => void;
  /** Wired up by the mount effect, which owns the camera and the knob. */
  setFit?: (extent: number) => void;
  applyPot?: () => void;
}

const SWEEP_DEG = 270;
const COUNTS_PER_RAD = 1023 / (SWEEP_DEG * (Math.PI / 180));
const KNOB_HEIGHT = 0.9;

export function CircuitBreadboard3D({ graph, selectedRef, onSelect, className }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const readoutRef = useRef<HTMLDivElement | null>(null);
  const haloRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Stage | null>(null);
  const selectedRefProp = useRef(selectedRef);
  selectedRefProp.current = selectedRef;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [failed, setFailed] = useState(false);
  const [label, setLabel] = useState('');
  const [knobReadout, setKnobReadout] = useState('512 → 128');
  const [empty, setEmpty] = useState(!graph || graph.components.length === 0);

  /* ── mount: renderer, camera, lights, controls, the frame loop ───────── */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    } catch {
      setFailed(true);
      return;
    }
    host.appendChild(renderer.domElement);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;

    const size = { w: host.clientWidth || 320, h: Math.max(200, host.clientHeight || 240) };
    renderer.setSize(size.w, size.h);
    const scene = new Scene();
    const camera = new OrthographicCamera(-6, 6, 6 * (size.h / size.w), -6 * (size.h / size.w), 0.1, 900);
    scene.add(new HemisphereLight(0xfffaf3, 0xc2ae90, 0.5));
    scene.add(new AmbientLight(0xfff6ea, 1.2));
    const key = new DirectionalLight(0xffffff, 0.001);
    key.castShadow = true;
    key.position.set(6, 12, 7);
    scene.add(key);

    const stage: Stage = {
      scene,
      camera,
      renderer,
      parts: new Map(),
      wires: [],
      size,
      pointer: new Vector2(-2, -2),
      setReadout: setLabel,
      setPot: (pot, pwm, led) => {
        const el = host as HTMLElement & { dataset: DOMStringMap };
        el.dataset['pot'] = String(pot);
        el.dataset['pwm'] = String(pwm);
        el.dataset['led'] = led;
        setKnobReadout(`${pot} → ${pwm}`);
      },
    };
    stageRef.current = stage;

    let halfBase = 6;
    let azimuth = Math.PI / 5;
    let elevation = Math.PI / 4.2;
    let zoom = 8.4;
    let targetAz = azimuth;
    let targetEl = elevation;
    let snapStart = 0;
    let snapFromAz = azimuth;
    let snapFromEl = elevation;
    let idleSince = performance.now();
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let knobDrag: PartState | null = null;
    let knobPivot = new Vector2();
    let knobLastAngle = 0;
    let pot = 512;
    let hovered: PartState | null = null;
    const speed = prefersReducedMotion() ? TWEEN_SPEED_REDUCED : 1;
    const ray = new Raycaster();

    const applyCamera = (): void => {
      const r = 26 / (zoom / 8.4);
      camera.position.set(
        r * Math.cos(elevation) * Math.sin(azimuth),
        r * Math.sin(elevation),
        r * Math.cos(elevation) * Math.cos(azimuth),
      );
      camera.lookAt(0, 0, 0);
      const half = halfBase * (8.4 / zoom);
      camera.left = -half;
      camera.right = half;
      camera.top = half * (size.h / size.w);
      camera.bottom = -half * (size.h / size.w);
      camera.updateProjectionMatrix();
    };
    stage.setFit = (extent: number): void => {
      halfBase = extent;
      applyCamera();
    };

    const ownerOf = (obj: object | null): PartState | null => {
      let node = obj as Group | null;
      while (node && !node.userData['ref']) node = node.parent as Group | null;
      return node ? (stage.parts.get(String(node.userData['ref'])) ?? null) : null;
    };
    const hitAt = (clientX: number, clientY: number): PartState | null => {
      const rect = host.getBoundingClientRect();
      stage.pointer.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(stage.pointer, camera);
      const groups = [...stage.parts.values()].map((p) => p.group);
      const hit = ray.intersectObjects(groups, true).find((h) => h.object.userData['hull'] !== true);
      return ownerOf(hit?.object ?? null);
    };
    const pivotOf = (p: PartState): Vector2 => {
      const v = p.group.position.clone();
      v.y = KNOB_HEIGHT;
      v.project(camera);
      const rect = host.getBoundingClientRect();
      return new Vector2(
        rect.left + ((v.x + 1) / 2) * rect.width,
        rect.top + ((1 - v.y) / 2) * rect.height,
      );
    };
    const applyPot = (): void => {
      const pwm = Math.floor(pot / 4);
      const mats: MeshStandardMaterial[] = [];
      for (const p of stage.parts.values()) {
        const knob = p.group.userData['knob'] as Group | undefined;
        if (knob) knob.rotation.y = -((pot / 1023) * SWEEP_DEG - SWEEP_DEG / 2) * (Math.PI / 180);
        p.group.traverse((o) => {
          if (o instanceof Mesh && o.userData['led'] === true) {
            const mat = o.material as MeshStandardMaterial;
            mat.emissiveIntensity = pwm / 255;
            mats.push(mat);
          }
        });
      }
      stage.setPot(pot, pwm, (pwm / 255).toFixed(2));
      void mats;
    };
    stage.applyPot = applyPot;

    const onPointerDown = (e: PointerEvent): void => {
      idleSince = performance.now();
      const hit = hitAt(e.clientX, e.clientY);
      if (hit && hit.group.userData['draggable'] === 'pot') {
        // A knob owns the gesture. Without this the camera and the control
        // would share one drag and neither would do what the finger meant.
        knobDrag = hit;
        knobPivot = pivotOf(hit);
        knobLastAngle = Math.atan2(e.clientY - knobPivot.y, e.clientX - knobPivot.x);
        host.classList.add('cursor-grabbing');
        host.setPointerCapture?.(e.pointerId);
        return;
      }
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      host.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent): void => {
      idleSince = performance.now();
      const rect = host.getBoundingClientRect();
      stage.pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      if (knobDrag) {
        const angle = Math.atan2(e.clientY - knobPivot.y, e.clientX - knobPivot.x);
        // Wrapped through atan2(sin, cos): crossing ±π must read as a few
        // counts, not as a 2π jump that slams the knob to its stop.
        const delta = Math.atan2(Math.sin(angle - knobLastAngle), Math.cos(angle - knobLastAngle));
        knobLastAngle = angle;
        pot = Math.min(1023, Math.max(0, Math.round(pot + delta * COUNTS_PER_RAD)));
        applyPot();
        return;
      }
      if (dragging) {
        azimuth += (e.clientX - lastX) * 0.006;
        elevation = Math.min(1.45, Math.max(0.06, elevation + (e.clientY - lastY) * 0.004));
        targetAz = azimuth;
        targetEl = elevation;
        lastX = e.clientX;
        lastY = e.clientY;
        snapStart = 0;
      }
    };
    const onPointerUp = (): void => {
      if (knobDrag) {
        knobDrag = null;
        host.classList.remove('cursor-grabbing');
        return;
      }
      dragging = false;
      // Ratchet to the nearest quarter turn: a free camera looks arbitrary,
      // a snapped one looks composed.
      const quarter = Math.PI / 2;
      snapFromAz = azimuth;
      snapFromEl = elevation;
      targetAz = Math.round(azimuth / quarter) * quarter;
      targetEl = elevation > 0.95 ? 1.0 : elevation < 0.3 ? 0.3 : elevation;
      snapStart = performance.now();
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      idleSince = e.timeStamp;
      zoom = Math.min(22, Math.max(3.2, zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    };
    const onClick = (): void => {
      if (hovered && onSelectRef.current) onSelectRef.current(hovered.ref);
    };
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('click', onClick);

    const dropPart = (p: PartState): void => {
      p.group.parent?.remove(p.group);
      p.group.traverse((o) => {
        if (o instanceof Mesh) disposeDeep(o as AnyMesh);
      });
    };

    let raf = 0;
    const frame = (): void => {
      const t = performance.now();
      ray.setFromCamera(stage.pointer, camera);
      const groups = [...stage.parts.values()].map((p) => p.group);
      const hit = ray.intersectObjects(groups, true).find((h) => h.object.userData['hull'] !== true);
      const found = ownerOf(hit?.object ?? null);
      if (found !== hovered) {
        const now = t;
        if (hovered) {
          hovered.hoverFrom = currentLift(hovered, now);
          hovered.hoverTo = 0;
          hovered.hoverStart = now;
        }
        if (found) {
          found.hoverFrom = currentLift(found, now);
          found.hoverTo = LIFT.hover;
          found.hoverStart = now;
        }
        hovered = found;
        if (found) {
          const nodes = (found.group.userData['nodes'] as string[] | undefined) ?? [];
          const value = String(found.group.userData['value'] ?? '');
          // Shortened in the string, not with CSS `truncate`: a board's twenty
          // nets would set the card's width, and a card that wide covers the
          // very part it is describing.
          const shown = nodes.length > 6 ? `${nodes.slice(0, 6).join(' / ')} +${nodes.length - 6}` : nodes.join(' / ');
          stage.setReadout(`${found.ref}${value ? ` · ${value}` : ''}${shown ? ` · ${shown}` : ''}`);
        } else {
          stage.setReadout('');
        }
      }
      host.classList.toggle('cursor-pointer', Boolean(found && found.group.userData['draggable'] === 'pot'));

      for (const p of [...stage.parts.values()]) {
        stepPart(p, t);
        if (p.mode === 'exit' && t - p.startMs >= TIMING.exit.ms) {
          dropPart(p);
          stage.parts.delete(p.ref);
        }
      }
      for (const wire of stage.wires) {
        const k = tweenProgress(wire.userData.wireStart as number, TIMING.wire.ms, t, speed);
        wire.geometry.setDrawRange(0, Math.floor((wire.userData.wireCount as number) * k));
      }

      if (snapStart) {
        const k = tweenProgress(snapStart, TIMING.camera.ms, t, speed);
        azimuth = snapFromAz + (targetAz - snapFromAz) * TIMING.camera.curve(k);
        elevation = snapFromEl + (targetEl - snapFromEl) * TIMING.camera.curve(k);
        if (k >= 1) snapStart = 0;
      } else if (!dragging && !knobDrag && t - idleSince > TIMING.idleAutoRotateMs) {
        azimuth += 0.0016;
        targetAz = azimuth;
      }
      applyCamera();

      const halo = haloRef.current;
      const sel = selectedRefProp.current ? stage.parts.get(selectedRefProp.current) : undefined;
      if (sel && halo) {
        const v = sel.to.clone();
        v.y = 0.4;
        v.project(camera);
        // A selected part the user has turned off-frame must not leave a ring
        // parked in the corner — the projection is only a screen position while
        // it is inside the clip volume.
        if (Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z < 1) {
          halo.style.transform = `translate(${((v.x + 1) / 2) * size.w}px, ${((1 - v.y) / 2) * size.h}px) translate(-50%, -50%)`;
          halo.style.opacity = '1';
        } else {
          halo.style.opacity = '0';
        }
      } else if (halo) {
        halo.style.opacity = '0';
      }
      const readout = readoutRef.current;
      if (readout && hovered) {
        const v = hovered.group.position.clone();
        v.project(camera);
        readout.style.transform = `translate(${((v.x + 1) / 2) * size.w}px, ${((1 - v.y) / 2) * size.h}px) translate(-50%, -140%)`;
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const ro = new ResizeObserver(() => {
      size.w = host.clientWidth || 320;
      size.h = Math.max(200, host.clientHeight || 240);
      renderer.setSize(size.w, size.h);
      applyCamera();
    });
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('click', onClick);
      scene.traverse((o) => {
        if (o instanceof Mesh) disposeDeep(o as AnyMesh);
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      stageRef.current = null;
    };
  }, []);

  /* ── graph: diff the deck into the scene that already exists ─────────── */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const components = graph?.components ?? [];
    setEmpty(components.length === 0);
    if (components.length === 0) return;
    const palette = readPalette();
    const now = performance.now();

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of components) {
      for (const p of c.pins ?? []) {
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]);
        maxY = Math.max(maxY, p[1]);
      }
    }
    if (!Number.isFinite(minX)) return;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const width = Math.max(4, (maxX - minX) * WORLD_PER_UNIT + 2);
    const depth = Math.max(4, (maxY - minY) * WORLD_PER_UNIT + 2);
    if (!stage.scene.getObjectByName('slab')) {
      const slab = buildSlab(width, depth, palette);
      slab.name = 'slab';
      stage.scene.add(slab);
    }
    stage.setFit?.(Math.max(width, depth) / 2 + 1.5);

    const wanted = new Set<string>();
    let order = 0;
    for (const c of components) {
      wanted.add(c.ref);
      const input: PartInput = {
        ref: c.ref,
        kind: c.kind,
        value: c.value,
        nodes: c.nodes,
        pins: (c.pins ?? []).map((p) => [p[0] - cx, p[1] - cy] as [number, number]),
      };
      const existing = stage.parts.get(c.ref);
      if (existing && existing.mode !== 'exit') {
        const to = existing.group.position.clone();
        // buildPart centres its children on the pin centroid and places the
        // group there, so a re-layout is re-derived rather than guessed at.
        const rebuilt = buildPart(input, palette);
        to.copy(rebuilt.position);
        rebuilt.position.set(0, 0, 0);
        if (!existing.group.position.equals(to)) {
          existing.from.copy(existing.group.position);
          existing.to.copy(to);
          existing.mode = 'move';
          existing.startMs = now;
        }
        rebuilt.traverse((o) => {
          if (o instanceof Mesh) disposeDeep(o as AnyMesh);
        });
        continue;
      }
      const group = buildPart(input, palette);
      const to = group.position.clone();
      group.traverse((o) => {
        if (o instanceof Mesh) o.castShadow = true;
      });
      stage.scene.add(group);
      stage.parts.set(c.ref, {
        group,
        ref: c.ref,
        mode: 'enter',
        startMs: now + order * TIMING.enterStagger,
        from: new Vector3(to.x, to.y + LIFT.enter, to.z),
        to,
        hoverFrom: 0,
        hoverTo: 0,
        hoverStart: now,
      });
      order += 1;
    }
    for (const [ref, part] of stage.parts) {
      if (!wanted.has(ref) && part.mode !== 'exit') {
        part.mode = 'exit';
        part.startMs = now;
        part.hoverFrom = 0;
        part.hoverTo = 0;
        part.hoverStart = now;
      }
    }

    // Wires are rebuilt wholesale: a route is a property of the net, not of a
    // part, and a net's ends move together. Each tube then draws itself in.
    for (const mesh of stage.wires) {
      mesh.parent?.remove(mesh);
      disposeDeep(mesh);
    }
    stage.wires = [];
    for (const wire of graph?.wires ?? []) {
      const pts = (wire.points ?? [])
        .map((p) => new Vector3((p[0] - cx) * WORLD_PER_UNIT, 0.06, (p[1] - cy) * WORLD_PER_UNIT));
      if (pts.length < 2) continue;
      const curve = new CatmullRomCurve3(pts, false, 'catmullrom', 0.0);
      const geo = new TubeGeometry(curve, Math.max(8, pts.length * 8), 0.055, 6, false);
      const mesh = new Mesh(geo, new MeshStandardMaterial({
        color: palette['--cb3d-lead'],
        roughness: 0.35,
        metalness: 0.55,
      }));
      const index = geo.index;
      mesh.userData['wireStart'] = now;
      mesh.userData['wireCount'] = index ? index.count : 0;
      geo.setDrawRange(0, 0);
      stage.scene.add(mesh);
      stage.wires.push(mesh);
    }
    stage.applyPot?.();
  }, [graph]);

  if (failed) {
    return (
      <p className="px-1 py-2 text-2xs text-muted-foreground" data-testid="circuit-3d-unavailable">
        This machine could not open a 3D canvas, so the board is shown as the schematic drawing only.
      </p>
    );
  }
  if (empty) return <></>;

  return (
    <div className={className} data-testid="circuit-3d-stage">
      <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-2xs font-medium text-muted-foreground">3D board</span>
          <span
            className="truncate font-mono text-2xs text-muted-foreground"
            data-testid="circuit-3d-pot"
            title="Knob reading → PWM count. The view explores the value; the netlist keeps its own numbers."
          >
            {knobReadout}
          </span>
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground/70">
          drag the knob · drag to turn · scroll to zoom
        </span>
      </div>
      <div
        ref={hostRef}
        className="relative h-64 w-full cursor-grab touch-none overflow-hidden rounded-lg border border-border/50 bg-card/40"
        aria-label="Three-dimensional view of the circuit"
      >
        <div
          ref={haloRef}
          className="cb3d-halo pointer-events-none absolute left-0 top-0 size-16 rounded-full opacity-0"
          data-testid="circuit-3d-halo"
        >
          <div className="size-full rounded-full border-2 border-[var(--cb3d-select)]" />
        </div>
        <div
          ref={readoutRef}
          className="cb3d-line-flash pointer-events-none absolute left-0 top-0 rounded-md border border-border/60 bg-card/90 px-2 py-1 font-mono text-2xs text-foreground"
          data-testid="circuit-3d-readout"
        >
          {label}
        </div>
      </div>
    </div>
  );
}

/** The lift a part is currently carrying, so a hover retarget starts from
 *  where the mesh actually is rather than from zero. */
function currentLift(p: PartState, now: number): number {
  const k = tweenProgress(p.hoverStart, TIMING.hover.ms, now);
  return p.hoverFrom + (p.hoverTo - p.hoverFrom) * TIMING.hover.curve(k);
}

/** Advance one part's enter / move / exit tween. */
function stepPart(p: PartState, now: number): void {
  if (p.mode === 'enter') {
    const k = tweenProgress(p.startMs, TIMING.enter.ms, now);
    if (k < 1) {
      p.group.position.set(
        p.to.x,
        p.to.y + LIFT.enter * (1 - TIMING.enter.curve(k)),
        p.to.z,
      );
      p.group.scale.setScalar(Math.max(0.001, TIMING.enter.scaleCurve(Math.min(1, k * 1.15))));
      return;
    }
    p.group.position.copy(p.to);
    p.group.scale.setScalar(1);
    p.mode = 'move';
    p.from.copy(p.to);
  } else if (p.mode === 'move') {
    const k = tweenProgress(p.startMs, TIMING.move.ms, now);
    if (k >= 1) return;
    const c = TIMING.move.curve(k);
    p.group.position.set(
      p.from.x + (p.to.x - p.from.x) * c,
      p.from.y + (p.to.y - p.from.y) * c + Math.sin(Math.PI * k) * LIFT.moveArc,
      p.from.z + (p.to.z - p.from.z) * c,
    );
  } else {
    const k = tweenProgress(p.startMs, TIMING.exit.ms, now);
    const s = Math.max(0.001, 1 - TIMING.exit.curve(k));
    p.group.scale.setScalar(s);
    p.group.position.y = p.to.y - LIFT.moveArc * k * k;
  }
  const lift = currentLift(p, now);
  if (p.mode !== 'exit') p.group.position.y = Math.max(p.group.position.y, p.to.y + lift);
}

function disposeDeep(o: AnyMesh): void {
  o.geometry.dispose();
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  for (const mat of mats) {
    if (mat instanceof MeshStandardMaterial) mat.map?.dispose();
    mat.dispose();
  }
}
