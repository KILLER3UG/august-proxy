---
name: video-render
description: Assemble MP4 videos from frames with render_video.
category: artifacts
---

# Rendering videos

Use the `render_video` tool — imageio plus a bundled static ffmpeg
encode an MP4 in the workspace; the chat shows a file card. No network
or system ffmpeg required.

## Workflow

1. Generate frames as image files in the workspace. Options:
   - `render_chart` per frame (animated data)
   - `draw_circuit` per frame (circuit build-ups)
   - a ```python block via code mode / `run_command` drawing frames
     with matplotlib or Pillow in a loop (`frame_000.png`, …)
2. Call `render_video` with the ordered frame paths:

```json
{"path": "demo.mp4", "frames": ["frame_000.png", "frame_001.png"], "fps": 12, "holdLastMs": 800}
```

3. Keep frames the same size (the tool resizes to the first frame,
   even dimensions). 10-15 fps is fine for explainers; 24-30 for
   smooth motion.

## Rules of thumb

- 8-20 seconds is the sweet spot; long renders waste the turn.
- Hold the last frame (`holdLastMs`) so the video doesn't cut abruptly.
- Generative text-to-video (Veo/Seedance style) is not available
  offline — see docs/CIRCUIT_SIMULATION_RESEARCH.md for the planned
  provider adapter.
