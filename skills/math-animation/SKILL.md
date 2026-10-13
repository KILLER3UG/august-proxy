---
name: math-animation
description: Render math and 3D animation videos with manimgx (Manim CE's Python API on a Rust GPU core). Use when the user wants an animated math explainer, a 3D scene video, or an MP4 of equations and steps moving — write scene.py with the typed API (2D and 3D, LaTeX or Typst text), render through the workspace kernel venv, inspect the storyboard, fix, re-render, and verify the final frames. Not for static charts (charts), HTML figures (anatomy), or slide decks.
category: artifacts
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [animation, math, 3d, video, mp4, manim, manimgx, explainer]
    related_skills: [anatomy, charts]
---

# Math animation — a scene file to a finished MP4

manimgx is a 3D animation engine with **Manim CE's Python API** on a Rust/wgpu
GPU core: the agent writes ordinary scene code, and the render is seconds, not
minutes. The MP4 lands in the workspace and the existing file card, drawer and
artifacts gallery handle it like any other deliverable.

A minimal scene, complete:

```python
import manimgx as m

class Hello3D(m.ThreeDScene):
    def construct(self) -> None:
        self.set_camera_orientation(phi=65 * m.DEGREES, theta=-45 * m.DEGREES)
        self.begin_ambient_camera_rotation(rate=0.5)
        cube = m.Cube(side_length=3, fill_opacity=0.3, stroke_width=2)
        self.play(m.Create(cube), run_time=2)
        self.wait(4)
```

Rendered with `manimgx render scene.py` from the workspace — out comes
`Hello3D.mp4` at 1080p60. Text and math are LaTeX or Typst with **no LaTeX
installation**; speech can be synced with `self.say()`.

## When to Use

- The user wants an animated explainer of a mathematical idea, an algorithm or
  a physical system — something that MOVES.
- A 3D subject: rotating geometry, a camera orbiting a construction, a diagram
  that builds itself piece by piece.
- An MP4 for a talk, a README, a lesson or a landing page, where the motion is
  the explanation.
- "Make a Manim-style video" — the API is the one the user already knows.

## When NOT to Use

- A static chart → the `charts` skill (a chart that never changes is not an
  animation).
- A HTML/SVG figure for an article → the `anatomy` skill.
- A deck of slides → `create_pptx`.
- A screen recording of the real app — that is desktop capture, not a render.

## Prerequisites

- **The workspace kernel venv, provisioned from Settings.** The desktop payload
  ships Python 3.12.9 and `uv` is not in it, while manimgx requires
  **>= 3.13** (its `win_amd64` wheel is `cp313` abi3, so 3.14 works too). The
  Settings action creates `<workspace>/.aug/kernel/venv` from a >=3.13
  interpreter found on the machine and pip-installs the seed set — with
  manimgx added when this skill is in play. The network that pip needs belongs
  to THAT action's consent (logged as a grant), and is a different thing from
  the per-session `sandboxNetwork` flag.
- manimgx is **per-user by design**: it bundles a mixed MIT / GPL / LGPL license
  expression, which is exactly why the packaging guard refuses wheels, `venv/`
  and `site-packages/` in a release payload. Never vendor it into the repo —
  install it into the user's kernel venv and leave it there.
- Know the venv paths: `<workspace>/.aug/kernel/venv/Scripts/python.exe` on
  Windows, `<workspace>/.aug/kernel/venv/bin/python` elsewhere; the `manimgx`
  console script sits in the same directory.

## How to Run

1. Confirm the venv exists (the Settings action ran). If not, say so and stop —
   do not try to render with the backend's own interpreter, which is 3.12 and
   cannot import manimgx.
2. Write `scene.py` in the workspace (Manim CE API — see the Procedure).
3. Render through the venv's interpreter or console script, as a PATH (see
   Pitfalls for why the bare command is refused).
4. Run the storyboard inspection, read it, fix, re-render.
5. Verify the final MP4's frames, then present it.

## Procedure

1. **Write the scene as a small typed module.** One `Scene` subclass per idea,
   a `construct()` that says what appears, what moves, and in what order. Keep
   the mathematical content in the scene code itself — positions, rates and
   labels come from the numbers being explained, not from eye-measured pixels.
2. **Run it through the venv, by path.** From the workspace:
   `<workspace>/.aug/kernel/venv/Scripts/python.exe scene.py` (or `bin/python`
   on mac/linux), or the venv's `manimgx` console script directly:
   `<workspace>/.aug/kernel/venv/Scripts/manimgx render scene.py`. Running as a
   path is required, not stylistic — see Pitfalls.
3. **Inspect the storyboard before believing the render.** `manimgx inspect`
   produces storyboards and 2D layout checks, at play endings or at times you
   choose. Read every panel: is the text where it should be, does the
   construction overlap itself, does the camera show the subject? A render you
   did not look at is not finished.
4. **Fix the scene, not the output.** Overlaps, collisions and clipped labels
   are scene bugs — change positions, buffers, rates — never post-process the
   video.
5. **Re-render and re-inspect** until the storyboard reads clean.
6. **Verify the final MP4.** Extract frames with the media analysis path
   (`analyze_media` on the MP4): confirm the duration matches the scene's
   `run_time` + `wait` budget, the text is legible at 1080p, and the motion
   starts and ends where the scene says it does.
7. **Present the MP4** with the scene file beside it — the file card and the
   artifacts gallery already know how to show both.

## Output format

- `<name>.py` — the scene, in the workspace, importable and re-runnable.
- `<SceneName>.mp4` — the render, 1080p60 by default, in the workspace.
- The storyboard images, kept while iterating and discardable after.

## Pitfalls

- **Bare `python` / `python3`.** That is the backend's interpreter (3.12 on the
  desktop payload) — manimgx cannot import there, and the failure looks like a
  missing package rather than a wrong interpreter. Always run by the venv's
  path.
- **A relative venv path.** The command's first word must be the program path;
  `run_command` admits a path only when it is inside this workspace's
  provisioned venv. A path elsewhere — or a venv on a different workspace — is
  refused by design.
- **Trusting the first render.** A plausible MP4 with overlapping text is the
  normal first output. The storyboard loop is the job, not an optional extra.
- **Pasting unicode math.** Write `x^2` as LaTeX or Typst and let the engine
  typeset it — hand-placed unicode breaks the moment the expression grows.
- **Installing packages into the venv from the model side.** The venv is
  provisioned from Settings on purpose (that is where the network grant lives);
  if a scene needs a package, ask the user to add it there.
- **Editing the MP4.** Crop, trim or concatenate outside the engine and the
  re-render no longer reproduces it. Change the scene.

## Verification

- `manimgx inspect` panels read clean at every play ending: no overlap, no
  clipped text, the subject in frame.
- `analyze_media` frame extraction on the MP4 shows: the first frame matches
  the scene's opening, the last frame its ending, and the runtime matches the
  scene's own timing budget.
- The scene file re-runs from the venv interpreter and reproduces the MP4.
- The deliverable shown to the user is the MP4, with the scene beside it.

## Source

Rendered with [manimgx](https://pypi.org/project/manimgx/) 0.1.1 (Academa,
Manim-CE-compatible API, Rust/wgpu core, requires Python >= 3.13; the
`win_amd64` wheel is `cp313` abi3). Documentation, gallery and API reference at
manimgx.academa.ai. manimgx itself is NOT bundled with this skill — it is
installed per-user into the workspace kernel venv by the Settings provisioning
action, which is also the licensing story (mixed MIT/GPL/LGPL expression:
per-user install only, never staged into a release).
