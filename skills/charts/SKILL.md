---
name: charts
description: Render chart PNGs from data with render_chart.
category: artifacts
---

# Rendering charts

Use the `render_chart` tool — matplotlib (Agg) writes a PNG into the
workspace; the chat surfaces it as a file card.

## What this skill is

A short reference for the `render_chart` tool: how to call it, which
`kind` to pick, and the small set of rules that make a chart readable
(line vs bar vs pie vs scatter vs hist).

## When to Use

- The user asks for a chart, a plot, a trend line, or "visualize this."
- You have numeric series that have a *shape* worth seeing — never use a
  chart for a single scalar.
- You need to render waveform data coming out of a circuit sim or a log
  read via `read_file`.

## Prerequisites

- matplotlib available in the workbench Python env (bundled by default).
- Numeric data in lists — not strings, not timestamps-as-strings. Convert
  before plotting.

## How to Run

1. `load_skill "charts"` so the shape contract for each `kind` is fresh.
2. Build a `render_chart` call with `path`, `kind`, `series`, and `title`.
3. For waveforms, read the numeric columns (e.g. from a `wrdata` file) and
   pass them straight in as a series.
4. Mention the result as a file card; the chat surfaces the PNG inline.

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
  from `simulate_circuit` (or `wrdata` files read via `read_file`) —
  its `tracesFile` JSON is accepted by `render_chart` directly, and the
  right Circuit panel's scope/bode instruments render the same data
  interactively. Digital timing diagrams belong to
  `hdl_timing_diagram` (WaveDrom), not a line chart.

## Pitfalls

- Mixing string values into a `series` list. matplotlib silently renders
  nothing — convert first, then plot.
- Picking `pie` for more than one series. It accepts exactly one series
  and a `labels` list of equal length.
- Re-rendering the same chart many times. One chart per call; combine
  series when comparing them, not via repeated `render_chart` calls.

## Verification

- The PNG should be readable at a glance: title, axis labels, units, and
  a visible shape. If a "chart" came back blank, the data is the problem
  (string in a series list, empty input, mismatched lengths) — re-check
  the inputs before retrying.
