---
name: charts
description: Render chart PNGs from data with render_chart.
category: artifacts
---

# Rendering charts

Use the `render_chart` tool — matplotlib (Agg) writes a PNG into the
workspace; the chat surfaces it as a file card.

## Kinds

- `line` — series of numeric lists (one per line)
- `bar` — grouped bars; `labels` sets the x categories
- `pie` — exactly one series; `labels` must match its length
- `scatter` — exactly two series: x list then y list
- `hist` — each series becomes a histogram

```json
{"path": "trend.png", "kind": "line", "series": [[1, 3, 2, 5]], "title": "Latency", "xlabel": "run", "ylabel": "ms"}
```

## Rules of thumb

- Prefer PNG over ASCII tables whenever numbers have a shape.
- Label axes and units; keep one chart per call.
- For waveforms / simulation output, plot the numeric columns you got
  from `simulate_circuit` (or `wrdata` files read via `read_file`).
