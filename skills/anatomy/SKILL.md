---
name: anatomy
description: Build crafted, detailed interactive isometric SVG figures that explain a technical idea as a real physical object — small precise parts, four-tone shading, painter's order, framed card with live readout, calm motion. Use for an isometric illustration, an explanatory figure for docs, a "Linear-style" drawing, an interactive explainer, or an SVG showing how a system works. Framework-free (Node to HTML) and React; optional WebGL. Not for a quick box-and-arrow diagram — use charts.
category: artifacts
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [isometric, svg, figure, explainer, illustration, animation, technical-drawing]
    related_skills: [charts]
---

# Anatomy — the object is the explanation

This skill makes figures like a small instrument on a bench: a heavy base on feet,
rails with tick rulers, a carriage on bushings, knurled knobs, coil springs, a dial
gauge whose needle moves, screws as tiny dots. The reader understands the idea
because they recognise the machine. Every number the figure shows comes from the
same model that moves its parts.

Two complete framework-free examples ship in `references/` and the core kit in
`kit/`. Open the closest one before you start — each is built with
`node references/<name>/build.mjs`, which writes a standalone HTML page next to
the script (add `--light` for the light theme).

- `references/dial-indicator/` is the smallest: a dial gauge on a stand, about
  300 lines in all. Start here.
- `references/desk-computer/` is framework-free SVG: a desk computer with a
  keyboard you can type on. The typed line appears on a CRT screen drawn in the
  plane of the case front, and the picture collapses to a line and a dot when
  you switch it off. About 85 solids and 850 paths.

The upstream project carries six more examples and the full kit. The
`test-rig` (React/Next) is the quality bar for the drawing itself; the
`raptor-engine` is the bar for shader work — see `## Source` below.

## The one idea that matters

**The object is the explanation.** Don't draw boxes, arrows and labels. Invent a
real, well-made physical thing whose working *is* the concept. Say in one
sentence what moves and what that motion means. Earlier figures mapped:

| Concept | Object |
|---|---|
| One shared GPU context serving many canvases | A gantry plotter: one print head visiting 16 wells |
| A cache key that skips work when nothing changed | A pin-tumbler lock: when every pin matches, the plug turns and nothing is redrawn |

Never copy a reference image: take its finish, not its object.

## When to Use

Use this skill whenever someone wants:

- an isometric illustration or "premium" technical drawing, even if they never
  say the word "isometric";
- an explanatory figure or interactive explainer for docs, a blog post, a
  landing page or an article — a figure whose parts move to show how a system,
  algorithm or component works;
- a figure that behaves like a real instrument (a readout that tracks a model,
  controls that respond to pointer and keyboard);
- static SVG output that embeds its own styles (`figureSvg({ standalone })`).

## When NOT to Use

- A quick box-and-arrow diagram or a data chart — use the `charts` skill.
- A photograph-like render or an artistic scene with no mechanism to explain.
- A bare logo or icon set — that is drawing, not figure-making.

## Prerequisites

- Node (any recent version) for the framework-free path: `node build.mjs`.
- A browser to open the built page and to run the verification captures.
- The files that ship with this skill: `kit/iso-kit.mjs` (the core: camera,
  solids, parts library, SVG string renderer, card and page builders, the CSS)
  and `scripts/inline-kit.mjs` (`kitScript()` returns the kit as source to
  inline into a standalone page).
- For the React/Next path and for Hero/Epic work with WebGL, pipes or round
  parts, take the full kit from the upstream repo (`## Source`).

## How to Run

1. `load_skill('anatomy')` and read this file.
2. Open the closest shipped example in `references/` and read its build script
   end to end before writing any geometry.
3. Follow the Procedure below in order — the concept and the parts list come
   before any geometry, because most of the quality is decided there.
4. Build the page, then verify like a critic (step 10). Iterate until the
   checklist passes.

## Procedure

Work in this order. Write the concept and the parts list before any geometry.

1. **Size it before you start.** Tell the user which size the request is and
   roughly how long it will take, before any other work.
   - **Figure**: one mechanism, 40–80 parts, SVG with at most one WebGL layer.
     About 30–90 minutes. Build it without asking.
   - **Hero**: a dense object, several WebGL layers or one 3D subject,
     80–150 parts. About 2–4 hours. Say so, then build it unless the user
     asked for something quick.
   - **Epic**: a whole vehicle, building or plant with many moving systems, or
     the 3D mode on more than one subject. 6 hours or more. Do not start it.
     Give the estimate, propose a Hero version that keeps the core of the idea,
     and list what the full version would add. Build the Epic only when the
     user chooses it.
   - Whatever the size, have a working page that opens in the browser within
     the first hour, and deepen it from there. Run `date` at the start and at
     each step; when a step runs past twice its share of the estimate, tell the
     user where it stands and what is left.
2. **Truth first.** Collect the real numbers and behaviour of the thing being
   explained: sizes, counts, thresholds, curves. The readout, motion and
   caption must all be true. If you can, write the model as a small pure
   module — `rig.ts` in the upstream `test-rig` example is the pattern — and
   drive everything from it.
3. **Invent the object.** Pick a machine, tool, instrument or piece of
   furniture whose mechanism maps one-to-one onto the concept. Say in one
   sentence what moves and what that motion means. Never copy a reference
   image: take its finish, not its object.
4. **Parts list.** Write at least 40 parts (40–80 for a Figure, 80–150 for a
   Hero, more for an Epic), grouped: base (plate, feet, groove, corner screws,
   label plate, ruler strip), structure (posts, rails, frame bars, end stops),
   mechanism (carriage, bushings, springs, plunger, needle), controls
   (knurled knob, thumb screw, crown) and the subject itself, which is the one
   lit part. Each part sits on another part. `references/craft.md` has a
   vocabulary of parts with recipes.
5. **Plan the world.** Use world units of about 1 px of the real thing: x and y
   on the floor, z up. Lay out plans as rounded rectangles
   `{x, y, w, d, r}` and circles. Choose the camera: azimuth 45° by default,
   35–60° to show the long side, elevation 30° (higher, like the ripple tank's
   44°, to look into something open). Then fit with
   `fitProjection(points, width, height, { pad, azimuth })`.
6. **Build geometry once.** Precompute every static path in a geometry module
   with the kit: `slabOf`, `cylinder`, `extrude`, `planOutline`, `topTicks`,
   `knurl`, `coil`, `radialTicks` and so on. Round parts on any axis (bells,
   flanges, valves, actuators) come from the upstream `kit/lathe.mjs`, and
   pipes and cables from `kit/tube.mjs`. Moving parts are built once at a rest
   position and moved with `translateAlong`; only parts whose shape changes are
   rebuilt per frame.
7. **Paint back to front, bottom to top.** Sort repeated parts with `depthOf`.
   Split anything that wraps another part into a back half and a front half:
   the springs around a rod, the bars of a frame around a carriage. A moving
   part is drawn in the slot where it physically sits. See "Painter's order" in
   `references/craft.md`. Once a figure has pipes, cables or round parts, stop
   tuning keys by eye: record each item's shape as you put it into
   `A.recorder(P, { order, spring })`, let `A.settle(R, P)` measure true depth
   wherever two items overlap and set the keys, and end the build with
   `A.auditOrExit(R, P)` (the audit module ships upstream at `kit/audit.mjs`).
   Route pipes before you draw them: real ports at both ends, legs along the
   structure, crossings on straights, collars gapping the pipe
   (`references/craft.md`, section 8). Record the true shape of what you draw:
   a stand-in shape that silences the audit is a bug, and the audit fails one.
8. **Frame it.** Put the figure in a card: `Fig n` at top left, a short title at
   top right, the interaction hint at bottom left and the live readout at
   bottom right. Legend keys and a true caption go under the card, and words
   stay out of the drawing apart from at most one tiny engraved label.
9. **Make it live.** Use calm time-based motion: exponential follow or real
   springs. An idle tour loops when nobody touches it. The figure responds to
   pointer and keyboard, stops when offscreen, and goes still under reduced
   motion. Write attributes on refs and don't re-render per frame.
10. **Verify like a critic.** The owner finds faults by zooming in, so you zoom
    in first. Read every PNG you make.
    - Capture desktop, phone (390 wide), hover and several moments of motion;
      use scripted sequences for the apart pose and the `--no-webgl` fallback.
    - **Run the audit to zero.** With pipes, cables or round parts,
      `node build.mjs --audit` must end `audit passed`, every failing line at 0:
      clearance at rest, apart and in mid-flight, terminals, loose ends, folds,
      self-overlap, crowding (against slender solids too), stand-in shapes,
      support, wobble, saddles and depth order. Fix an interlock in the
      geometry, never with a key bias.
    - **Run the line check to zero.** The audit never sees line markup. Every
      seam, rule, rib, tick and pointer must end on a stroke, a dot or an
      outline — ringed failures print `line ends: 0` only when clean.
    - **4× close-ups of every junction in both themes** (build `--light` too),
      assembled and apart: every flange, tee, elbow, clamp, valve, bellows,
      band, saddle, ball joint and crossing, every curved body (no tone
      staircase), every place a texture ends (on an edge or fading), flat box
      faces with their seams, and every sliding rod at rest and at full stroke.
    - Put your PNG next to the examples and ask: is it instantly a real object,
      rich in small parts with volume, with every line ending on something? Is
      it highly detailed at 1× and still rewarding at 4×, with no bare face or
      empty corner? Iterate until yes. Checklist: `references/verify.md`.

## Output format

A standalone `.html` page (or `.svg` for a lone figure) in the workspace,
built by a Node script that imports the kit. The result previews live in the
right drawer — the artifact route serves it from the backend's own origin under
a document-scoped CSP, so its inline script runs. Deliver the page, the build
script, and the verification captures beside them.

## Pitfalls

- **Starting with geometry.** Writing paths before the concept and the parts
  list are written down produces a diagram, not an object. The list comes
  first; 40 parts is the floor, not the target.
- **A copied reference image.** Take the finish, not the object — a figure that
  looks like something else's photo reads as decoration.
- **Eyeballed painter's keys.** With pipes or round parts, key bias is how a
  spring ends up drawn through a rod. Record shapes and let the audit settle
  the depth.
- **A stand-in shape.** A simplified body that silences the audit is a bug;
  the audit's coverage check exists to fail exactly that.
- **Words inside the drawing.** More than one tiny engraved label turns a
  figure into a slide.
- **Per-frame re-renders.** Write attributes on refs; a React re-render per
  frame drops the motion's calm.

## Verification

- The page opens in a browser and the figure reads as a real object at 1× and
  at 4× zoom, with every line ending on a stroke, a dot or an outline.
- The readout, the motion and the caption agree with the model module — the
  same numbers that move the parts label the figure.
- `node build.mjs --audit` ends `audit passed` (zero on every check) for any
  figure with pipes, cables or round parts.
- The line check prints `line ends: 0` in both themes.
- Close-ups at 4× of every junction, in both themes, assembled and apart, show
  no bare face, no tone staircase and no texture ending mid-air.

## Reference files

| File | Open it when |
|---|---|
| `references/dial-indicator/build.mjs` | You are starting a Figure — the smallest complete build, start-to-finish. |
| `references/desk-computer/build.mjs` | You need a dense example (~85 solids) with a live CRT and keyboard interaction. |
| `references/craft.md` | Step 4 (parts vocabulary and recipes) and step 7 (painter's order, pipe routing). |
| `references/verify.md` | Step 10 — the critic's checklist and capture procedure. |
| `kit/iso-kit.mjs` | You need a helper's exact signature (`slabOf`, `depthOf`, `translateAlong`, `figureSvg`, `pageHtml`, …). |
| `scripts/inline-kit.mjs` | You are writing a build script — `kitScript()` is how the kit reaches a standalone page. |

## Source

Ported from [wheresryan22/anatomy](https://github.com/wheresryan22/anatomy),
tag `v1.0.0` (MIT). The MIT license text ships in `LICENSE` beside this file.
This port carries the skill, the core kit (`kit/iso-kit.mjs`,
`scripts/inline-kit.mjs`), the two smallest framework-free examples and the
`craft.md` / `verify.md` references. The upstream repo additionally carries
six more examples (including `raptor-engine` and `test-rig`), the React path
(`kit/react/`), and the modules for round parts, pipes, the geometry audit,
WebGL layers and the 3D mode (`kit/lathe.mjs`, `kit/tube.mjs`,
`kit/audit.mjs`, `kit/gl.mjs`, `kit/turn*.mjs`) — pull those from the tag when
a Figure grows into a Hero.
