/* ── CircuitBreadboard3D ─ the live 3D view of the deck being edited ──────
 *
 * The schematic editor draws the wiring; this shows the same netlist as
 * objects you can turn. It is driven entirely by the graph the backend already
 * returns for the active deck — kind, ref, value, nodes and each pin's
 * coordinates — so a part the model just wrote into the .cir appears here
 * without any asset, model file or second data source existing. That is the
 * point: the netlist stays the source of truth, exactly as it is for the
 * schematic and the simulation.
 *
 * The camera is ORTHOGRAPHIC and the outline is a back-face hull, both
 * measured off a reference board stage and kept here because they are what
 * make a procedural scene read as a drawing instead of a render. Motion lives
 * in lib/circuit-motion.ts, colour in styles/tokens.css, keyframes in
 * styles/motion.css.
 *
 * The overlay readout and the selection halo are positioned by writing
 * transform on the element from the render loop. That is deliberate: the
 * values are per-frame scene projections, not styling, and an inline style
 * object would re-render the React tree sixty times a second.
 */

import { useEffect, useRef, useState } from 'react';
import {
  AmbientLight,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFShadowMap,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
} from 'three';
import type { Group } from 'three';
import { buildPart, buildSlab, readPalette, WORLD_PER_UNIT, type PartInput } from '@/lib/circuit-3d-parts';
import { LIFT, TIMING, TWEEN_SPEED_REDUCED, prefersReducedMotion, tweenProgress } from '@/lib/circuit-motion';
import type { SchematicGraph } from '@/api/circuit';

interface Props {
  graph: SchematicGraph | null;
  selectedRef?: string;
  onSelect?: (ref: string) => void;
  className?: string;
}

interface PartState {
  group: Group;
  ref: string;
  enterFrom: number;
  enterTo: number;
  baseY: number;
  hover: number;
  hoverFrom: number;
  hoverTo: number;
}

const FRUSTUM_HALF = 6;

export function CircuitBreadboard3D({ graph, selectedRef, onSelect, className }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const readoutRef = useRef<HTMLDivElement | null>(null);
  const haloRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [label, setLabel] = useState('');
  // The knob's own readout, in the reference's `raw → pwm` form. It starts at
  // the divider's midpoint because that is where a real pot's wiper sits when
  // nothing has turned it.
  const [knobReadout, setKnobReadout] = useState('512 → 128');
  const selectedRefProp = useRef(selectedRef);
  selectedRefProp.current = selectedRef;

  useEffect(() => {
    const host = hostRef.current;
    const components = graph?.components ?? [];
    if (!host || components.length === 0) return;
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

    const palette = readPalette();
    const scene = new Scene();
    const size = { w: host.clientWidth || 320, h: Math.max(200, host.clientHeight || 240) };
    renderer.setSize(size.w, size.h);
    // The orthographic half-extent is fitted to the deck below, so a two-part
    // filter and a twenty-pin board both fill the frame instead of one
    // swallowing the other. Until the bounds are known, a neutral half works.
    let halfBase = FRUSTUM_HALF;
    const camera = new OrthographicCamera(-halfBase, halfBase, halfBase * (size.h / size.w), -halfBase * (size.h / size.w), 0.1, 900);

    scene.add(new HemisphereLight(0xfffaf3, 0xc2ae90, 0.5));
    scene.add(new AmbientLight(0xfff6ea, 1.2));
    const key = new DirectionalLight(0xffffff, 0.001);
    key.castShadow = true;
    key.position.set(6, 12, 7);
    scene.add(key);

    // Place everything from the graph, then centre the whole assembly on the
    // origin so the camera's orbit target never has to move.
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
    halfBase = Math.max(width, depth) / 2 + 1.5;
    scene.add(buildSlab(width, depth, palette));

    const parts: PartState[] = [];
    const now = performance.now();
    components.forEach((c, i) => {
      const input: PartInput = {
        ref: c.ref,
        kind: c.kind,
        value: c.value,
        nodes: c.nodes,
        pins: (c.pins ?? []).map((p) => [p[0] - cx, p[1] - cy] as [number, number]),
      };
      const group = buildPart(input, palette);
      group.position.y = 0;
      group.userData.enterStart = now + i * TIMING.enterStagger;
      group.traverse((o) => {
        if (o instanceof Mesh) o.castShadow = true;
      });
      scene.add(group);
      const scale0 = 0.001;
      group.scale.setScalar(scale0);
      parts.push({
        group,
        ref: c.ref,
        enterFrom: now + i * TIMING.enterStagger,
        enterTo: now + i * TIMING.enterStagger + TIMING.enter.ms,
        baseY: 0,
        hover: 0,
        hoverFrom: 0,
        hoverTo: 0,
      });
    });

    const ray = new Raycaster();
    const pointer = new Vector2();
    let hovered: PartState | null = null;
    let dragging = false;
    // The knob's own state. `pot` is the raw 0–1023 divider reading the
    // reference uses, and it lives HERE, not in React state: a drag fires
    // sixty times a second and re-rendering the tree for each one would cost
    // more than the draw does. It is mirrored onto the host's dataset so the
    // value is assertable and so a screen reader can reach it.
    let pot = 512;
    let knobDrag: PartState | null = null;
    let knobPivot = new Vector2();
    let knobLastAngle = 0;
    const knobs = parts.filter((p) => p.group.userData['draggable'] === 'pot');
    const leds: MeshStandardMaterial[] = [];
    scene.traverse((o) => {
      if (o instanceof Mesh && o.userData['led'] === true) {
        leds.push(o.material as MeshStandardMaterial);
      }
    });
    /** The reference's sweep and its resulting sensitivity: 270° over 1023
     *  counts is 217.1 counts per radian, ≈3.78 per degree. */
    const SWEEP_DEG = 270;
    const COUNTS_PER_RAD = 1023 / (SWEEP_DEG * (Math.PI / 180));
    const applyPot = (): void => {
      const pwm = Math.floor(pot / 4);
      for (const p of knobs) {
        const knob = p.group.userData['knob'] as Group | undefined;
        if (knob) knob.rotation.y = -((pot / 1023) * SWEEP_DEG - SWEEP_DEG / 2) * (Math.PI / 180);
      }
      // A divider reading drives the LED the way the sketch would: the PWM
      // count out of 255. Nothing here is written to the deck — the stage shows
      // what the value would do, and the simulation stays the deck's business.
      for (const mat of leds) mat.emissiveIntensity = pwm / 255;
      const hostEl = host as HTMLElement & { dataset: DOMStringMap };
      hostEl.dataset['pot'] = String(pot);
      hostEl.dataset['pwm'] = String(pwm);
      hostEl.dataset['led'] = (pwm / 255).toFixed(2);
      setKnobReadout(`${pot} → ${pwm}`);
    };
    const ownerOf = (obj: object | null): PartState | null => {
      let node = obj as Group | null;
      while (node && !node.userData['ref']) node = node.parent as Group | null;
      return parts.find((p) => p.group === node) ?? null;
    };
    const screenPivotOf = (p: PartState): Vector2 => {
      const v = p.group.position.clone();
      const knob = p.group.userData['knob'] as Group | undefined;
      v.y = knob ? 0.9 : 0.5;
      v.project(camera);
      const rect = host.getBoundingClientRect();
      return new Vector2(
        rect.left + ((v.x + 1) / 2) * rect.width,
        rect.top + ((1 - v.y) / 2) * rect.height,
      );
    };
    let lastX = 0;
    let lastY = 0;
    let azimuth = Math.PI / 5;
    let elevation = Math.PI / 4.2;
    let zoom = 8.4;
    let targetAz = azimuth;
    let targetEl = elevation;
    let snapStart = 0;
    let snapFromAz = azimuth;
    let snapFromEl = elevation;
    let idleSince = now;
    const speed = prefersReducedMotion() ? TWEEN_SPEED_REDUCED : 1;

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
    applyCamera();
    // Seat the knob at its starting reading and light the LED from it, so the
    // first frame already agrees with the readout instead of showing an
    // unlit LED and a "512 → 128" card.
    applyPot();

    const hitAt = (clientX: number, clientY: number): PartState | null => {
      const rect = host.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(pointer, camera);
      const hits = ray.intersectObjects(parts.map((p) => p.group), true);
      const obj = hits.find((h) => h.object.userData['hull'] !== true)?.object ?? null;
      return ownerOf(obj);
    };
    const onPointerDown = (e: PointerEvent): void => {
      idleSince = performance.now();
      const hit = hitAt(e.clientX, e.clientY);
      if (hit && hit.group.userData['draggable'] === 'pot') {
        // A knob owns the gesture. Without this branch, "turn the knob" and
        // "look around the board" would be the same drag and neither would work.
        knobDrag = hit;
        knobPivot = screenPivotOf(hit);
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
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
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
      // Ratchet to the nearest quarter turn, the reference's own behaviour: a
      // free camera looks arbitrary, a snapped one looks composed.
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
      if (!hovered || !onSelect) return;
      onSelect(hovered.ref);
    };
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('click', onClick);

    let raf = 0;
    const frame = (): void => {
      const t = performance.now();
      ray.setFromCamera(pointer, camera);
      const hits = ray.intersectObjects(parts.map((p) => p.group), true);
      const hitObj = hits.find((h) => h.object.userData['hull'] !== true)?.object ?? null;
      const found = ownerOf(hitObj);
      // A draggable part earns a different cursor: the stage is turnable
      // everywhere, and the only way to tell a knob from the board under it is
      // to say so before the press.
      host.classList.toggle('cursor-pointer', found?.group.userData['draggable'] === 'pot');
      if (found !== hovered) {
        if (hovered) {
          hovered.hoverFrom = hovered.hover;
          hovered.hoverTo = 0;
          hovered.hover = TIMING.hover.ms;
        }
        if (found) {
          found.hoverFrom = found.hover;
          found.hoverTo = LIFT.hover;
          found.hover = 0;
        }
        hovered = found;
        if (found) {
          const c = components.find((x) => x.ref === found.ref);
          const all = (found.group.userData['nodes'] as string[] | undefined) ?? [];
          // Shortened in the string, not with CSS `truncate`: a board's twenty
          // nets would otherwise set the card's width, and a card that wide
          // covers the very part it is describing.
          const nodes = all.length > 6 ? `${all.slice(0, 6).join(' / ')} +${all.length - 6}` : all.join(' / ');
          setLabel(`${found.ref}${c?.value ? ` · ${c.value}` : ''}${nodes ? ` · ${nodes}` : ''}`);
        } else {
          setLabel('');
        }
      }

      for (const p of parts) {
        const enter = tweenProgress(p.enterFrom, TIMING.enter.ms, t, speed);
        if (enter < 1) {
          p.group.position.y = LIFT.enter * (1 - TIMING.enter.curve(enter));
          p.group.scale.setScalar(Math.min(1, enter * 1.15) * TIMING.enter.scaleCurve(enter));
        } else if (p.group.scale.x < 1) {
          p.group.position.y = 0;
          p.group.scale.setScalar(1);
        }
        if (p.hover > 0 && p.hover < TIMING.hover.ms) {
          const k = tweenProgress(t - p.hover, TIMING.hover.ms, t, speed);
          p.hover = Math.min(TIMING.hover.ms, p.hover + 16);
          p.group.position.y = Math.max(
            p.group.position.y,
            p.hoverFrom + (p.hoverTo - p.hoverFrom) * TIMING.hover.curve(k),
          );
        } else if (p.hover >= TIMING.hover.ms) {
          p.group.position.y = p.hoverTo;
        }
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

      const sel = parts.find((p) => p.ref === selectedRefProp.current);
      const halo = haloRef.current;
      if (sel && halo) {
        const v = sel.group.position.clone();
        v.project(camera);
        // A selected part the user has turned off-frame must not leave a ring
        // parked in the corner of the stage — the projection is only a screen
        // position while it is inside the clip volume.
        const onScreen = Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z < 1;
        if (onScreen) {
          halo.style.transform = `translate(${((v.x + 1) / 2) * size.w}px, ${((1 - v.y) / 2) * size.h}px) translate(-50%, -50%)`;
          halo.style.opacity = '1';
        } else {
          halo.style.opacity = '0';
        }
      } else if (halo) {
        halo.style.opacity = '0';
      }
      if (readoutRef.current) {
        if (hovered) {
          const v = hovered.group.position.clone();
          v.project(camera);
          readoutRef.current.style.transform = `translate(${((v.x + 1) / 2) * size.w}px, ${((1 - v.y) / 2) * size.h}px) translate(-50%, -140%)`;
        }
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth || 320;
      const h = Math.max(200, host.clientHeight || 240);
      size.w = w;
      size.h = h;
      renderer.setSize(w, h);
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
        if (!(o instanceof Mesh)) return;
        const mesh = o as Mesh<BufferGeometry, Material | Material[]>;
        mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          if (mat instanceof MeshStandardMaterial) mat.map?.dispose();
          mat.dispose();
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [graph, onSelect]);

  if (failed) {
    return (
      <p className="px-1 py-2 text-2xs text-muted-foreground" data-testid="circuit-3d-unavailable">
        This machine could not open a 3D canvas, so the board is shown as the schematic drawing only.
      </p>
    );
  }
  if (!graph || graph.components.length === 0) return <></>;

  return (
    <div className={className} data-testid="circuit-3d-stage">
      <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-2xs font-medium text-muted-foreground">3D board</span>
          {knobReadout ? (
            <span
              className="truncate font-mono text-2xs text-muted-foreground"
              data-testid="circuit-3d-pot"
              title="Knob reading → PWM count. The view explores the value; the netlist keeps its own numbers."
            >
              {knobReadout}
            </span>
          ) : null}
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
